/**
 * Unit-test parity for the `cortextos restart <agent>` subcommand.
 *
 * BUG-011 Branch A: `cortextos restart` is now a SINGLE atomic restart-agent
 * IPC (intent=preserve) instead of stop-agent + start-agent. The old pair raced
 * the daemon auto-respawn and tripped the DEDUPED guard. This file pins the
 * command wiring AND the atomic-send behavior (regression A1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture IPC sends + marker writes from the command action.
const ipcSends: Array<Record<string, unknown>> = [];
const markerWrites: Array<{ path: string; data: string }> = [];

vi.mock('../../../src/daemon/ipc-server.js', () => ({
  IPCClient: class {
    isDaemonRunning() { return Promise.resolve(true); }
    send(req: Record<string, unknown>) { ipcSends.push(req); return Promise.resolve({ success: true, data: 'Restarting alice' }); }
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((p: string, data: string) => { markerWrites.push({ path: String(p), data: String(data) }); }),
  };
});

const { restartCommand } = await import('../../../src/cli/restart');

beforeEach(() => { ipcSends.length = 0; markerWrites.length = 0; });

describe('cortextos restart <agent> — command wiring', () => {
  it('is registered as `restart`', () => {
    expect(restartCommand.name()).toBe('restart');
  });

  it('requires the <agent> positional argument', () => {
    const args = (restartCommand as unknown as { registeredArguments: { required: boolean; name: () => string }[] }).registeredArguments;
    expect(args).toHaveLength(1);
    expect(args[0].required).toBe(true);
    expect(args[0].name()).toBe('agent');
  });

  it('accepts --instance with a default of "default"', () => {
    expect(restartCommand.opts().instance).toBe('default');
  });

  it('describes itself as an atomic restart that does NOT bounce the daemon (BUG-011)', () => {
    const desc = restartCommand.description().toLowerCase();
    expect(desc).toContain('atomic');
    expect(desc).toContain('daemon');
    // It must NOT advertise the old stop+start semantics that caused the race.
    expect(desc).not.toMatch(/\bstop \+ start\b|\bstop\+start\b/);
  });
});

describe('cortextos restart <agent> — atomic send (regression A1)', () => {
  it('sends exactly ONE restart-agent IPC with intent=preserve (no stop+start)', async () => {
    await restartCommand.parseAsync(['node', 'restart', 'alice']);

    expect(ipcSends).toHaveLength(1);
    expect(ipcSends[0].type).toBe('restart-agent');
    expect(ipcSends[0].intent).toBe('preserve');
    expect(ipcSends[0].agent).toBe('alice');
    // The old racy pair must be gone.
    expect(ipcSends.some(s => s.type === 'stop-agent')).toBe(false);
    expect(ipcSends.some(s => s.type === 'start-agent')).toBe(false);
  });

  it('writes a .user-restart marker, NOT a .user-stop marker', async () => {
    await restartCommand.parseAsync(['node', 'restart', 'alice']);

    expect(markerWrites.some(w => w.path.endsWith('.user-restart'))).toBe(true);
    expect(markerWrites.some(w => w.path.endsWith('.user-stop'))).toBe(false);
  });
});
