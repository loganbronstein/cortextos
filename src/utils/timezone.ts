import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * True if `tz` is a valid IANA timezone name (e.g. "America/Chicago").
 * Intl.DateTimeFormat throws RangeError for an unknown zone, so a clean
 * construction is the validation.
 */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an org's configured timezone from its context.json
 * (`<frameworkRoot>/orgs/<org>/context.json`, `timezone` field).
 *
 * Returns the validated IANA zone, or null when the file/field is missing or
 * the value is not a valid zone. A leading BOM is stripped — context.json has
 * historically been BOM-infected (see src/utils/strip-bom.ts).
 */
export function resolveOrgTimezone(frameworkRoot: string, org: string): string | null {
  if (!frameworkRoot || !org) return null;
  const ctxPath = join(frameworkRoot, 'orgs', org, 'context.json');
  if (!existsSync(ctxPath)) return null;
  try {
    let raw = readFileSync(ctxPath, 'utf-8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM
    const ctx = JSON.parse(raw) as { timezone?: unknown };
    const tz = typeof ctx.timezone === 'string' ? ctx.timezone.trim() : '';
    return isValidTimezone(tz) ? tz : null;
  } catch {
    return null;
  }
}

/**
 * Authoritatively set the daemon's process timezone from the org's context.json
 * BEFORE the cron scheduler is constructed.
 *
 * Why this exists: cron-scheduler.ts interprets fixed-hour cron expressions in
 * PROCESS-LOCAL wall-clock time (`new Date().getHours()`), so the daemon's
 * effective TZ is what decides when "0 22 * * *" fires. PM2 inherits TZ from
 * whatever shell launches/restarts it, and `pm2 restart --update-env` from an
 * agent PTY can inject TZ=UTC — silently shifting every fixed-hour cron (the
 * 2026-06-11 regression). Setting process.env.TZ here, from the org's declared
 * zone, makes fixed-hour scheduling immune to the calling shell. Node re-reads
 * process.env.TZ for subsequent Date operations, so this takes effect for the
 * scheduler constructed afterwards.
 *
 * FAIL-CLOSED: returns the validated org timezone, or THROWS if it cannot be
 * resolved. The daemon calls this before constructing the scheduler, so a throw
 * aborts startup (PM2 surfaces the exit) rather than letting the daemon silently
 * schedule fixed-hour crons in an inherited/poisoned TZ. Do NOT reintroduce
 * warn-and-continue here — that is the exact silent wrong-schedule failure this
 * guard exists to prevent.
 */
export function applyDaemonTimezone(
  frameworkRoot: string,
  org: string,
  log: (msg: string) => void = console.log,
): string {
  const tz = resolveOrgTimezone(frameworkRoot, org);
  if (!tz) {
    // FAIL CLOSED. Warn-and-continue would leave the daemon scheduling fixed-hour
    // crons in whatever TZ it inherited (e.g. an --update-env-injected UTC) — the
    // exact silent wrong-schedule failure this guard exists to prevent. Generator
    // validation does not cover context.json corruption/removal after generation,
    // a wrong CTX_ORG, or a start without a regenerated ecosystem. Refuse to start;
    // PM2's restart/circuit-breaker surfaces it loudly, which beats silently firing
    // fleet jobs at the wrong hours.
    throw new Error(
      `[daemon] FATAL: cannot resolve a valid IANA timezone for org "${org}". ` +
        `Set a valid "timezone" (e.g. "America/Chicago") in ` +
        `${join(frameworkRoot, 'orgs', org, 'context.json')}. ` +
        `Refusing to start — fixed-hour crons would otherwise fire in the wrong timezone.`,
    );
  }
  process.env.TZ = tz;
  process.env.CTX_TIMEZONE = tz;
  log(`[daemon] Timezone resolved from org "${org}" context: ${tz} (fixed-hour cron scheduling uses this)`);
  return tz;
}

/**
 * Resolve which org an agent belongs to by scanning
 * `<frameworkRoot>/orgs/<org>/agents/<agent>`.
 *
 * Returns every org directory that contains the agent. Callers MUST treat
 * `length !== 1` as an error: 0 = unknown agent, >1 = ambiguous duplicate name
 * across orgs (never silently pick iteration order — the chosen org drives the
 * timezone used to display next-fire times).
 */
export function findAgentOrgs(frameworkRoot: string, agent: string): string[] {
  if (!frameworkRoot || !agent) return [];
  const orgsDir = join(frameworkRoot, 'orgs');
  if (!existsSync(orgsDir)) return [];
  const matches: string[] = [];
  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(orgsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const org of entries) {
    if (!org.isDirectory()) continue;
    if (existsSync(join(orgsDir, org.name, 'agents', agent))) matches.push(org.name);
  }
  return matches;
}
