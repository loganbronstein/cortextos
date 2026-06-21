import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock child_process so the circuit-breaker / event / alert paths don't spawn real `cortextos`.
vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb?: (e: Error | null) => void) => {
    if (typeof cb === 'function') cb(null);
  }),
}));

import { FastChecker, detectAuthWedge } from '../../../src/daemon/fast-checker';
import type { BusPaths } from '../../../src/types';

// The REAL cleaned runtime shape (codex-verified): ONE padded error line that joins the login prompt
// and the 401 with a "·" separator, sitting at the input prompt. Only ONE "API Error: 401".
const realAuthWedge =
  '> what is the status\n⏺ Please run /login · API Error: 401 Invalid authentication credentials\n\n❯ ';

// A SINGLE quoted mention (like this build task / an incident report): the login + 401 are written as
// SEPARATE quoted strings (not the joined runtime line), so the adjacency guard excludes it.
const singleQuote =
  'boss: scan the recent PTY frame for REPEATED "Please run /login" + "API Error: 401" so a quoted mention of 401 (like this message) does NOT trigger.';

function createTestPaths(testDir: string): BusPaths {
  const paths = {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox'),
    inflight: join(testDir, 'inflight'),
    processed: join(testDir, 'processed'),
    logDir: join(testDir, 'logs'),
    stateDir: join(testDir, 'state'),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  } as BusPaths;
  for (const dir of Object.values(paths)) {
    if (dir !== testDir) mkdirSync(dir, { recursive: true });
  }
  return paths;
}

function createMockAgent(getBuf: () => string, extra: Record<string, unknown> = {}) {
  return {
    name: 'auth-wedge-test',
    getOutputBuffer: () => ({ getRecent: (_n?: number) => getBuf() }),
    getConfig: () => ({}),
    injectMessage: vi.fn(),
    sessionRefresh: vi.fn().mockResolvedValue(undefined),
    ...extra,
  } as any;
}

// ---------------------------------------------------------------------------
// detectAuthWedge — repeated-evidence guard
// ---------------------------------------------------------------------------
describe('detectAuthWedge — single live runtime line', () => {
  it('REAL wedge: ONE joined runtime line ("...login · API Error: 401...") → wedged', () => {
    const r = detectAuthWedge(realAuthWedge);
    expect(r.wedged).toBe(true);
    expect(r.occurrences).toBe(1); // a single occurrence is sufficient (the real fleet shape)
  });

  it('real ⏺ line after CR/LF, hyphen separator → wedged', () => {
    expect(detectAuthWedge('prev output\r\n⏺ Please run /login - API Error: 401 something\n❯').wedged).toBe(true);
  });

  it('real ⏺ line with the "·" collapsed to spaces → wedged', () => {
    expect(detectAuthWedge('prev\n⏺ Please run /login  API Error: 401 something\n❯').wedged).toBe(true);
  });

  it('JOINED ⏺ runtime line with the invalid-credentials variant → wedged', () => {
    expect(detectAuthWedge('⏺ Please run /login · API Error: 401 Invalid authentication credentials\n❯').wedged).toBe(true);
  });

  it('JOINED ⏺ runtime line with the socket variant (after CR/LF) → wedged', () => {
    expect(detectAuthWedge('prev\r\n⏺ Please run /login · API Error: 401 The socket connection was closed unexpectedly\n❯').wedged).toBe(true);
  });

  it('quoted/report form (login + 401 as SEPARATE quoted strings) → NOT wedged (adjacency guard)', () => {
    expect(detectAuthWedge(singleQuote).wedged).toBe(false);
  });

  it('prose-only variant phrase WITHOUT the login-join → NOT wedged', () => {
    expect(detectAuthWedge('incident report says API Error: 401 Invalid authentication credentials happened once').wedged).toBe(false);
    expect(detectAuthWedge('incident report says API Error: 401 The socket connection was closed unexpectedly happened once').wedged).toBe(false);
  });

  it('inline prose quoting the joined line (no ⏺ marker) → NOT wedged', () => {
    expect(detectAuthWedge('incident report says Please run /login · API Error: 401 Invalid authentication credentials happened once').wedged).toBe(false);
  });

  it('inline prose quoting the EXACT ⏺ line mid-sentence → NOT wedged (line-start anchor)', () => {
    expect(detectAuthWedge('Verified real shape "⏺ Please run /login · API Error: 401 Invalid authentication credentials … ❯" -> wedged true').wedged).toBe(false);
  });

  it('bare "API Error: 401" with NO login-join → NOT wedged', () => {
    expect(detectAuthWedge('API Error: 401\nAPI Error: 401\nAPI Error: 401').wedged).toBe(false);
  });

  it('benign output → NOT wedged', () => {
    expect(detectAuthWedge('working on a task, all good').wedged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkAuthWedge — frozen gate (decision only; forceAuthRestart stubbed)
// ---------------------------------------------------------------------------
describe('FastChecker — 401 auth-wedge frozen gate', () => {
  let testDir: string;
  let paths: BusPaths;
  let buf: string;
  let checker: any;
  let restartSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-auth-wedge-'));
    paths = createTestPaths(testDir);
    buf = '';
    checker = new FastChecker(createMockAgent(() => buf), paths, '/tmp/framework', { log: () => {} });
    restartSpy = vi.fn();
    checker.forceAuthRestart = restartSpy;
  });

  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('preserve-refreshes ONCE after the repeated-401 signature is static across 3 polls', async () => {
    buf = realAuthWedge;
    await checker.checkAuthWedge();            // poll 1: arm (count 1)
    await checker.checkAuthWedge();            // poll 2: static (count 2)
    expect(restartSpy).not.toHaveBeenCalled();
    await checker.checkAuthWedge();            // poll 3: static (count 3) → fire
    expect(restartSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire on fewer than 3 static polls', async () => {
    buf = realAuthWedge;
    await checker.checkAuthWedge();
    await checker.checkAuthWedge();
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('does NOT fire on a single quoted 401 mention (this very kind of message)', async () => {
    buf = singleQuote;
    for (let i = 0; i < 5; i++) await checker.checkAuthWedge();
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('does NOT fire when an agent is actively scrolling text that contains the signature', async () => {
    // Each poll the frame CHANGES (agent producing output) even though the 401 signature is
    // present — a healthy agent quoting the RCA. The byte-static gate never reaches 3.
    for (let i = 1; i <= 5; i++) {
      buf = realAuthWedge + `\nworking on the fix... step ${i}`;
      await checker.checkAuthWedge();
    }
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('fires only ONCE for a persistent wedge across many polls (cooldown suppresses re-fire)', async () => {
    buf = realAuthWedge;
    for (let i = 0; i < 12; i++) await checker.checkAuthWedge();
    expect(restartSpy).toHaveBeenCalledTimes(1);
  });

  it('resets the frozen counter when the signature clears', async () => {
    buf = realAuthWedge;
    await checker.checkAuthWedge();            // count 1
    buf = 'normal output, no auth error';
    await checker.checkAuthWedge();            // cleared → reset
    buf = realAuthWedge;
    await checker.checkAuthWedge();            // re-armed (count 1)
    await checker.checkAuthWedge();            // count 2
    expect(restartSpy).not.toHaveBeenCalled();
    await checker.checkAuthWedge();            // count 3 → fire
    expect(restartSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// forceAuthRestart — circuit breaker (real method; sessionRefresh + telegram mocked)
// ---------------------------------------------------------------------------
describe('FastChecker — auth circuit breaker', () => {
  let testDir: string;
  let paths: BusPaths;
  let refreshSpy: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;
  let checker: any;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-auth-circuit-'));
    paths = createTestPaths(testDir);
    refreshSpy = vi.fn().mockResolvedValue(undefined);
    sendMessage = vi.fn().mockResolvedValue(undefined);
    const agent = createMockAgent(() => '', { sessionRefresh: refreshSpy });
    checker = new FastChecker(agent, paths, '/tmp/framework', {
      log: () => {},
      telegramApi: { sendMessage } as any,
      chatId: '123',
    });
  });

  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('allows 3 preserve-refreshes then TRIPS, alerting instead of looping', () => {
    checker.forceAuthRestart('r1');
    checker.forceAuthRestart('r2');
    checker.forceAuthRestart('r3');
    expect(refreshSpy).toHaveBeenCalledTimes(3);
    expect(sendMessage).not.toHaveBeenCalled();

    checker.forceAuthRestart('r4'); // 4th within the window → breaker trips
    expect(refreshSpy).toHaveBeenCalledTimes(3); // no 4th refresh
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatch(/circuit breaker TRIPPED/i);
    expect(sendMessage.mock.calls[0][1]).toMatch(/manual \/login/i);
  });

  it('persists the breaker state to disk (survives --continue restarts)', () => {
    checker.forceAuthRestart('r1');
    const reloaded = new FastChecker(createMockAgent(() => ''), paths, '/tmp/framework', { log: () => {} });
    expect((reloaded as any).authCircuitRestarts.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// watchdog suppression
// ---------------------------------------------------------------------------
describe('FastChecker — watchdog does not mark auth-wedged sessions alive', () => {
  let testDir: string;
  let paths: BusPaths;
  let buf: string;
  let checker: any;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-auth-watchdog-'));
    paths = createTestPaths(testDir);
    buf = '';
    checker = new FastChecker(createMockAgent(() => buf), paths, '/tmp/framework', { log: () => {} });
  });

  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('suppresses the alive heartbeat when the 401 signature is present', () => {
    buf = realAuthWedge;
    expect(checker.watchdogShouldReportAlive()).toBe(false);
  });

  it('reports alive on a healthy frame', () => {
    buf = 'idle session, ready for input';
    expect(checker.watchdogShouldReportAlive()).toBe(true);
  });

  it('reports alive on a single quoted 401 mention (not a real wedge)', () => {
    buf = singleQuote;
    expect(checker.watchdogShouldReportAlive()).toBe(true);
  });
});
