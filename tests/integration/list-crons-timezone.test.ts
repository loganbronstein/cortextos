/**
 * tests/integration/list-crons-timezone.test.ts
 *
 * Drives the compiled `dist/cli.js bus list-crons` and proves the fixed-schedule
 * next-fire display is (a) independent of the CALLER's TZ and (b) resolved from
 * the TARGET agent's own org timezone — not the caller's CTX_ORG. Regression:
 * before the fix, list-crons recomputed next-fire in the caller process TZ and
 * "lied" (UTC shell showed 22:00Z for "0 22 * * *").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(__dirname, '..', '..');
const DIST_CLI = join(REPO_ROOT, 'dist', 'cli.js');

let fixture: string;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'list-crons-tz-'));
  // Target agent "foo" lives uniquely in org "orgB", whose timezone is Chicago.
  mkdirSync(join(fixture, 'orgs', 'orgB', 'agents', 'foo'), { recursive: true });
  writeFileSync(join(fixture, 'orgs', 'orgB', 'context.json'),
    JSON.stringify({ timezone: 'America/Chicago', orchestrator: 'boss' }), 'utf-8');
  // A different org "orgA" exists (the caller will claim it) but does NOT contain foo.
  mkdirSync(join(fixture, 'orgs', 'orgA', 'agents', 'someoneelse'), { recursive: true });
  writeFileSync(join(fixture, 'orgs', 'orgA', 'context.json'),
    JSON.stringify({ timezone: 'UTC', orchestrator: 'boss' }), 'utf-8');
  // foo's crons (agent-name-keyed under CTX_ROOT).
  const cronsDir = join(fixture, '.cortextOS', 'state', 'agents', 'foo');
  mkdirSync(cronsDir, { recursive: true });
  writeFileSync(join(cronsDir, 'crons.json'),
    JSON.stringify({ crons: [{ name: 'tztest', schedule: '0 22 * * *', enabled: true, prompt: 'p' }] }), 'utf-8');
});

afterEach(() => {
  try { rmSync(fixture, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function listCrons(callerTz: string): Promise<string> {
  // Scrub inherited CTX_* that would point at the LIVE install and trip
  // resolveEnv's sandbox-leak guard against our fixture frameworkRoot.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CTX_AGENT_DIR;
  env.TZ = callerTz;
  env.CTX_ROOT = fixture;
  env.CTX_FRAMEWORK_ROOT = fixture;
  env.CTX_PROJECT_ROOT = fixture;
  env.CTX_ORG = 'orgA'; // caller claims orgA; foo actually lives uniquely in orgB
  env.CTX_AGENT_NAME = 'foo';
  env.CTX_INSTANCE_ID = 'list-crons-tz-test';
  const { stdout } = await execFileAsync(process.execPath, [DIST_CLI, 'bus', 'list-crons', 'foo'], { env });
  return stdout;
}

function tztestRow(stdout: string): string {
  return (stdout.split('\n').find(l => l.includes('tztest')) ?? '').replace(/\s+/g, ' ').trim();
}

describe.skipIf(!existsSync(DIST_CLI))('bus list-crons — timezone evidence surface', () => {
  it('shows the SAME next-fire regardless of caller TZ, resolved from the target org (orgB=Chicago)', async () => {
    const underUtc = tztestRow(await listCrons('UTC'));
    const underChicago = tztestRow(await listCrons('America/Chicago'));

    // Caller-TZ-independent: a UTC shell and a Chicago shell must agree.
    expect(underUtc).toBe(underChicago);
    expect(underUtc).toContain('tztest');
    // tz-corrected: must NOT display the naive-UTC next-fire 22:00 (the bug).
    // (The schedule string "0 22 * * *" is present; the NEXT-FIRE clock value is not "22:00 UTC".)
    expect(underUtc).not.toContain('22:00 UTC');
    // 22:00 in America/Chicago resolves to 03:00Z (CDT) or 04:00Z (CST).
    expect(/0[34]:00 UTC/.test(underUtc)).toBe(true);
  });
});
