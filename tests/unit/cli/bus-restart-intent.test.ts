/**
 * tests/unit/cli/bus-restart-intent.test.ts — BUG-011 finding 4 (caller paths).
 *
 * The bus restart commands must send the correct RestartIntent on the
 * restart-agent IPC: self-restart / soft-restart / soft-restart-all => preserve,
 * hard-restart => fresh. Mocks IPCClient (captures sends) + fs (no-op marker
 * writes + an enabled-agents.json fixture); env/paths/system run for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sends: Array<Record<string, unknown>> = [];

vi.mock('../../../src/daemon/ipc-server.js', () => ({
  IPCClient: class {
    isDaemonRunning() { return Promise.resolve(true); }
    send(req: Record<string, unknown>) { sends.push(req); return Promise.resolve({ success: true, data: 'ok' }); }
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    existsSync: (p: unknown) => (String(p).endsWith('enabled-agents.json') ? true : (actual.existsSync as (x: unknown) => boolean)(p)),
    readFileSync: (p: unknown, ...rest: unknown[]) =>
      String(p).endsWith('enabled-agents.json')
        ? JSON.stringify({ coder: { enabled: true, org: 'cortex' } })
        : (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest),
  };
});

const { busCommand } = await import('../../../src/cli/bus');

const realExit = process.exit;
beforeEach(() => {
  sends.length = 0;
  // A command that hits process.exit on the happy path is a test failure, not a
  // runner kill — surface it.
  (process as unknown as { exit: (c?: number) => never }).exit = ((code?: number) => {
    throw new Error(`unexpected process.exit(${code})`);
  }) as never;
});
afterEach(() => { (process as unknown as { exit: typeof realExit }).exit = realExit; });

function lastRestartSend() {
  return sends.filter(s => s.type === 'restart-agent').at(-1);
}

describe('BUG-011 — bus restart commands send the correct intent', () => {
  it('self-restart => preserve', async () => {
    await busCommand.parseAsync(['node', 'bus', 'self-restart']);
    expect(lastRestartSend()?.intent).toBe('preserve');
  });

  it('soft-restart => preserve', async () => {
    await busCommand.parseAsync(['node', 'bus', 'soft-restart', 'coder']);
    expect(lastRestartSend()?.intent).toBe('preserve');
  });

  it('soft-restart-all => preserve', async () => {
    await busCommand.parseAsync(['node', 'bus', 'soft-restart-all', '--stagger', '0']);
    const restartSends = sends.filter(s => s.type === 'restart-agent');
    expect(restartSends.length).toBeGreaterThan(0);
    expect(restartSends.every(s => s.intent === 'preserve')).toBe(true);
  });

  it('hard-restart => fresh', async () => {
    await busCommand.parseAsync(['node', 'bus', 'hard-restart']);
    expect(lastRestartSend()?.intent).toBe('fresh');
  });
});
