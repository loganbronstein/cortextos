import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync as realMkdirSync, writeFileSync as realWriteFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Capture PTY exit handler so tests can simulate worker exit
let capturedOnExit: ((code: number) => void) | null = null;
const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  onExit: vi.fn().mockImplementation((cb: (code: number) => void) => {
    capturedOnExit = cb;
  }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

const mockInjectMessage = vi.fn();
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
}));

// Note: we deliberately do NOT mock 'fs' globally — the suspend tests need
// real file IO for the idle-flag and snapshot write. Tests that don't
// touch fs are unaffected. The earlier `mkdirSync: vi.fn()` mock would
// have broken `mkdtempSync` and the snapshot writes.

const { WorkerProcess } = await import('../../../src/daemon/worker-process.js');

let testCtxRoot: string;
let mockEnv: {
  instanceId: string; ctxRoot: string; frameworkRoot: string;
  agentName: string; agentDir: string; org: string; projectRoot: string;
};

beforeEach(() => {
  capturedOnExit = null;
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockInjectMessage.mockClear();
  testCtxRoot = mkdtempSync(join(tmpdir(), 'worker-suspend-test-'));
  mockEnv = {
    instanceId: 'test',
    ctxRoot: testCtxRoot,
    frameworkRoot: '/tmp/fw',
    agentName: 'test-worker',
    agentDir: '/tmp/project',
    org: 'testorg',
    projectRoot: '/tmp/fw',
  };
});

afterEach(() => {
  try { rmSync(testCtxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeIdleFlag(ctxRoot: string, workerName: string, secondsAgo: number = 0) {
  const stateDir = join(ctxRoot, 'state', workerName);
  realMkdirSync(stateDir, { recursive: true });
  const ts = Math.floor(Date.now() / 1000) - secondsAgo;
  realWriteFileSync(join(stateDir, 'last_idle.flag'), String(ts), 'utf-8');
}

describe('WorkerProcess', () => {
  describe('construction', () => {
    it('sets name, dir, parent', () => {
      const w = new WorkerProcess('w1', '/tmp/proj', 'parent-agent');
      expect(w.name).toBe('w1');
      expect(w.dir).toBe('/tmp/proj');
      expect(w.parent).toBe('parent-agent');
    });

    it('parent is optional', () => {
      const w = new WorkerProcess('w2', '/tmp/proj', undefined);
      expect(w.parent).toBeUndefined();
    });
  });

  describe('getStatus', () => {
    it('returns starting status before spawn', () => {
      const w = new WorkerProcess('w3', '/tmp/proj', 'parent');
      const s = w.getStatus();
      expect(s.status).toBe('starting');
      expect(s.name).toBe('w3');
      expect(s.dir).toBe('/tmp/proj');
      expect(s.parent).toBe('parent');
      expect(s.spawnedAt).toBeTruthy();
      expect(s.pid).toBeUndefined();
    });

    it('returns running after spawn', async () => {
      const w = new WorkerProcess('w4', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'do the task');
      expect(w.getStatus().status).toBe('running');
      expect(w.getStatus().pid).toBe(12345);
    });
  });

  describe('isFinished', () => {
    it('is false before spawn', () => {
      const w = new WorkerProcess('w5', '/tmp/proj', undefined);
      expect(w.isFinished()).toBe(false);
    });

    it('is false while running', async () => {
      const w = new WorkerProcess('w6', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      expect(w.isFinished()).toBe(false);
    });

    it('is true after successful exit', async () => {
      const w = new WorkerProcess('w7', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      capturedOnExit!(0);
      expect(w.isFinished()).toBe(true);
    });
  });

  describe('inject', () => {
    it('returns false before spawn', () => {
      const w = new WorkerProcess('w8', '/tmp/proj', undefined);
      expect(w.inject('nudge')).toBe(false);
      expect(mockInjectMessage).not.toHaveBeenCalled();
    });

    it('injects text when running', async () => {
      const w = new WorkerProcess('w9', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      expect(w.inject('continue with phase 3')).toBe(true);
      expect(mockInjectMessage).toHaveBeenCalled();
    });

    it('returns false after exit', async () => {
      const w = new WorkerProcess('w10', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      capturedOnExit!(0);
      expect(w.inject('too late')).toBe(false);
    });
  });

  describe('onDone callback', () => {
    it('fires with exit code 0 and marks completed', async () => {
      const w = new WorkerProcess('w11', '/tmp/proj', undefined);
      const doneSpy = vi.fn();
      w.onDone(doneSpy);
      await w.spawn(mockEnv, 'task');
      capturedOnExit!(0);
      expect(doneSpy).toHaveBeenCalledWith('w11', 0);
      expect(w.getStatus().status).toBe('completed');
      expect(w.getStatus().exitCode).toBe(0);
    });

    it('marks status as failed on non-zero exit', async () => {
      const w = new WorkerProcess('w12', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      capturedOnExit!(1);
      expect(w.getStatus().status).toBe('failed');
      expect(w.getStatus().exitCode).toBe(1);
    });
  });

  describe('terminate', () => {
    it('kills the PTY and marks completed', async () => {
      const w = new WorkerProcess('w13', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      await w.terminate();
      expect(mockPty.kill).toHaveBeenCalled();
      expect(w.getStatus().status).toBe('completed');
    });

    it('is a no-op if not running', async () => {
      const w = new WorkerProcess('w14', '/tmp/proj', undefined);
      await w.terminate(); // should not throw
      expect(mockPty.kill).not.toHaveBeenCalled();
    });
  });

  describe('suspend', () => {
    it('rejects if not running', async () => {
      const w = new WorkerProcess('s1', '/tmp/proj', undefined);
      await expect(w.suspend(1000)).rejects.toThrow(/not in a suspendable state/);
    });

    it('completes via idle when the idle flag updates after suspend starts', async () => {
      const w = new WorkerProcess('s2', '/tmp/proj', 'parent-agent');
      await w.spawn(mockEnv, 'do the chain');
      // Schedule the idle flag to land 200ms after suspend starts.
      setTimeout(() => writeIdleFlag(testCtxRoot, 's2', 0), 200);

      const result = await w.suspend(2000);
      expect(result.reason).toBe('idle');
      expect(w.getStatus().status).toBe('suspended');
      expect(result.path).toContain('snapshots');
      expect(existsSync(result.path)).toBe(true);
      expect(mockPty.kill).toHaveBeenCalled();
    });

    it('falls through to timeout when idle never lands', async () => {
      const w = new WorkerProcess('s3', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'stuck task');
      const result = await w.suspend(300);
      expect(result.reason).toBe('timeout');
      expect(w.getStatus().status).toBe('suspended');
      expect(existsSync(result.path)).toBe(true);
    });

    it('writes a snapshot containing the original prompt', async () => {
      const w = new WorkerProcess('s4', '/tmp/proj', 'parent');
      await w.spawn(mockEnv, 'ORIGINAL_PROMPT_MARKER do the thing');
      const result = await w.suspend(200);
      const snap = require('fs').readFileSync(result.path, 'utf-8');
      expect(snap).toContain('ORIGINAL_PROMPT_MARKER');
      expect(snap).toContain('s4');
      expect(snap).toContain('parent');
    });

    it('rejects double-suspend mid-flight', async () => {
      const w = new WorkerProcess('s5', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      // Start the first suspend but do not await — it sits in the polling loop.
      const firstPromise = w.suspend(2000);
      // Give it one tick to enter `suspending` state.
      await new Promise(r => setTimeout(r, 20));
      await expect(w.suspend(1000)).rejects.toThrow(/already suspending/);
      // Let the first suspend resolve via timeout fallback to clean up.
      await firstPromise;
    });

    it('exit during suspend keeps status suspended (does NOT mark completed)', async () => {
      const w = new WorkerProcess('s6', '/tmp/proj', undefined);
      const doneSpy = vi.fn();
      w.onDone(doneSpy);
      await w.spawn(mockEnv, 'task');

      // Start suspend; while it polls, simulate the PTY exiting.
      const promise = w.suspend(500);
      await new Promise(r => setTimeout(r, 20));
      capturedOnExit!(0);

      await promise;
      expect(w.getStatus().status).toBe('suspended');
      expect(w.isFinished()).toBe(false); // suspended is NOT finished
      expect(doneSpy).not.toHaveBeenCalled(); // no auto-cleanup of registry entry
    });

    it('idempotent on already-suspended (returns prior snapshot)', async () => {
      const w = new WorkerProcess('s7', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      const first = await w.suspend(200);
      const second = await w.suspend(200);
      expect(second.path).toBe(first.path);
      expect(w.getStatus().status).toBe('suspended');
    });

    it('isSuspended reflects the state', async () => {
      const w = new WorkerProcess('s8', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      expect(w.isSuspended()).toBe(false);
      await w.suspend(200);
      expect(w.isSuspended()).toBe(true);
    });

    it('getStatus exposes suspendedAt and snapshotPath after suspend', async () => {
      const w = new WorkerProcess('s9', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      await w.suspend(200);
      const s = w.getStatus();
      expect(s.suspendedAt).toBeTruthy();
      expect(s.snapshotPath).toBeTruthy();
      expect(s.status).toBe('suspended');
    });
  });

  describe('getOriginalPrompt', () => {
    it('returns the spawn prompt', async () => {
      const w = new WorkerProcess('p1', '/tmp/proj', undefined);
      expect(w.getOriginalPrompt()).toBeUndefined();
      await w.spawn(mockEnv, 'spawn-time prompt');
      expect(w.getOriginalPrompt()).toBe('spawn-time prompt');
    });
  });
});
