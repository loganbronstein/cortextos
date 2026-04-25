import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import {
  WorkerWatcher,
  parseRateLimitBanner,
  parseResetTime,
  stripAnsi,
  detectCommitDoneNoSummary,
  readStdoutTail,
  workerEventsLogPath,
  hasRecentBusActivity,
} from '../../../src/daemon/worker-watcher.js';
import type { WorkerProcess } from '../../../src/daemon/worker-process.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'worker-watcher-test-'));
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('stripAnsi', () => {
  it('strips CSI sequences', () => {
    expect(stripAnsi('\x1B[38;5;220mhello\x1B[39m')).toBe('hello');
  });
  it('strips OSC sequences', () => {
    expect(stripAnsi('foo\x1B]0;some title\x07bar')).toBe('foobar');
  });
  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('parseRateLimitBanner', () => {
  it('detects the live "used 95% of your weekly limit" form', () => {
    const input = "You've used 95% of your weekly limit · resets 7pm (UTC)";
    const r = parseRateLimitBanner(input);
    expect(r.hit).toBe(true);
    expect(r.resetAt).not.toBeNull();
  });

  it('detects the live "used 100% of your weekly limit" form', () => {
    const input = "You've used 100% of your weekly limit · resets 12am (UTC)";
    expect(parseRateLimitBanner(input).hit).toBe(true);
  });

  it('detects the more dire "have hit your limit" form', () => {
    const input = "You have hit your weekly Opus limit. Try again later.";
    expect(parseRateLimitBanner(input).hit).toBe(true);
  });

  it('does NOT detect on a 91% warning (below the 95% threshold)', () => {
    expect(parseRateLimitBanner("You've used 91% of your weekly limit · resets 7pm").hit).toBe(false);
  });

  it('does NOT detect on unrelated mentions of "limit"', () => {
    expect(parseRateLimitBanner('the rate limit is 100rpm').hit).toBe(false);
    expect(parseRateLimitBanner('limit clause in SQL').hit).toBe(false);
  });

  it('returns hit=true with resetAt=null when banner present but reset hint missing', () => {
    const r = parseRateLimitBanner("You have hit your weekly Opus limit.");
    expect(r.hit).toBe(true);
    expect(r.resetAt).toBeNull();
  });

  it('strips ANSI from a real captured banner before matching', () => {
    const cleaned = stripAnsi(
      "\x1B[38;5;220mYou've used 95% of your weekly limit · resets 7pm (UTC)\x1B[39m"
    );
    expect(parseRateLimitBanner(cleaned).hit).toBe(true);
  });
});

describe('parseResetTime', () => {
  // Anchor "now" so the output is deterministic.
  const fixedNow = new Date('2026-04-25T10:00:00Z');

  it('parses "resets 7pm (UTC)" as today 19:00 UTC', () => {
    const d = parseResetTime('resets 7pm (UTC)', fixedNow);
    expect(d?.toISOString()).toBe('2026-04-25T19:00:00.000Z');
  });

  it('parses "resets 7am (UTC)" — pushed to next day since 7am < 10am now', () => {
    const d = parseResetTime('resets 7am (UTC)', fixedNow);
    expect(d?.toISOString()).toBe('2026-04-26T07:00:00.000Z');
  });

  it('parses "resets 12am (UTC)" as next-day midnight', () => {
    const d = parseResetTime('resets 12am (UTC)', fixedNow);
    expect(d?.toISOString()).toBe('2026-04-26T00:00:00.000Z');
  });

  it('parses "resets 12pm (UTC)" as noon today', () => {
    const d = parseResetTime('resets 12pm (UTC)', fixedNow);
    expect(d?.toISOString()).toBe('2026-04-25T12:00:00.000Z');
  });

  it('parses "resets at 12:30 (UTC)" with explicit minutes', () => {
    const d = parseResetTime('resets at 12:30 (UTC)', fixedNow);
    expect(d?.toISOString()).toBe('2026-04-25T12:30:00.000Z');
  });

  it('returns null for malformed input', () => {
    expect(parseResetTime('eventually', fixedNow)).toBeNull();
    expect(parseResetTime('resets later', fixedNow)).toBeNull();
  });

  it('rejects out-of-range hours', () => {
    expect(parseResetTime('resets 25:00', fixedNow)).toBeNull();
  });
});

describe('readStdoutTail', () => {
  it('returns empty string when log is missing', () => {
    expect(readStdoutTail(tmpRoot, 'no-such-worker')).toBe('');
  });

  it('returns the file content when smaller than maxBytes', () => {
    mkdirSync(join(tmpRoot, 'logs', 'w1'), { recursive: true });
    writeFileSync(join(tmpRoot, 'logs', 'w1', 'stdout.log'), 'short content', 'utf-8');
    expect(readStdoutTail(tmpRoot, 'w1')).toBe('short content');
  });

  it('returns only the last maxBytes when file is larger', () => {
    mkdirSync(join(tmpRoot, 'logs', 'w2'), { recursive: true });
    const big = 'X'.repeat(40_000) + 'TAIL_MARKER';
    writeFileSync(join(tmpRoot, 'logs', 'w2', 'stdout.log'), big, 'utf-8');
    const out = readStdoutTail(tmpRoot, 'w2', 32_768);
    expect(out.length).toBe(32_768);
    expect(out.endsWith('TAIL_MARKER')).toBe(true);
  });
});

describe('detectCommitDoneNoSummary', () => {
  // Build a real git repo on a feature branch with N commits ahead of main.
  function setupRepo(opts: { commitsAhead: number }): string {
    const repo = mkdtempSync(join(tmpdir(), 'wcdns-repo-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t.t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'init');
    execSync('git add . && git commit -q -m initial', { cwd: repo });
    execSync('git checkout -q -b main', { cwd: repo });
    execSync('git checkout -q -b feat/x', { cwd: repo });
    for (let i = 0; i < opts.commitsAhead; i++) {
      writeFileSync(join(repo, `f${i}.txt`), String(i));
      execSync(`git add . && git commit -q -m "feat(x): change ${i}"`, { cwd: repo });
    }
    return repo;
  }

  function writeIdle(secsAgo: number): string {
    const stateDir = join(tmpRoot, 'state', 'w');
    mkdirSync(stateDir, { recursive: true });
    const ts = Math.floor(Date.now() / 1000) - secsAgo;
    const path = join(stateDir, 'last_idle.flag');
    writeFileSync(path, String(ts), 'utf-8');
    return path;
  }

  it('returns null when the worker dir is not a git repo', () => {
    const idleFlag = writeIdle(600);
    const r = detectCommitDoneNoSummary({
      workerName: 'w', workerDir: tmpRoot, idleFlagPath: idleFlag,
      eventsLogPath: join(tmpRoot, 'orgs', 'cortex', 'analytics', 'events', 'w', '2026-04-25.jsonl'),
      idleThresholdMs: 5 * 60_000, summaryLookbackMs: 10 * 60_000,
      now: () => Date.now(),
    });
    expect(r).toBeNull();
  });

  it('returns null when no commits ahead', () => {
    const repo = setupRepo({ commitsAhead: 0 });
    const idleFlag = writeIdle(600);
    const r = detectCommitDoneNoSummary({
      workerName: 'w', workerDir: repo, idleFlagPath: idleFlag,
      eventsLogPath: join(tmpRoot, 'orgs', 'cortex', 'analytics', 'events', 'w', '2026-04-25.jsonl'),
      idleThresholdMs: 5 * 60_000, summaryLookbackMs: 10 * 60_000,
      now: () => Date.now(),
    });
    expect(r).toBeNull();
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns alert payload when commits ahead AND idle past threshold AND no summary', () => {
    const repo = setupRepo({ commitsAhead: 2 });
    const idleFlag = writeIdle(600);
    const r = detectCommitDoneNoSummary({
      workerName: 'w', workerDir: repo, idleFlagPath: idleFlag,
      eventsLogPath: join(tmpRoot, 'orgs', 'cortex', 'analytics', 'events', 'w', '2026-04-25.jsonl'),
      idleThresholdMs: 5 * 60_000, summaryLookbackMs: 10 * 60_000,
      now: () => Date.now(),
    });
    expect(r).not.toBeNull();
    expect(r!.branch).toBe('feat/x');
    expect(r!.commitsAhead).toBe(2);
    expect(r!.commitLog).toContain('feat(x)');
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns null when not idle long enough', () => {
    const repo = setupRepo({ commitsAhead: 2 });
    const idleFlag = writeIdle(60); // 1 min < 5 min threshold
    const r = detectCommitDoneNoSummary({
      workerName: 'w', workerDir: repo, idleFlagPath: idleFlag,
      eventsLogPath: join(tmpRoot, 'orgs', 'cortex', 'analytics', 'events', 'w', '2026-04-25.jsonl'),
      idleThresholdMs: 5 * 60_000, summaryLookbackMs: 10 * 60_000,
      now: () => Date.now(),
    });
    expect(r).toBeNull();
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns null when a recent agent_message_sent event exists', () => {
    const repo = setupRepo({ commitsAhead: 2 });
    const idleFlag = writeIdle(600);
    const logDir = join(tmpRoot, 'orgs', 'cortex', 'analytics', 'events', 'w');
    mkdirSync(logDir, { recursive: true });
    const recentTs = new Date(Date.now() - 60_000).toISOString();
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(logDir, `${day}.jsonl`),
      `{"id":"x","agent":"w","org":"cortex","timestamp":"${recentTs}","category":"message","event":"agent_message_sent","severity":"info","metadata":{"to":"parent","priority":"normal","msg_id":"x"}}\n`,
      'utf-8',
    );
    const r = detectCommitDoneNoSummary({
      workerName: 'w', workerDir: repo, idleFlagPath: idleFlag,
      eventsLogPath: join(logDir, `${day}.jsonl`),
      idleThresholdMs: 5 * 60_000, summaryLookbackMs: 10 * 60_000,
      now: () => Date.now(),
    });
    expect(r).toBeNull();
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('workerEventsLogPath', () => {
  it('composes the analytics events path with current day', () => {
    const path = workerEventsLogPath('/tmp/ctx', 'cortex', 'w1', Date.parse('2026-04-25T10:00:00Z'));
    expect(path).toBe('/tmp/ctx/orgs/cortex/analytics/events/w1/2026-04-25.jsonl');
  });
});

describe('hasRecentBusActivity', () => {
  it('returns false when log missing', () => {
    expect(hasRecentBusActivity('/no/such/file.jsonl', 0)).toBe(false);
  });

  it('returns true when an agent_message_sent event is newer than sinceMs', () => {
    const path = join(tmpRoot, 'events.jsonl');
    const ts = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(path, `{"event":"agent_message_sent","timestamp":"${ts}"}\n`, 'utf-8');
    expect(hasRecentBusActivity(path, Date.now() - 5 * 60_000)).toBe(true);
  });

  it('returns false when the event predates sinceMs', () => {
    const path = join(tmpRoot, 'events.jsonl');
    const ts = new Date(Date.now() - 30 * 60_000).toISOString();
    writeFileSync(path, `{"event":"agent_message_sent","timestamp":"${ts}"}\n`, 'utf-8');
    expect(hasRecentBusActivity(path, Date.now() - 5 * 60_000)).toBe(false);
  });

  it('ignores other event types', () => {
    const path = join(tmpRoot, 'events.jsonl');
    const ts = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(path, `{"event":"agent_heartbeat","timestamp":"${ts}"}\n`, 'utf-8');
    expect(hasRecentBusActivity(path, Date.now() - 5 * 60_000)).toBe(false);
  });
});

describe('WorkerWatcher state machine', () => {
  // Mock worker that captures inject calls and exposes status mutations.
  function makeMockWorker(name: string, parent: string | undefined = 'parent-agent') {
    const injects: string[] = [];
    let status: any = 'running';
    let resetAt: Date | null = null;
    return {
      name,
      dir: tmpRoot,
      parent,
      _injects: injects,
      inject: (text: string) => { injects.push(text); return true; },
      getStatus: () => ({ name, status, dir: tmpRoot, parent, spawnedAt: '', resetAt: resetAt?.toISOString() }),
      markWaitingForReset: (r: Date | null) => { status = 'waiting-for-reset'; resetAt = r; },
      clearWaitingForReset: () => { status = 'running'; resetAt = null; },
    } as unknown as WorkerProcess & { _injects: string[] };
  }

  function writeStdout(workerName: string, content: string) {
    const dir = join(tmpRoot, 'logs', workerName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stdout.log'), content, 'utf-8');
  }

  it('detects rate-limit, marks waiting, and injects after reset has passed', () => {
    const worker = makeMockWorker('w');
    const workers = new Map<string, WorkerProcess>();
    workers.set('w', worker as any);

    const alerts: Array<{ name: string; message: string }> = [];
    let nowMs = Date.parse('2026-04-25T10:00:00Z');

    const watcher = new WorkerWatcher({
      getRunningWorkers: () => workers,
      sendParentAlert: (n, _p, m) => alerts.push({ name: n, message: m }),
      ctxRoot: tmpRoot,
      org: 'cortex',
      cadenceMs: 60_000,
      maxRetries: 3,
      now: () => nowMs,
    });

    // Tick 1: rate-limit detected, no inject yet (reset is in the future).
    writeStdout('w', "You've used 95% of your weekly limit · resets 7pm (UTC)");
    watcher.tick();
    let s = watcher._getState('w')!;
    expect(s.rateLimitState).toBe('detected');
    expect(s.resetAt).not.toBeNull();
    expect((worker as any)._injects).toHaveLength(0);

    // Tick 2: time advanced past reset + 30s grace → inject.
    nowMs = Date.parse('2026-04-25T19:00:35Z');
    watcher.tick();
    s = watcher._getState('w')!;
    expect((worker as any)._injects).toHaveLength(1);
    expect((worker as any)._injects[0]).toContain('Continue from where you left off');
    expect(s.retries).toBe(1);
  });

  it('exhausts after maxRetries and sends parent alert', () => {
    const worker = makeMockWorker('w');
    const workers = new Map<string, WorkerProcess>();
    workers.set('w', worker as any);
    const alerts: Array<{ name: string; message: string }> = [];
    let nowMs = Date.parse('2026-04-25T19:00:35Z');

    writeStdout('w', "You have hit your weekly limit. resets 7pm (UTC)");

    const watcher = new WorkerWatcher({
      getRunningWorkers: () => workers,
      sendParentAlert: (n, _p, m) => alerts.push({ name: n, message: m }),
      ctxRoot: tmpRoot,
      org: 'cortex',
      maxRetries: 2,
      now: () => nowMs,
    });

    // 3 ticks should trigger 2 injects then 1 exhaustion alert.
    watcher.tick();
    watcher.tick();
    watcher.tick();
    expect((worker as any)._injects.length).toBe(2);
    expect(alerts.length).toBe(1);
    expect(alerts[0].message).toContain('exhausted auto-resume retries');
    expect(watcher._getState('w')!.rateLimitState).toBe('exhausted');
  });

  it('clears waiting-for-reset when banner disappears from tail', () => {
    const worker = makeMockWorker('w');
    const workers = new Map<string, WorkerProcess>();
    workers.set('w', worker as any);

    const watcher = new WorkerWatcher({
      getRunningWorkers: () => workers,
      sendParentAlert: () => {},
      ctxRoot: tmpRoot,
      org: 'cortex',
      now: () => Date.parse('2026-04-25T10:00:00Z'),
    });

    // First tick: detected.
    writeStdout('w', "You've used 95% of your weekly limit · resets 7pm (UTC)");
    watcher.tick();
    expect(watcher._getState('w')!.rateLimitState).toBe('detected');

    // Second tick: banner gone (worker moved past it).
    writeStdout('w', 'fresh output, all good');
    watcher.tick();
    expect(watcher._getState('w')!.rateLimitState).toBe('recovered');
    expect((worker as any).getStatus().status).toBe('running');
  });

  it('garbage-collects state for workers that disappear', () => {
    const worker = makeMockWorker('w');
    const workers = new Map<string, WorkerProcess>();
    workers.set('w', worker as any);

    const watcher = new WorkerWatcher({
      getRunningWorkers: () => workers,
      sendParentAlert: () => {},
      ctxRoot: tmpRoot,
      org: 'cortex',
      now: () => Date.now(),
    });

    writeStdout('w', "You have hit your weekly limit.");
    watcher.tick();
    expect(watcher._getState('w')).toBeDefined();

    workers.delete('w');
    watcher.tick();
    expect(watcher._getState('w')).toBeUndefined();
  });

  it('skips workers not in running or waiting-for-reset state', () => {
    const worker = makeMockWorker('w');
    (worker as any).getStatus = () => ({ name: 'w', status: 'completed', dir: tmpRoot, parent: 'p', spawnedAt: '' });
    const workers = new Map<string, WorkerProcess>();
    workers.set('w', worker as any);

    writeStdout('w', "You have hit your weekly limit.");
    const watcher = new WorkerWatcher({
      getRunningWorkers: () => workers,
      sendParentAlert: () => {},
      ctxRoot: tmpRoot,
      org: 'cortex',
      now: () => Date.now(),
    });
    watcher.tick();
    expect(watcher._getState('w')).toBeUndefined();
    expect((worker as any)._injects.length).toBe(0);
  });
});
