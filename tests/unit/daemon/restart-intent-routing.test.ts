/**
 * tests/unit/daemon/restart-intent-routing.test.ts — BUG-011.
 *
 * Branch B threading: the IPC restart-agent handler validates intent at the
 * trust boundary and routes it; AgentManager.restartAgent carries it to
 * startAgent. Branch A: the atomic restart op does not trip the start-dedupe
 * race that the old stop+start path hit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ctrl = vi.hoisted(() => ({ rejectStart: false }));
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    constructor(public name: string, public dir: string) {}
    async start() { if (ctrl.rejectStart) throw new Error('start failed (fail-closed test)'); return 'started'; }
    async stop() { return 'stopped'; }
    getStatus() { return { name: this.name, status: 'stopped' }; }
    onExit() {}
    onLifecycleWithhold() {}
    readQuarantineRecord() { return { kind: 'absent' }; }
    isLifecycleWithheld() { return false; }
    isQuarantined() { return false; }
    async forceReap() { return 'gone'; }
  },
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({ FastChecker: class { start() { return Promise.resolve(); } stop() {} wake() {} } }));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class {} }));
vi.mock('../../../src/telegram/poller.js', () => ({ TelegramPoller: class { start() {} stop() {} } }));
vi.mock('../../../src/daemon/cron-migration.js', () => ({ migrateCronsForAgent: vi.fn() }));
vi.mock('../../../src/daemon/cron-scheduler.js', () => ({ CronScheduler: class { start() {} stop() {} reload() {} getNextFireTimes() { return []; } } }));

const { IPCServer } = await import('../../../src/daemon/ipc-server.js');
const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

// ---------------------------------------------------------------------------
// IPC restart-agent handler: validation + routing
// ---------------------------------------------------------------------------
describe('BUG-011 — IPC restart-agent intent validation + routing', () => {
  let restartAgent: ReturnType<typeof vi.fn>;
  let server: InstanceType<typeof IPCServer>;

  beforeEach(() => {
    restartAgent = vi.fn().mockResolvedValue(undefined);
    const mockManager = { inspectAgentOp: vi.fn().mockReturnValue({ ok: true }), restartAgent };
    server = new IPCServer(mockManager as never, 'test');
  });

  function send(req: Record<string, unknown>): { success: boolean; code?: string } {
    const written: string[] = [];
    const socket = { write: (d: string) => { written.push(d); }, end: vi.fn() };
    (server as unknown as { handleRequest: (r: unknown, s: unknown) => void }).handleRequest(req, socket);
    return JSON.parse(written.join(''));
  }

  it('routes a valid intent to restartAgent (regression 1)', () => {
    const resp = send({ type: 'restart-agent', agent: 'alice', intent: 'fresh' });
    expect(resp.success).toBe(true);
    expect(restartAgent).toHaveBeenCalledWith('alice', 'fresh');
  });

  it('missing intent defaults to preserve (regression 9 / back-compat)', () => {
    const resp = send({ type: 'restart-agent', agent: 'alice' });
    expect(resp.success).toBe(true);
    expect(restartAgent).toHaveBeenCalledWith('alice', 'preserve');
  });

  it('rejects an invalid intent with INVALID_INPUT and NO dispatch (regression 14)', () => {
    const resp = send({ type: 'restart-agent', agent: 'alice', intent: 'bogus' });
    expect(resp.success).toBe(false);
    expect(resp.code).toBe('INVALID_INPUT');
    expect(restartAgent).not.toHaveBeenCalled();
  });

  it('accepts all three valid intents', () => {
    for (const intent of ['preserve', 'fresh', 'auto'] as const) {
      restartAgent.mockClear();
      const resp = send({ type: 'restart-agent', agent: 'alice', intent });
      expect(resp.success).toBe(true);
      expect(restartAgent).toHaveBeenCalledWith('alice', intent);
    }
  });
});

// ---------------------------------------------------------------------------
// AgentManager: carries intent + atomic restart avoids the dedupe race
// ---------------------------------------------------------------------------
describe('BUG-011 — AgentManager intent threading + Branch A race', () => {
  let testDir: string;
  let am: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-restart-intent-'));
    mkdirSync(join(testDir, 'framework'), { recursive: true });
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
  });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it('restartAgent carries intent through to startAgent (regression 2)', async () => {
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', {});
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();
    vi.spyOn(am, 'stopAgent').mockResolvedValue('stopped');

    await am.restartAgent('alice', 'fresh');

    expect(startSpy).toHaveBeenCalledWith('alice', '', undefined, undefined, 'fresh');
  });

  it('restartAgent defaults to auto when no intent supplied', async () => {
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', {});
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();
    vi.spyOn(am, 'stopAgent').mockResolvedValue('stopped');

    await am.restartAgent('alice');

    expect(startSpy).toHaveBeenCalledWith('alice', '', undefined, undefined, 'auto');
  });

  it('A2: old stop→auto-respawn→explicit-start DEDUPES; new atomic restart leaves exactly one running agent', async () => {
    const reg = (am as unknown as { agents: Map<string, unknown>; pendingRestarts: Set<string> });
    const fakeProcess = { stop: async () => 'stopped', getStatus: () => ({ status: 'running' }), isLifecycleWithheld: () => false };

    // --- OLD shape (executed): stop, daemon auto-respawn, then explicit start ---
    reg.agents.set('bob', { process: fakeProcess, checker: { stop() {} } });
    await am.stopAgent('bob');                                     // real stopAgent removes bob
    reg.agents.set('bob', { process: fakeProcess, checker: { stop() {} } }); // auto-respawn re-registers
    const sizeBefore = reg.agents.size;
    await am.startAgent('bob', '');                                // OLD explicit start → dedup branch
    expect(reg.pendingRestarts.has('bob')).toBe(true);            // dedup engaged → start became a no-op
    expect(reg.agents.size).toBe(sizeBefore);                     // NO duplicate registered
    expect(am.inspectAgentOp('start', 'bob').ok).toBe(false);     // the CLI-visible DEDUPED failure

    // --- NEW shape (executed): one atomic restart ends with exactly one running agent ---
    const zoeDir = join(testDir, 'framework', 'orgs', 'acme', 'agents', 'zoe');
    mkdirSync(zoeDir, { recursive: true });
    writeFileSync(join(zoeDir, 'config.json'), '{}');
    reg.pendingRestarts.clear();

    await am.startAgent('zoe', zoeDir, {}, 'acme');               // register zoe
    expect(reg.agents.has('zoe')).toBe(true);
    await am.restartAgent('zoe', 'preserve');                    // atomic stop+start, no external start to race

    expect(reg.agents.has('zoe')).toBe(true);                                  // still present + running
    expect([...reg.agents.keys()].filter((k) => k === 'zoe')).toHaveLength(1); // exactly one
    expect(reg.pendingRestarts.has('zoe')).toBe(false);                        // NOT deduped — clean restart
  });

  it('transactional: startAgent rolls back the registry entry if start() rejects (absent/recoverable, not registered-dead)', async () => {
    const reg = (am as unknown as { agents: Map<string, unknown>; pendingRestarts: Set<string>; cronSchedulers: Map<string, unknown> });
    const zoeDir = join(testDir, 'framework', 'orgs', 'acme', 'agents', 'zoe');
    mkdirSync(zoeDir, { recursive: true });
    writeFileSync(join(zoeDir, 'config.json'), '{}');

    ctrl.rejectStart = true;
    await expect(am.startAgent('zoe', zoeDir, {}, 'acme')).rejects.toThrow();

    expect(reg.agents.has('zoe')).toBe(false);                  // rolled back — NOT registered-dead
    expect(reg.pendingRestarts.has('zoe')).toBe(false);
    expect(reg.cronSchedulers.has('zoe')).toBe(false);          // scheduler/checker never started
    expect(am.inspectAgentOp('start', 'zoe')).toEqual({ ok: true }); // recovery start NOT deduped

    // A subsequent (successful) start proceeds normally.
    ctrl.rejectStart = false;
    await am.startAgent('zoe', zoeDir, {}, 'acme');
    expect(reg.agents.has('zoe')).toBe(true);
  });

  it('transactional: restartAgent failure ends absent/recoverable, not registered-stopped', async () => {
    const reg = (am as unknown as { agents: Map<string, unknown> });
    const zoeDir = join(testDir, 'framework', 'orgs', 'acme', 'agents', 'zoe');
    mkdirSync(zoeDir, { recursive: true });
    writeFileSync(join(zoeDir, 'config.json'), '{}');

    await am.startAgent('zoe', zoeDir, {}, 'acme');   // register cleanly
    expect(reg.agents.has('zoe')).toBe(true);

    ctrl.rejectStart = true;
    await expect(am.restartAgent('zoe', 'preserve')).rejects.toThrow();
    expect(reg.agents.has('zoe')).toBe(false);        // stop removed it, start rolled back → absent (recoverable)
    expect(am.inspectAgentOp('start', 'zoe')).toEqual({ ok: true });
    ctrl.rejectStart = false;
  });
});
