import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import type { WorkerProcess } from './worker-process.js';

/**
 * WorkerWatcher — periodic background poller that recovers stuck workers.
 *
 * Two failure modes detected:
 *
 * 1. Rate-limit exhaustion (Anthropic weekly Opus / 5-hour / daily limits).
 *    Worker idles at the REPL with the "You have hit your limit" or "You've
 *    used N% of your weekly limit · resets <time>" banner. Even after the
 *    reset, the worker does not auto-recover — it sits at the prompt
 *    waiting for input.
 *
 *    Fix: detect the banner via stdout-tail scan, parse the reset time,
 *    inject "continue from where you left off" once the reset has passed.
 *    Bounded retries (default 3); parent alert on exhaustion.
 *
 * 2. Code-done-needs-summary (per boss feedback 2026-04-22 19:11 UTC).
 *    Worker has committed code on a feature branch but never sent the
 *    parent the final summary bus message. The worker is alive but stuck
 *    at the "send summary" turn.
 *
 *    Fix: detect (worker dir is a git repo with commits ahead of main) AND
 *    (no recent qualifying summary message from this worker) AND (idle
 *    >5 min). Send parent a bus message with the commit log so the parent
 *    can decide to nudge or terminate-and-promote.
 *
 * The watcher itself is a single setInterval owned by AgentManager. All
 * state (per-worker rate-limit retries, last-alerted timestamps) is
 * in-memory; nothing is persisted because the watcher is meant to be
 * cheap and idempotent across daemon restarts (the next tick after a
 * restart re-detects whatever is still stuck).
 */
export interface WorkerWatcherDeps {
  /** Fetches the live workers map from AgentManager. */
  getRunningWorkers: () => Map<string, WorkerProcess>;
  /** Sends a bus message from a worker to its parent. */
  sendParentAlert: (workerName: string, parent: string | undefined, message: string) => void;
  /** ctxRoot for resolving stdout.log paths. */
  ctxRoot: string;
  /** Org name — used to find the analytics events log. */
  org: string;
  /** Cadence in ms. Default 60_000. */
  cadenceMs?: number;
  /** Max auto-resume retries before parent alert. Default 3. */
  maxRetries?: number;
  /** Idle threshold for code-done detector. Default 5 min. */
  idleThresholdMs?: number;
  /** Lookback for "recent bus activity" detection. Default 10 min. */
  summaryLookbackMs?: number;
  /** Optional clock injection for tests. */
  now?: () => number;
}

interface PerWorkerState {
  /** Has the rate-limit banner been observed? */
  rateLimitState: 'none' | 'detected' | 'waiting' | 'recovered' | 'exhausted';
  resetAt: Date | null;
  retries: number;
  /** First-seen timestamp of the current rate-limit detection (for idle calc). */
  detectedAt: number | null;
  /** Last code-done-needs-summary alert (so we don't spam every cadence-tick). */
  codeDoneAlertedAt: number | null;
}

export class WorkerWatcher {
  private deps: Required<Omit<WorkerWatcherDeps, 'now'>> & { now: () => number };
  private timer: ReturnType<typeof setInterval> | null = null;
  private perWorker: Map<string, PerWorkerState> = new Map();

  constructor(deps: WorkerWatcherDeps) {
    this.deps = {
      getRunningWorkers: deps.getRunningWorkers,
      sendParentAlert: deps.sendParentAlert,
      ctxRoot: deps.ctxRoot,
      org: deps.org,
      cadenceMs: deps.cadenceMs ?? 60_000,
      maxRetries: deps.maxRetries ?? 3,
      idleThresholdMs: deps.idleThresholdMs ?? 5 * 60_000,
      summaryLookbackMs: deps.summaryLookbackMs ?? 10 * 60_000,
      now: deps.now ?? (() => Date.now()),
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { this.tick(); } catch (err) {
        console.error(`[worker-watcher] tick failed: ${(err as Error).message}`);
      }
    }, this.deps.cadenceMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One detection + action pass over every running worker. Public for tests.
   */
  tick(): void {
    const workers = this.deps.getRunningWorkers();
    const seen = new Set<string>();

    for (const [name, worker] of workers) {
      seen.add(name);
      const status = worker.getStatus();
      // Skip workers that aren't in a running-ish state. waiting-for-reset
      // is a substate of running for our purposes — we still tick them so we
      // can detect the reset has passed.
      if (status.status !== 'running' && status.status !== 'waiting-for-reset') {
        continue;
      }

      const state = this.perWorker.get(name) || initialState();
      this.tickWorker(name, worker, state);
      this.perWorker.set(name, state);
    }

    // GC entries for workers that have disappeared.
    for (const name of this.perWorker.keys()) {
      if (!seen.has(name)) this.perWorker.delete(name);
    }
  }

  private tickWorker(name: string, worker: WorkerProcess, state: PerWorkerState): void {
    const tail = readStdoutTail(this.deps.ctxRoot, name);
    if (!tail) return;

    const cleaned = stripAnsi(tail);
    const banner = parseRateLimitBanner(cleaned);

    if (banner.hit) {
      // Newly detected rate-limit, OR already-known one. Update state.
      if (state.rateLimitState === 'none') {
        state.rateLimitState = 'detected';
        state.detectedAt = this.deps.now();
        state.resetAt = banner.resetAt;
        worker.markWaitingForReset(banner.resetAt);
        console.log(`[worker-watcher] ${name} rate-limit detected (resetAt=${banner.resetAt?.toISOString() ?? 'unknown'})`);
      }
      // If reset has passed (and we have a known reset time), inject.
      const now = this.deps.now();
      if (state.resetAt && now >= state.resetAt.getTime() + 30_000) {
        if (state.retries >= this.deps.maxRetries) {
          if (state.rateLimitState !== 'exhausted') {
            state.rateLimitState = 'exhausted';
            this.deps.sendParentAlert(
              name,
              worker.parent,
              `Worker ${name} exhausted auto-resume retries (${this.deps.maxRetries}) after rate-limit. ` +
              `Reset was ${state.resetAt.toISOString()}. Manual intervention needed.`,
            );
            console.log(`[worker-watcher] ${name} rate-limit exhausted after ${this.deps.maxRetries} retries`);
          }
          return;
        }
        const ok = worker.inject(`Continue from where you left off. The rate-limit has reset.\n`);
        state.retries += 1;
        state.rateLimitState = 'waiting'; // wait for next tick to confirm recovery
        console.log(`[worker-watcher] ${name} injected resume (retry ${state.retries}/${this.deps.maxRetries}, ok=${ok})`);
      }
    } else if (state.rateLimitState !== 'none') {
      // No banner in current tail → worker has recovered (output past the banner).
      if (state.rateLimitState !== 'recovered') {
        console.log(`[worker-watcher] ${name} rate-limit recovered`);
      }
      state.rateLimitState = 'recovered';
      state.resetAt = null;
      worker.clearWaitingForReset();
    }

    // Code-done-needs-summary detection.
    if (state.rateLimitState === 'none' || state.rateLimitState === 'recovered') {
      const cdnsAlert = detectCommitDoneNoSummary({
        workerName: name,
        workerDir: worker.dir,
        idleFlagPath: join(this.deps.ctxRoot, 'state', name, 'last_idle.flag'),
        eventsLogPath: workerEventsLogPath(this.deps.ctxRoot, this.deps.org, name, this.deps.now()),
        idleThresholdMs: this.deps.idleThresholdMs,
        summaryLookbackMs: this.deps.summaryLookbackMs,
        now: this.deps.now,
      });
      if (cdnsAlert) {
        // Only alert once per detection cycle (detect → reset by absence in next tick).
        if (state.codeDoneAlertedAt === null) {
          state.codeDoneAlertedAt = this.deps.now();
          this.deps.sendParentAlert(
            name,
            worker.parent,
            `Worker ${name} appears stuck at the summary step. ` +
            `Branch ${cdnsAlert.branch} has ${cdnsAlert.commitsAhead} commit(s) ahead of main but no summary message in last ` +
            `${Math.round(this.deps.summaryLookbackMs / 60_000)} min. Recent commits:\n${cdnsAlert.commitLog}`,
          );
          console.log(`[worker-watcher] ${name} code-done-needs-summary alert sent`);
        }
      } else {
        // Reset the alert latch so a future stuck cycle can re-alert.
        state.codeDoneAlertedAt = null;
      }
    }
  }

  /** Internal state inspection for tests. */
  _getState(name: string): PerWorkerState | undefined {
    return this.perWorker.get(name);
  }
}

function initialState(): PerWorkerState {
  return {
    rateLimitState: 'none',
    resetAt: null,
    retries: 0,
    detectedAt: null,
    codeDoneAlertedAt: null,
  };
}

// ── Pure helpers (exported for unit tests) ──────────────────────────────────

/**
 * Strip common ANSI / VT100 escape sequences so the rate-limit banner
 * regex matches the rendered text rather than the terminal escapes that
 * Claude Code emits inline. We don't try to be fully spec-compliant — we
 * just strip the patterns we see in real worker stdout.
 */
export function stripAnsi(input: string): string {
  // CSI sequences: ESC [ ... letter
  let out = input.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
  // OSC sequences: ESC ] ... BEL
  out = out.replace(/\x1B\][^\x07]*\x07/g, '');
  return out;
}

export interface RateLimitDetection {
  hit: boolean;
  resetAt: Date | null;
}

/**
 * Detect the Claude Code rate-limit banner. Returns hit=true if any
 * variant of the banner is present in the input AND tries to parse a
 * reset time from the same line. Calibrated to live banner strings
 * captured from worker stdout on 2026-04-22 ("You've used 91% of your
 * weekly limit · resets 7pm (UTC)") and the more dire "You have hit
 * your <X> limit" form named in the task description.
 */
export function parseRateLimitBanner(input: string): RateLimitDetection {
  // We look for either the hit-it form or the >=95% warning form (95+
  // means the worker has effectively stopped accepting work — same
  // recovery path).
  const lines = input.split(/\n/);
  for (const line of lines) {
    const looksLikeBanner =
      /You have hit your\b/i.test(line) ||
      /You['’]ve used (?:9[5-9]|100)% of your\b/i.test(line);
    if (!looksLikeBanner) continue;
    // Extract reset hint from the same line.
    const reset = parseResetTime(line);
    return { hit: true, resetAt: reset };
  }
  return { hit: false, resetAt: null };
}

/**
 * Best-effort parse of the "resets <time>" hint Claude Code prints next
 * to the rate-limit banner. Recognized shapes:
 *   - "resets 7pm (UTC)"
 *   - "resets 12am (UTC)"
 *   - "resets at 7pm"
 *   - "resets Monday 12:00 (UTC)" (we only resolve the time-of-day; the
 *     weekday is informational)
 *
 * Returns the next future Date matching the parsed time-of-day, in UTC
 * unless a different timezone is named (we currently only support UTC
 * explicitly; other zones fall through to UTC interpretation, which is
 * close enough for the +30s grace we apply anyway).
 *
 * Returns null if no parseable hint is found — the watcher then degrades
 * to "wait and retry on cadence" mode.
 */
export function parseResetTime(line: string, now: Date = new Date()): Date | null {
  const match = line.match(/resets(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const ampm = match[3]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0,
  ));
  // If candidate is in the past, push forward by one day (the next 7pm).
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}

export interface CodeDoneCheckInput {
  workerName: string;
  workerDir: string;
  idleFlagPath: string;
  /** Path to the worker's daily analytics events log (jsonl). */
  eventsLogPath: string;
  idleThresholdMs: number;
  summaryLookbackMs: number;
  now: () => number;
}

/**
 * Compose the path to the worker's daily analytics events log. Workers
 * write `agent_message_sent` events to this file via logEvent in
 * src/cli/bus.ts, so its presence-or-absence is the canonical signal
 * for "did this worker send any bus messages today / recently".
 */
export function workerEventsLogPath(ctxRoot: string, org: string, workerName: string, nowMs: number): string {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return join(ctxRoot, 'orgs', org, 'analytics', 'events', workerName, `${day}.jsonl`);
}

export interface CodeDoneCheckResult {
  branch: string;
  commitsAhead: number;
  commitLog: string;
}

/**
 * Detect the "code committed but no summary sent" failure mode. Returns
 * the alert payload if the conditions hold, else null. Pure with respect
 * to fs reads (no writes); shells out to git only when the worker dir is
 * a git repo. Designed to be safe to call every cadence-tick.
 */
export function detectCommitDoneNoSummary(input: CodeDoneCheckInput): CodeDoneCheckResult | null {
  // Idle gate first — cheap.
  const lastIdleSec = readIdleFlagSeconds(input.idleFlagPath);
  if (lastIdleSec === null) return null;
  const nowMs = input.now();
  const idleMs = nowMs - lastIdleSec * 1000;
  if (idleMs < input.idleThresholdMs) return null;

  // Worker dir must be a git repo.
  if (!existsSync(join(input.workerDir, '.git'))) return null;

  // Branch + commits-ahead-of-main.
  let branch = '';
  let commitsAhead = 0;
  let commitLog = '';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: input.workerDir, encoding: 'utf-8', timeout: 5_000,
    }).trim();
    if (!branch || branch === 'main' || branch === 'master' || branch === 'HEAD') return null;
    const countStr = execSync('git rev-list --count main..HEAD', {
      cwd: input.workerDir, encoding: 'utf-8', timeout: 5_000,
    }).trim();
    commitsAhead = parseInt(countStr, 10) || 0;
    if (commitsAhead === 0) return null;
    commitLog = execSync('git log --oneline main..HEAD -10', {
      cwd: input.workerDir, encoding: 'utf-8', timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }

  // No recent bus message from this worker?
  if (hasRecentBusActivity(input.eventsLogPath, nowMs - input.summaryLookbackMs)) return null;

  return { branch, commitsAhead, commitLog };
}

function readIdleFlagSeconds(path: string): number | null {
  try {
    statSync(path);
    const raw = readFileSync(path, 'utf-8').trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Scan the worker's daily events log for any `agent_message_sent`
 * event after `sinceMs`. Returning true means the worker has been
 * actively sending bus messages — so it's not stuck at the summary
 * step.
 *
 * We use ANY message-sent (not text-matched "summary" content) because
 * the bus message-sent event only logs metadata (to, priority, msg_id),
 * not the message body. The signal is "is the worker still doing bus
 * activity?", which is a strict superset of "did it send a summary?"
 * and avoids false positives from text-matching loose phrasing.
 */
export function hasRecentBusActivity(logPath: string, sinceMs: number): boolean {
  if (!existsSync(logPath)) return false;
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf-8');
  } catch {
    return false;
  }
  const lines = raw.split(/\n/).slice(-200); // cap scan
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!/agent_message_sent/.test(line)) continue;
    const tsMatch = line.match(/"timestamp"\s*:\s*"([^"]+)"/);
    if (!tsMatch) continue;
    const ts = Date.parse(tsMatch[1]);
    if (Number.isFinite(ts) && ts >= sinceMs) return true;
  }
  return false;
}

/**
 * Read the last N bytes of the worker's stdout.log. Returns empty string
 * if the file doesn't exist. Caps at maxBytes to keep the watcher cheap.
 */
export function readStdoutTail(ctxRoot: string, workerName: string, maxBytes: number = 32_768): string {
  const path = join(ctxRoot, 'logs', workerName, 'stdout.log');
  if (!existsSync(path)) return '';
  let st;
  try { st = statSync(path); } catch { return ''; }
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  if (len <= 0) return '';
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString('utf-8');
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}
