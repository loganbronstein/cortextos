/**
 * tests/unit/daemon/restart-intent.test.ts — BUG-011 Branch B (RestartIntent).
 *
 * Verifies AgentProcess.start(intent) mode resolution + the preserve-vs-marker
 * conflict signal, and that sessionRefresh threads the intent. Mocks the PTY so
 * we can assert the (mode, prompt) passed to pty.spawn() without spawning.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn(),
};
vi.mock('../../../src/pty/agent-pty.js', () => ({ AgentPTY: function AgentPTY() { return mockPty; } }));
vi.mock('../../../src/pty/hermes-pty.js', () => ({ HermesPTY: function HermesPTY() { return mockPty; }, hermesDbExists: () => true }));
vi.mock('../../../src/pty/inject.js', () => ({ injectMessage: vi.fn(), MessageDedup: class { isDuplicate() { return false; } } }));
vi.mock('../../../src/utils/atomic.js', () => ({ ensureDir: vi.fn(), atomicWriteSync: vi.fn() }));
vi.mock('../../../src/utils/env.js', () => ({ writeCortextosEnv: vi.fn(), resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }) }));
vi.mock('../../../src/bus/reminders.js', () => ({ getOverdueReminders: vi.fn().mockReturnValue([]) }));
vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({ stateDir: '/tmp/test-ctx/state/alice', logDir: '/tmp/test-ctx/logs/alice' }),
}));

const mockLogEvent = vi.fn();
vi.mock('../../../src/bus/event.js', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
};
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
    get unlinkSync() { return fsMocks.unlinkSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test', ctxRoot: '/tmp/test-ctx', frameworkRoot: '/tmp/fw',
  agentName: 'alice', agentDir: '/tmp/fw/orgs/acme/agents/alice', org: 'acme', projectRoot: '/tmp/fw',
};

beforeEach(() => {
  mockPty.spawn.mockClear();
  mockPty.onExit.mockClear();
  mockLogEvent.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.appendFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.unlinkSync.mockReset();
});

/** Construct an AgentProcess with controllable marker + resumability primitives. */
function makeAgent(opts: { marker: boolean; resumable: boolean }) {
  const ap = new AgentProcess('alice', mockEnv, {});
  vi.spyOn(ap as unknown as { consumeForceFresh: () => string }, 'consumeForceFresh').mockReturnValue(opts.marker ? 'consumed' : 'absent');
  vi.spyOn(ap as unknown as { hasResumableSession: () => boolean }, 'hasResumableSession').mockReturnValue(opts.resumable);
  return ap;
}
const spawnMode = () => mockPty.spawn.mock.calls[0]?.[0];

describe('BUG-011 RestartIntent — AgentProcess.start() mode resolution', () => {
  it('fresh + no marker → fresh (regression 4)', async () => {
    await makeAgent({ marker: false, resumable: true }).start('fresh');
    expect(spawnMode()).toBe('fresh');
  });

  it('fresh + marker → fresh, marker consumed (regression 5)', async () => {
    const ap = makeAgent({ marker: true, resumable: true });
    const consume = (ap as unknown as { consumeForceFresh: () => boolean }).consumeForceFresh as ReturnType<typeof vi.fn>;
    await ap.start('fresh');
    expect(spawnMode()).toBe('fresh');
    expect(consume).toHaveBeenCalled();
  });

  it('auto + marker → fresh (legacy behavior, regression 6)', async () => {
    await makeAgent({ marker: true, resumable: true }).start('auto');
    expect(spawnMode()).toBe('fresh');
  });

  it('auto + no marker + resumable → continue (legacy)', async () => {
    await makeAgent({ marker: false, resumable: true }).start('auto');
    expect(spawnMode()).toBe('continue');
  });

  it('preserve + resumable → continue (the supersede receipt flow is covered in restart-marker-supersede.test.ts)', async () => {
    await makeAgent({ marker: true, resumable: true }).start('preserve');
    expect(spawnMode()).toBe('continue');
  });

  it('OLD unconditional-marker behavior FAILS the preserve regression (auto vs preserve contrast)', async () => {
    // Same fixture (marker present + resumable). The legacy decision was
    // `shouldContinue() ? continue : fresh`, which consumes .force-fresh and goes
    // FRESH — exactly the silent history loss. That is the 'auto' path here:
    await makeAgent({ marker: true, resumable: true }).start('auto');
    expect(spawnMode()).toBe('fresh');          // old behavior loses the session
    mockPty.spawn.mockClear();
    // The NEW 'preserve' intent keeps it:
    await makeAgent({ marker: true, resumable: true }).start('preserve');
    expect(spawnMode()).toBe('continue');       // new behavior preserves history
  });

  it('preserve + resumable + no marker → continue + NO signal', async () => {
    await makeAgent({ marker: false, resumable: true }).start('preserve');
    expect(spawnMode()).toBe('continue');
    expect(fsMocks.appendFileSync.mock.calls.filter(c => String(c[0]).includes('restarts.log'))).toHaveLength(0);
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('preserve + NO resumable session → fresh, NOT history loss, no supersede signal (regression 10)', async () => {
    await makeAgent({ marker: false, resumable: false }).start('preserve');
    expect(spawnMode()).toBe('fresh');
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('default start() (no intent) is auto, not preserve (regression 13 — cold/crash/discovery)', async () => {
    // marker + resumable: auto → fresh (honors marker); preserve would supersede → continue.
    await makeAgent({ marker: true, resumable: true }).start();
    expect(spawnMode()).toBe('fresh');
  });
});

describe('BUG-011 RestartIntent — sessionRefresh threads intent', () => {
  it('sessionRefresh() defaults to preserve (max-session-timer rollover, regression 11)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start('fresh');
    const startSpy = vi.spyOn(ap, 'start').mockResolvedValue();
    vi.spyOn(ap, 'stop').mockResolvedValue();
    await ap.sessionRefresh();
    expect(startSpy).toHaveBeenCalledWith('preserve');
  });

  it("sessionRefresh('fresh') forwards fresh (forceContextRestart, regression 12)", async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start('fresh');
    const startSpy = vi.spyOn(ap, 'start').mockResolvedValue();
    vi.spyOn(ap, 'stop').mockResolvedValue();
    await ap.sessionRefresh('fresh');
    expect(startSpy).toHaveBeenCalledWith('fresh');
  });
});

describe('BUG-011 RestartIntent — fail closed on .force-fresh delete failure (finding 1)', () => {
  // Real consumeForceFresh() path (NOT spied): marker present + unlink throws.
  for (const intent of ['preserve', 'fresh', 'auto'] as const) {
    it(`${intent}: delete-failed → start() rejects, PTY never spawned, marker left on disk`, async () => {
      fsMocks.existsSync.mockImplementation((p: unknown) => String(p).endsWith('.force-fresh'));
      fsMocks.unlinkSync.mockImplementation(() => { throw new Error('EACCES'); });
      const ap = new AgentProcess('alice', mockEnv, {});

      await expect(ap.start(intent)).rejects.toThrow(/could NOT be removed/i);
      expect(mockPty.spawn).not.toHaveBeenCalled();   // fail-closed BEFORE spawn
      expect(fsMocks.unlinkSync).toHaveBeenCalled();  // removal was attempted
      // marker still present (existsSync stays true; we never recreated/deleted it)
      expect(fsMocks.existsSync(`/tmp/test-ctx/state/alice/.force-fresh`)).toBe(true);
    });
  }
});

describe('BUG-011 RestartIntent — max-session timer rolls over with preserve (finding 4)', () => {
  it('the session timer fires sessionRefresh which calls start("preserve")', async () => {
    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { max_session_seconds: 1 });
      const startSpy = vi.spyOn(ap, 'start');
      vi.spyOn(ap, 'stop').mockResolvedValue();
      await ap.start('fresh');          // initial boot schedules the session timer
      startSpy.mockClear();
      startSpy.mockResolvedValue();     // subsequent start is a no-op spy
      await vi.advanceTimersByTimeAsync(2000); // fire the timer → sessionRefresh() → start()
      expect(startSpy).toHaveBeenCalledWith('preserve');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BUG-011 RestartIntent — .force-fresh is the durable fallback for Hermes auto (finding 2)', () => {
  it('auto + hermes + DB exists + marker → fresh, marker consumed (marker handled before runtime resumability)', async () => {
    // hermesDbExists() is mocked true, so the OLD shouldContinue() would have
    // returned continue and ignored the marker. The marker must win for 'auto'.
    let deleted = false;
    fsMocks.existsSync.mockImplementation((p: unknown) => String(p).endsWith('.force-fresh') && !deleted);
    fsMocks.unlinkSync.mockImplementation(() => { deleted = true; });

    const ap = new AgentProcess('alice', mockEnv, { runtime: 'hermes' });
    await ap.start('auto');

    expect(spawnMode()).toBe('fresh'); // marker forced fresh despite a resumable Hermes DB
    expect(deleted).toBe(true);        // marker consumed
  });
});
