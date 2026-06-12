import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const h = vi.hoisted(() => ({
  exit: null as ((code: number, signal?: number) => void) | null,
  spawn: vi.fn<() => Promise<void>>(),
  kill: vi.fn(),
  checkerStart: vi.fn(() => Promise.resolve()),
  checkerStop: vi.fn(),
  checkerQueue: vi.fn(),
  migrate: vi.fn(),
  schedulerStart: vi.fn(),
  schedulerStop: vi.fn(),
  schedulerReload: vi.fn(),
  pollerStart: vi.fn(() => new Promise<void>(() => {})),
  pollerStop: vi.fn(),
  registerCommands: vi.fn(() => Promise.resolve({ status: 'ok', count: 1 })),
  events: [] as Array<unknown[]>,
  pollers: [] as Array<{ start: () => Promise<void>; stop: () => void; onMessage: (cb: (m: any) => void) => void; onCallback: (cb: (q: any) => void) => void; onReaction: (cb: (r: any) => void) => void; messageCb?: (m: any) => void }>,
  schedulers: [] as Array<{ start: () => void; stop: () => void; reload: () => void; getNextFireTimes: () => unknown[] }>,
}));

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: class {
    spawn() { return h.spawn(); }
    kill(signal?: string) { return h.kill(signal); }
    write() {}
    getPid() { return 4242; }
    isAlive() { return false; }
    onExit(cb: (code: number, signal?: number) => void) { h.exit = cb; }
    getOutputBuffer() { return { isBootstrapped: () => true }; }
  },
}));
vi.mock('../../../src/pty/inject.js', () => ({ injectMessage: vi.fn(), MessageDedup: class { isDuplicate() { return false; } } }));
vi.mock('../../../src/utils/env.js', () => ({ writeCortextosEnv: vi.fn(), resolveEnv: vi.fn() }));
vi.mock('../../../src/bus/reminders.js', () => ({ getOverdueReminders: vi.fn().mockReturnValue([]) }));
vi.mock('../../../src/bus/event.js', () => ({ logEvent: (...args: unknown[]) => h.events.push(args) }));
vi.mock('../../../src/daemon/cron-migration.js', () => ({ migrateCronsForAgent: (...args: unknown[]) => h.migrate(...args) }));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    start() { return h.checkerStart(); }
    stop() { return h.checkerStop(); }
    isDuplicate() { return false; }
    queueTelegramMessage(v: unknown) { h.checkerQueue(v); }
    handleCallback() { return Promise.resolve(); }
    handleActivityCallback() { return Promise.resolve(); }
    static readLastSent() { return null; }
    static formatTelegramTextMessage() { return 'formatted'; }
    static formatTelegramReaction() { return 'reaction'; }
  },
}));
vi.mock('../../../src/daemon/cron-scheduler.js', () => ({
  CronScheduler: class {
    constructor() { h.schedulers.push(this as any); }
    start() { h.schedulerStart(); }
    stop() { h.schedulerStop(); }
    reload() { h.schedulerReload(); }
    getNextFireTimes() { return []; }
  },
}));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class { sendMessage() { return Promise.resolve(); } } }));
vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    lastExitReason = 'running';
    constructor() { h.pollers.push(this as any); }
    start() { return h.pollerStart(); }
    stop() { h.pollerStop(); this.lastExitReason = 'stopped-externally'; }
    onMessage(cb: (m: any) => void) { (this as any).messageCb = cb; }
    onCallback() {}
    onReaction() {}
  },
}));
vi.mock('../../../src/bus/metrics.js', () => ({ collectTelegramCommands: () => [], registerTelegramCommands: (...args: unknown[]) => h.registerCommands(...args) }));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

describe('BUG-011 v8 AgentManager real lifecycle wiring', () => {
  let root: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let agentDir: string;
  let am: InstanceType<typeof AgentManager>;

  const registry = () => (am as unknown as { agents: Map<string, any>; pendingRestarts: Set<string>; cronSchedulers: Map<string, any> });
  const processPrivate = (process: InstanceType<typeof AgentProcess>) => process as unknown as {
    pty: unknown; status: string; quarantined: boolean; stoppedButOwned: boolean;
    resolveStartMode: (intent: string) => string; captureProcStart: (pid: number) => string | null;
    captureBootId: () => string | null; probePid: (pid: number | null) => 'dead' | 'alive' | 'unknown';
  };

  function writeRecord(overrides: Record<string, unknown> = {}) {
    const state = join(ctxRoot, 'state', 'alice');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, '.quarantine.json'), JSON.stringify({
      agent: 'alice', pid: 4242, proc_start: 'proc-token', boot_id: 'boot-token',
      quarantined_at: '2026-06-12T17:00:00.000Z', reason: 'prior degraded child', ...overrides,
    }));
  }

  async function startHealthy() {
    h.spawn.mockResolvedValue(undefined);
    await am.startAgent('alice', agentDir, {}, 'acme');
    return registry().agents.get('alice').process as InstanceType<typeof AgentProcess>;
  }

  function assertPositiveServices() {
    expect(h.migrate).toHaveBeenCalled();
    expect(h.schedulerStart).toHaveBeenCalled();
    expect(h.checkerStart).toHaveBeenCalled();
    expect(h.registerCommands).toHaveBeenCalled();
    expect(h.pollerStart.mock.calls.length).toBeGreaterThanOrEqual(2);
    const entry = registry().agents.get('alice');
    expect(entry.poller).toBeTruthy();
    expect(entry.activityPoller).toBeTruthy();
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bug011-am-'));
    ctxRoot = join(root, 'instance');
    frameworkRoot = join(root, 'framework');
    agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), '{}');
    writeFileSync(join(agentDir, '.env'), 'BOT_TOKEN=123:ABC\nCHAT_ID=456\nALLOWED_USER=789\n');
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'context.json'), JSON.stringify({ orchestrator: 'alice' }));
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'activity-channel.env'), 'ACTIVITY_BOT_TOKEN=999:XYZ\nACTIVITY_CHAT_ID=111\n');
    h.exit = null;
    h.spawn.mockReset().mockResolvedValue(undefined);
    h.kill.mockReset(); h.checkerStart.mockClear(); h.checkerStop.mockClear(); h.checkerQueue.mockClear();
    h.migrate.mockClear(); h.schedulerStart.mockClear(); h.schedulerStop.mockClear(); h.schedulerReload.mockClear();
    h.pollerStart.mockClear(); h.pollerStop.mockClear(); h.registerCommands.mockClear(); h.events.length = 0;
    h.pollers.length = 0; h.schedulers.length = 0;
    am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('6 positive control: healthy start runs every service and retains stoppable poller refs', async () => {
    await startHealthy();
    assertPositiveServices();
    expect(registry().cronSchedulers.has('alice')).toBe(true);
  });

  it('5: initial quarantined start retains one registry entry and withholds the exact service set', async () => {
    h.spawn.mockRejectedValue(new Error('spawn registration failed'));
    vi.spyOn(AgentProcess.prototype as any, 'probePid').mockReturnValue('alive');
    vi.spyOn(AgentProcess.prototype as any, 'captureProcStart').mockReturnValue('proc-token');
    vi.spyOn(AgentProcess.prototype as any, 'captureBootId').mockReturnValue('boot-token');
    await am.startAgent('alice', agentDir, {}, 'acme');
    expect(registry().agents.size).toBe(1);
    expect(registry().agents.get('alice').process.isQuarantined()).toBe(true);
    expect(h.migrate).not.toHaveBeenCalled();
    expect(h.schedulerStart).not.toHaveBeenCalled();
    expect(h.checkerStart).not.toHaveBeenCalled();
    expect(h.registerCommands).not.toHaveBeenCalled();
    expect(h.pollerStart).not.toHaveBeenCalled();
  });

  it('7: initial observed-pid + OS-dead spawn rejection transactionally rolls back', async () => {
    h.spawn.mockRejectedValue(new Error('spawn failed dead'));
    vi.spyOn(AgentProcess.prototype as any, 'probePid').mockReturnValue('dead');
    await expect(am.startAgent('alice', agentDir, {}, 'acme')).rejects.toThrow('spawn failed dead');
    expect(registry().agents.has('alice')).toBe(false);
    expect(h.migrate).not.toHaveBeenCalled();
    expect(h.checkerStart).not.toHaveBeenCalled();
  });

  it('blocker 1 PIN: initial PTY-exit-during-spawn => withheld, NO services against no child, registry retained, recovery not orphaned; restart recovers', async () => {
    vi.useFakeTimers();
    // The child exits DURING the initial spawn (onExit fires before spawn resolves).
    h.spawn.mockImplementation(async () => { h.exit?.(0); });
    await am.startAgent('alice', agentDir, {}, 'acme');   // initial lifecycle, must NOT throw
    // withheld, NOT started: registry retained (one entry), services NOT wired against no child.
    expect(registry().agents.size).toBe(1);
    const process = registry().agents.get('alice').process as InstanceType<typeof AgentProcess>;
    expect(process.isLifecycleWithheld()).toBe(true);
    expect((process as any).established).toBe(false);
    expect(process.getStatus().status).toBe('crashed'); // handleExit's truthful classification
    expect(h.migrate).not.toHaveBeenCalled();
    expect(h.schedulerStart).not.toHaveBeenCalled();
    expect(h.checkerStart).not.toHaveBeenCalled();
    expect(h.registerCommands).not.toHaveBeenCalled();
    expect(h.pollerStart).not.toHaveBeenCalled();
    // handleExit scheduled a recovery; advancing the timer must NOT orphan a process or wire services.
    await vi.advanceTimersByTimeAsync(600000);
    expect(registry().agents.size).toBe(1);
    expect(h.schedulerStart).not.toHaveBeenCalled();
    expect(h.checkerStart).not.toHaveBeenCalled();
    // explicit restart recovers and deliberately re-establishes services through AM.
    h.spawn.mockReset().mockResolvedValue(undefined);
    await am.restartAgent('alice');
    await vi.advanceTimersByTimeAsync(0);
    const recovered = registry().agents.get('alice').process as InstanceType<typeof AgentProcess>;
    expect(recovered.isLifecycleWithheld()).toBe(false);
    expect(recovered.getStatus().status).toBe('running');
    expect(h.migrate).toHaveBeenCalled();
    expect(h.schedulerStart).toHaveBeenCalled();
    expect(h.checkerStart).toHaveBeenCalled();
  });

  it('blocker 1: initial PTY-exit-during-spawn with NO scheduled recovery (halted) stays withheld until explicit restart', async () => {
    vi.useFakeTimers();
    // force the crash-loop window so handleExit halts instead of scheduling a recovery
    h.spawn.mockImplementation(async () => { h.exit?.(0); });
    await am.startAgent('alice', agentDir, { crash_window: { seconds: 60, max_crashes: 1 } }, 'acme');
    expect(registry().agents.size).toBe(1);
    const process = registry().agents.get('alice').process as InstanceType<typeof AgentProcess>;
    expect(process.isLifecycleWithheld()).toBe(true);
    expect(h.schedulerStart).not.toHaveBeenCalled();
    expect(h.checkerStart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600000);
    expect(h.schedulerStart).not.toHaveBeenCalled(); // no auto-recovery
    expect(registry().agents.size).toBe(1);
  });

  it('exit-fix iter-2: in-flight supersede receipt survives an exit-during-spawn withheld start and is cleaned ONLY after the real restart replacement confirms live', async () => {
    vi.useFakeTimers();
    const stateDir = join(ctxRoot, 'state', 'alice');
    mkdirSync(stateDir, { recursive: true });
    const receiptPath = join(stateDir, '.restart-marker-superseded.json');
    const receiptBytes = JSON.stringify({ agent: 'alice', intent: 'preserve', decision: 'continue', marker_conflict: 'superseded', timestamp: '2026-06-12T17:00:00.000Z' });
    writeFileSync(receiptPath, receiptBytes);
    // a VALID in-flight receipt authorizes a preserve->continue recovery (no marker needed for the leftover path)
    vi.spyOn(AgentProcess.prototype as any, 'hasResumableSession').mockReturnValue(true);

    // 1) initial preserve start: resolveStartMode recognizes the receipt (continue), then the PTY exits
    //    DURING spawn => withheld. The receipt MUST be left byte-for-byte intact (not a successful spawn).
    h.spawn.mockImplementation(async () => { h.exit?.(0); });
    await am.startAgent('alice', agentDir, {}, 'acme', 'preserve');
    const withheldProcess = registry().agents.get('alice').process as InstanceType<typeof AgentProcess>;
    expect(withheldProcess.isLifecycleWithheld()).toBe(true);
    expect(existsSync(receiptPath)).toBe(true);                         // receipt NOT cleaned on the withheld terminal
    expect(readFileSync(receiptPath, 'utf-8')).toBe(receiptBytes);      // byte-for-byte intact

    // 2) REAL restartAgent replacement path: stopAgent deletes the old withheld entry and a NEW
    //    AgentProcess is constructed; the receipt is present at replacement spawn and cleaned ONLY after live.
    let receiptPresentAtReplacementSpawn: boolean | null = null;
    h.spawn.mockReset().mockImplementation(async () => { receiptPresentAtReplacementSpawn = existsSync(receiptPath); });
    await am.restartAgent('alice');
    await vi.advanceTimersByTimeAsync(0);
    const replacement = registry().agents.get('alice').process as InstanceType<typeof AgentProcess>;
    expect(replacement).not.toBe(withheldProcess);                     // a genuinely new AgentProcess (real replacement)
    expect(replacement.getStatus().status).toBe('running');
    expect(receiptPresentAtReplacementSpawn).toBe(true);               // present at replacement spawn (pre-live)
    expect(existsSync(receiptPath)).toBe(false);                       // cleaned ONLY after the replacement confirmed live
  });

  it('21c/24 PIN 4+5: real sessionRefresh stopped-but-owned transition tears down positive services and blocks generic start/reload until restart', async () => {
    const process = await startHealthy();
    assertPositiveServices();
    const oldEntry = registry().agents.get('alice');
    const p = processPrivate(process);
    p.pty = null; p.status = 'stopped';
    vi.spyOn(process, 'stop').mockResolvedValue('stopped');
    const mode = vi.spyOn(p, 'resolveStartMode').mockImplementation(() => { throw new Error('pre-spawn fail closed'); });
    await expect(process.sessionRefresh()).rejects.toThrow('pre-spawn fail closed');
    expect(process.isQuarantined()).toBe(false);
    expect(process.isLifecycleWithheld()).toBe(true);
    expect(process.getStatus().status).toBe('stopped');
    expect(registry().agents.get('alice')).toBe(oldEntry);
    expect(h.schedulerStop).toHaveBeenCalled();
    expect(h.checkerStop).toHaveBeenCalled();
    expect(h.pollerStop.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.pollers[0].messageCb).toBeTypeOf('function');
    h.checkerQueue.mockClear();
    h.pollers[0].messageCb!({ text: 'queued after withhold', chat: { id: 1 } });
    expect(h.checkerQueue).not.toHaveBeenCalled();

    const spawnCount = h.spawn.mock.calls.length;
    await am.startAgent('alice', agentDir, {}, 'acme');
    expect(am.reloadCrons('alice')).toBe(false);
    expect(h.spawn).toHaveBeenCalledTimes(spawnCount);
    expect(registry().pendingRestarts.has('alice')).toBe(false);

    mode.mockRestore();
    h.spawn.mockResolvedValue(undefined);
    await am.restartAgent('alice');
    const replacement = registry().agents.get('alice').process;
    expect(replacement).not.toBe(process);
    expect(replacement.isLifecycleWithheld()).toBe(false);
  });

  it('21a PIN 5: real sessionRefresh entering quarantine tears down non-vacuous services', async () => {
    const process = await startHealthy();
    assertPositiveServices();
    const p = processPrivate(process); p.pty = null; p.status = 'stopped';
    vi.spyOn(process, 'stop').mockResolvedValue('stopped');
    h.spawn.mockRejectedValue(new Error('refresh degraded'));
    vi.spyOn(p, 'probePid').mockReturnValue('alive');
    vi.spyOn(p, 'captureProcStart').mockReturnValue('proc-token');
    vi.spyOn(p, 'captureBootId').mockReturnValue('boot-token');
    await expect(process.sessionRefresh()).resolves.toBeUndefined();
    expect(process.isQuarantined()).toBe(true);
    expect(process.isLifecycleWithheld()).toBe(true);
    expect(h.schedulerStop).toHaveBeenCalled();
    expect(h.checkerStop).toHaveBeenCalled();
    expect(h.pollerStop.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('21d PIN 5: real handleExit recovery pre-spawn rejection synchronously tears down non-vacuous services', async () => {
    vi.useFakeTimers();
    const process = await startHealthy();
    assertPositiveServices();
    vi.spyOn(processPrivate(process), 'resolveStartMode').mockImplementation(() => { throw new Error('recovery fail closed'); });
    expect(h.exit).not.toBeNull();
    h.exit!(1, 0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(process.isLifecycleWithheld()).toBe(true);
    expect(process.getStatus().status).toBe('stopped');
    expect(h.schedulerStop).toHaveBeenCalled();
    expect(h.checkerStop).toHaveBeenCalled();
    expect(h.pollerStop.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('21b PIN 5: real handleExit recovery entering quarantine tears down non-vacuous services', async () => {
    vi.useFakeTimers();
    const process = await startHealthy();
    assertPositiveServices();
    h.spawn.mockRejectedValue(new Error('recovery degraded'));
    const p = processPrivate(process);
    vi.spyOn(p, 'probePid').mockReturnValue('alive');
    vi.spyOn(p, 'captureProcStart').mockReturnValue('proc-token');
    vi.spyOn(p, 'captureBootId').mockReturnValue('boot-token');
    h.exit!(1, 0);
    await vi.advanceTimersByTimeAsync(6000);
    expect(process.isQuarantined()).toBe(true);
    expect(process.isLifecycleWithheld()).toBe(true);
    expect(h.schedulerStop).toHaveBeenCalled();
    expect(h.checkerStop).toHaveBeenCalled();
    expect(h.pollerStop.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('21d2: handleExit recovery spawn-reject + OS-dead funnels through stopped-but-owned', async () => {
    vi.useFakeTimers();
    const process = await startHealthy();
    assertPositiveServices();
    h.spawn.mockRejectedValue(new Error('recovery spawn failed'));
    vi.spyOn(processPrivate(process), 'probePid').mockReturnValue('dead');
    h.exit!(1, 0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(process.isQuarantined()).toBe(false);
    expect(process.isLifecycleWithheld()).toBe(true);
    expect(process.getStatus().status).toBe('stopped');
    expect(h.schedulerStop).toHaveBeenCalled();
  });

  it('21c2: sessionRefresh spawn-reject + OS-dead funnels through stopped-but-owned', async () => {
    const process = await startHealthy();
    assertPositiveServices();
    const p = processPrivate(process); p.pty = null; p.status = 'stopped';
    vi.spyOn(process, 'stop').mockResolvedValue('stopped');
    h.spawn.mockRejectedValue(new Error('refresh spawn failed'));
    vi.spyOn(p, 'probePid').mockReturnValue('dead');
    await expect(process.sessionRefresh()).rejects.toThrow('refresh spawn failed');
    expect(process.isQuarantined()).toBe(false);
    expect(process.isLifecycleWithheld()).toBe(true);
    expect(h.schedulerStop).toHaveBeenCalled();
  });

  it('22 PIN 5: one teardown failure does not block the remaining real services', async () => {
    const process = await startHealthy();
    assertPositiveServices();
    h.schedulerStop.mockImplementationOnce(() => { throw new Error('scheduler stop boom'); });
    const p = processPrivate(process); p.pty = null; p.status = 'stopped';
    vi.spyOn(process, 'stop').mockResolvedValue('stopped');
    vi.spyOn(p, 'resolveStartMode').mockImplementation(() => { throw new Error('withhold trigger'); });
    await expect(process.sessionRefresh()).rejects.toThrow('withhold trigger');
    expect(h.checkerStop).toHaveBeenCalled();
    expect(h.pollerStop.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(registry().agents.has('alice')).toBe(true);
    expect(h.events.some(call => call[4] === 'lifecycle_withhold_teardown_failed')).toBe(true);
  });

  it.each(['quarantined', 'stopped-but-owned'] as const)('13/14 PIN 4: generic start and reload remain blocked for %s entries', async (state) => {
    let process: InstanceType<typeof AgentProcess>;
    if (state === 'quarantined') {
      h.spawn.mockRejectedValue(new Error('degraded'));
      vi.spyOn(AgentProcess.prototype as any, 'probePid').mockReturnValue('alive');
      vi.spyOn(AgentProcess.prototype as any, 'captureProcStart').mockReturnValue('proc-token');
      vi.spyOn(AgentProcess.prototype as any, 'captureBootId').mockReturnValue('boot-token');
      await am.startAgent('alice', agentDir, {}, 'acme');
      process = registry().agents.get('alice').process;
    } else {
      process = await startHealthy();
      const p = processPrivate(process); p.pty = null; p.status = 'stopped';
      vi.spyOn(process, 'stop').mockResolvedValue('stopped');
      vi.spyOn(p, 'resolveStartMode').mockImplementation(() => { throw new Error('stop-owned'); });
      await expect(process.sessionRefresh()).rejects.toThrow('stop-owned');
    }
    const spawnCount = h.spawn.mock.calls.length;
    await am.startAgent('alice', agentDir, {}, 'acme');
    expect(am.reloadCrons('alice')).toBe(false);
    expect(h.spawn).toHaveBeenCalledTimes(spawnCount);
    expect(registry().pendingRestarts.has('alice')).toBe(false);
    expect(process.isLifecycleWithheld()).toBe(true);
  });

  it('8a: tracked quarantine exit remains registered stopped-but-owned and generic start/reload stay blocked', async () => {
    h.spawn.mockRejectedValue(new Error('degraded'));
    vi.spyOn(AgentProcess.prototype as any, 'probePid').mockReturnValue('alive');
    vi.spyOn(AgentProcess.prototype as any, 'captureProcStart').mockReturnValue('proc-token');
    vi.spyOn(AgentProcess.prototype as any, 'captureBootId').mockReturnValue('boot-token');
    await am.startAgent('alice', agentDir, {}, 'acme');
    const process = registry().agents.get('alice').process as InstanceType<typeof AgentProcess>;
    h.exit!(1, 0);
    expect(process.isQuarantined()).toBe(false);
    expect(process.isLifecycleWithheld()).toBe(true);
    expect(registry().agents.has('alice')).toBe(true);
    const spawnCount = h.spawn.mock.calls.length;
    await am.startAgent('alice', agentDir, {}, 'acme');
    expect(am.reloadCrons('alice')).toBe(false);
    expect(h.spawn).toHaveBeenCalledTimes(spawnCount);
  });

  it('11: restartAgent on reapable quarantine deletes ownership entry and clean-spawns one healthy replacement', async () => {
    h.spawn.mockRejectedValue(new Error('degraded'));
    vi.spyOn(AgentProcess.prototype as any, 'probePid').mockReturnValue('alive');
    vi.spyOn(AgentProcess.prototype as any, 'captureProcStart').mockReturnValue('proc-token');
    vi.spyOn(AgentProcess.prototype as any, 'captureBootId').mockReturnValue('boot-token');
    await am.startAgent('alice', agentDir, {}, 'acme');
    const process = registry().agents.get('alice').process as InstanceType<typeof AgentProcess>;
    vi.spyOn(processPrivate(process), 'probePid').mockReturnValueOnce('alive').mockReturnValue('dead');
    h.spawn.mockResolvedValue(undefined);
    await am.restartAgent('alice');
    expect(registry().agents.size).toBe(1);
    expect(registry().agents.get('alice').process).not.toBe(process);
    expect(registry().agents.get('alice').process.isLifecycleWithheld()).toBe(false);
  });

  it('24: failed explicit replacement leaves a stopped-but-owned lifecycle absent, never guard-cleared in place', async () => {
    const process = await startHealthy();
    const p = processPrivate(process); p.pty = null; p.status = 'stopped';
    vi.spyOn(process, 'stop').mockResolvedValue('stopped');
    const mode = vi.spyOn(p, 'resolveStartMode').mockImplementation(() => { throw new Error('owned transition'); });
    await expect(process.sessionRefresh()).rejects.toThrow('owned transition');
    mode.mockRestore();
    h.spawn.mockRejectedValue(new Error('replacement dead'));
    vi.spyOn(AgentProcess.prototype as any, 'probePid').mockReturnValue('dead');
    await expect(am.restartAgent('alice')).rejects.toThrow('replacement dead');
    expect(registry().agents.has('alice')).toBe(false);
    expect(process.isLifecycleWithheld()).toBe(true);
  });

  it('10/9.1: unreapable stop/restart retains registry and fails closed', async () => {
    h.spawn.mockRejectedValue(new Error('degraded'));
    vi.spyOn(AgentProcess.prototype as any, 'probePid').mockReturnValue('alive');
    vi.spyOn(AgentProcess.prototype as any, 'captureProcStart').mockReturnValue('proc-token');
    vi.spyOn(AgentProcess.prototype as any, 'captureBootId').mockReturnValue('boot-token');
    await am.startAgent('alice', agentDir, {}, 'acme');
    const process = registry().agents.get('alice').process as InstanceType<typeof AgentProcess>;
    vi.spyOn(process, 'forceReap').mockResolvedValue('unreapable');
    const spawnCount = h.spawn.mock.calls.length;
    await am.restartAgent('alice');
    expect(registry().agents.get('alice').process).toBe(process);
    expect(h.spawn).toHaveBeenCalledTimes(spawnCount);
  });

  it('12: same-boot equal identity cold-start adopts exactly one record-backed quarantine and never spawns', async () => {
    writeRecord();
    vi.spyOn(AgentProcess.prototype as any, 'captureBootId').mockReturnValue('boot-token');
    vi.spyOn(AgentProcess.prototype as any, 'probePid').mockReturnValue('alive');
    vi.spyOn(AgentProcess.prototype as any, 'captureProcStart').mockReturnValue('proc-token');
    await am.startAgent('alice', agentDir, {}, 'acme');
    expect(registry().agents.size).toBe(1);
    const process = registry().agents.get('alice').process;
    expect(process.isQuarantined()).toBe(true);
    expect(process.getStatus()).toMatchObject({ status: 'quarantined', pid: 4242, quarantineDurable: true });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.checkerStart).not.toHaveBeenCalled();
  });

  it('12: unknown cold-start identity adopts fail-closed and emits unknown', async () => {
    writeRecord();
    vi.spyOn(AgentProcess.prototype as any, 'captureBootId').mockReturnValue('boot-token');
    vi.spyOn(AgentProcess.prototype as any, 'probePid').mockReturnValue('unknown');
    await am.startAgent('alice', agentDir, {}, 'acme');
    expect(registry().agents.get('alice').process.isQuarantined()).toBe(true);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.events.some(call => call[4] === 'quarantine_record_unknown')).toBe(true);
  });

  it.each([
    ['reboot', 'other-boot', 'proc-token'],
    ['pid reuse', 'boot-token', 'squatter-token'],
  ])('12: %s clears stale record and normal-spawns without killing a squatter', async (_label, boot, proc) => {
    writeRecord();
    vi.spyOn(AgentProcess.prototype as any, 'captureBootId').mockReturnValue(boot);
    vi.spyOn(AgentProcess.prototype as any, 'probePid').mockReturnValue('alive');
    vi.spyOn(AgentProcess.prototype as any, 'captureProcStart').mockReturnValue(proc);
    await am.startAgent('alice', agentDir, {}, 'acme');
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.kill).not.toHaveBeenCalled();
    expect(existsSync(join(ctxRoot, 'state', 'alice', '.quarantine.json'))).toBe(false);
  });

  it('12: OS-dead recorded pid clears record and normal-spawns', async () => {
    writeRecord();
    vi.spyOn(AgentProcess.prototype as any, 'probePid').mockReturnValue('dead');
    await am.startAgent('alice', agentDir, {}, 'acme');
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(existsSync(join(ctxRoot, 'state', 'alice', '.quarantine.json'))).toBe(false);
  });

  it('PIN 3: cold-start stale-record delete failure refuses replacement and emits loudly', async () => {
    writeRecord();
    vi.spyOn(AgentProcess.prototype as any, 'probePid').mockReturnValue('dead');
    vi.spyOn(AgentProcess.prototype as any, 'clearQuarantineRecordForReplacement').mockReturnValue(false);
    await am.startAgent('alice', agentDir, {}, 'acme');
    expect(h.spawn).not.toHaveBeenCalled();
    expect(registry().agents.has('alice')).toBe(false);
    expect(h.events.some(call => call[4] === 'quarantine_record_cleanup_failed')).toBe(true);
  });

  it.each([{ extra: true }, { agent: 'foreign' }, { reason: undefined }])('12: malformed/foreign/missing/extra-key record fails closed with no spawn and no registry', async (invalid) => {
    writeRecord(invalid);
    await am.startAgent('alice', agentDir, {}, 'acme');
    expect(h.spawn).not.toHaveBeenCalled();
    expect(registry().agents.has('alice')).toBe(false);
    expect(h.events.some(call => call[4] === 'agent_quarantine_record_invalid')).toBe(true);
  });

  it('17: stopAll reaps quarantined children before ordinary stop and clears registry', async () => {
    h.spawn.mockRejectedValue(new Error('degraded'));
    vi.spyOn(AgentProcess.prototype as any, 'probePid').mockReturnValue('alive');
    vi.spyOn(AgentProcess.prototype as any, 'captureProcStart').mockReturnValue('proc-token');
    vi.spyOn(AgentProcess.prototype as any, 'captureBootId').mockReturnValue('boot-token');
    await am.startAgent('alice', agentDir, {}, 'acme');
    const process = registry().agents.get('alice').process as InstanceType<typeof AgentProcess>;
    (process as any).quarantineDurable = false; // durable and undurable quarantines share graceful reap
    vi.spyOn(process, 'forceReap').mockImplementation(async () => {
      const p = processPrivate(process); p.quarantined = false; p.stoppedButOwned = false; p.pty = null; p.status = 'stopped';
      return 'reaped';
    });
    await am.stopAll();
    expect(process.forceReap).toHaveBeenCalled();
    expect(registry().agents.has('alice')).toBe(false);
  });

  it('17: stopAll surfaces unreapable quarantine loudly and still resolves', async () => {
    h.spawn.mockRejectedValue(new Error('degraded'));
    vi.spyOn(AgentProcess.prototype as any, 'probePid').mockReturnValue('alive');
    vi.spyOn(AgentProcess.prototype as any, 'captureProcStart').mockReturnValue('proc-token');
    vi.spyOn(AgentProcess.prototype as any, 'captureBootId').mockReturnValue('boot-token');
    await am.startAgent('alice', agentDir, {}, 'acme');
    const process = registry().agents.get('alice').process as InstanceType<typeof AgentProcess>;
    vi.spyOn(process, 'forceReap').mockResolvedValue('unreapable');
    await expect(am.stopAll()).resolves.toBeUndefined();
    expect(registry().agents.has('alice')).toBe(true);
    expect(h.events.some(call => call[4] === 'agent_reap_failed' && (call[6] as any).source === 'stopAll')).toBe(true);
  });
});
