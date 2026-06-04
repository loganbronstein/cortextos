import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import type { BusPaths } from '../../../src/types';

// Real 2026-04-06 captures (see context-modal-detector.test.ts for provenance).
const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'context-modal');
const realWedge = readFileSync(join(FIXTURES, 'wedge-frozen.bin'), 'utf-8');           // modal + frozen spinner, no prompt
const realIdleWithModal = readFileSync(join(FIXTURES, 'idle-with-modal.bin'), 'utf-8'); // modal + idle input bar

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

// Mock agent whose PTY buffer we control per poll via a mutable closure.
function createMockAgent(getBuf: () => string) {
  return {
    name: 'modal-gate-test',
    getOutputBuffer: () => ({ getRecent: (_n?: number) => getBuf() }),
    getConfig: () => ({}),            // no ctx_handoff_threshold → observe-only past the modal block
    injectMessage: vi.fn(),
  } as any;
}

describe('FastChecker — /compact modal frozen-gate', () => {
  let testDir: string;
  let paths: BusPaths;
  let buf: string;
  let checker: any;
  let restartSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-modal-gate-'));
    paths = createTestPaths(testDir);
    buf = '';
    const agent = createMockAgent(() => buf);
    checker = new FastChecker(agent, paths, '/tmp/framework', { log: () => {} });
    // Stub the real restart (stop()+start()) so we only observe the decision.
    restartSpy = vi.fn();
    checker.forceContextRestart = restartSpy;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('force-restarts a REAL wedged session once the frozen modal is static across 2 polls', async () => {
    buf = realWedge;
    await checker.checkContextStatus();          // poll 1: first sighting, arms the gate
    expect(restartSpy).not.toHaveBeenCalled();
    await checker.checkContextStatus();          // poll 2: tail unchanged → frozen → restart
    expect(restartSpy).toHaveBeenCalledTimes(1);
    expect(restartSpy.mock.calls[0][0]).toMatch(/frozen/i);
  });

  it('does NOT restart on a single sighting (requires 2 consecutive static polls)', async () => {
    buf = realWedge;
    await checker.checkContextStatus();          // one poll only
    expect(restartSpy).not.toHaveBeenCalled();
  });

  // Boss's required adversarial case (#7): a REAL healthy agent buffer that CONTAINS
  // the modal string but shows the idle input bar. Even though the buffer is static
  // across polls, the idle-prompt exclusion must keep it from being restarted.
  it('does NOT restart a healthy agent that quoted the modal then went idle (real bytes, static)', async () => {
    buf = realIdleWithModal;
    await checker.checkContextStatus();
    await checker.checkContextStatus();
    await checker.checkContextStatus();          // extra poll: still must not fire
    expect(restartSpy).not.toHaveBeenCalled();
  });

  // The other healthy shape: actively scrolling. The animating spinner mutates the
  // tail every poll, so the static condition is never met. Grounded in the real
  // "✻ <verb> for <N>s" spinner format (here the elapsed-seconds counter advances).
  it('does NOT restart when the modal is present but the tail keeps changing (active spinner)', async () => {
    const base = realWedge.replace(/for 0s/, ''); // strip the frozen "0s" so we drive the counter
    buf = base + '\x1b[5G✻ Baked for 1s';
    await checker.checkContextStatus();          // poll 1
    buf = base + '\x1b[5G✻ Baked for 2s';
    await checker.checkContextStatus();          // poll 2: tail differs → not frozen
    buf = base + '\x1b[5G✻ Baked for 3s';
    await checker.checkContextStatus();          // poll 3: still advancing
    expect(restartSpy).not.toHaveBeenCalled();
  });

  // Finding #2 guard: forceContextRestart is fire-and-forget and stop()+start() takes
  // seconds, during which the frozen buffer is still visible. The cooldown must keep one
  // wedge from firing repeatedly and overcounting the circuit breaker.
  it('fires only ONCE for a persistent wedge across many polls (cooldown suppresses re-fire)', async () => {
    buf = realWedge;
    for (let i = 0; i < 10; i++) await checker.checkContextStatus();
    expect(restartSpy).toHaveBeenCalledTimes(1);
  });

  it('resets the frozen counter when the modal clears, so a later wedge still needs 2 fresh polls', async () => {
    buf = realWedge;
    await checker.checkContextStatus();          // poll 1: armed (count = 1)
    buf = 'normal agent output, no modal here';
    await checker.checkContextStatus();          // poll 2: modal gone → counter reset
    buf = realWedge;
    await checker.checkContextStatus();          // poll 3: re-armed (count = 1), must NOT fire yet
    expect(restartSpy).not.toHaveBeenCalled();
    await checker.checkContextStatus();          // poll 4: static again → fire
    expect(restartSpy).toHaveBeenCalledTimes(1);
  });
});
