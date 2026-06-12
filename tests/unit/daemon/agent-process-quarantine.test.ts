import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const h = vi.hoisted(() => ({
  exit: null as ((code: number, signal?: number) => void) | null,
  events: [] as Array<unknown[]>,
  spawn: vi.fn<() => Promise<void>>(),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn<() => number | null>(),
  isAlive: vi.fn(),
}));

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: class {
    spawn() { return h.spawn(); }
    kill(signal?: string) { return h.kill(signal); }
    write(data: string) { return h.write(data); }
    getPid() { return h.getPid(); }
    isAlive() { return h.isAlive(); }
    onExit(cb: (code: number, signal?: number) => void) { h.exit = cb; }
    getOutputBuffer() { return { isBootstrapped: () => true }; }
  },
}));
vi.mock('../../../src/pty/inject.js', () => ({ injectMessage: vi.fn(), MessageDedup: class { isDuplicate() { return false; } } }));
vi.mock('../../../src/utils/env.js', () => ({ writeCortextosEnv: vi.fn() }));
vi.mock('../../../src/bus/reminders.js', () => ({ getOverdueReminders: vi.fn().mockReturnValue([]) }));
vi.mock('../../../src/bus/event.js', () => ({ logEvent: (...args: unknown[]) => h.events.push(args) }));
vi.mock('../../../src/utils/paths.js', () => ({ resolvePaths: () => ({ stateDir: '/tmp/state', logDir: '/tmp/logs', analyticsDir: '/tmp/analytics' }) }));

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

describe('BUG-011 v8 AgentProcess quarantine contract', () => {
  let root: string;
  let ap: InstanceType<typeof AgentProcess>;

  const priv = () => ap as unknown as {
    pty: unknown;
    status: string;
    quarantineIdentity: unknown;
    resolveStartMode: (intent: string) => string;
    probePid: (pid: number | null) => 'dead' | 'alive' | 'unknown';
    captureProcStart: (pid: number) => string | null;
    captureBootId: () => string | null;
    parseLinuxProcStat: (stat: string) => string | null;
    identityPlatform: () => NodeJS.Platform;
    runIdentityCommand: (command: string, args: string[], env?: NodeJS.ProcessEnv) => string;
    writeAtomicQuarantineRecord: (path: string, data: string) => void;
    deleteQuarantineRecord: (context: string) => boolean;
    clearSessionTimer: () => void;
  };

  function makeAgent() {
    return new AgentProcess('alice', {
      instanceId: 'test', ctxRoot: root, frameworkRoot: root, agentName: 'alice',
      agentDir: join(root, 'agent'), org: 'acme', projectRoot: root,
    }, { max_session_seconds: 999999 });
  }

  function identitySpies(agent = ap) {
    const p = agent as unknown as { captureProcStart: (pid: number) => string | null; captureBootId: () => string | null };
    vi.spyOn(p, 'captureProcStart').mockReturnValue('proc-token');
    vi.spyOn(p, 'captureBootId').mockReturnValue('boot-token');
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bug011-ap-'));
    h.exit = null;
    h.events.length = 0;
    h.spawn.mockReset().mockResolvedValue(undefined);
    h.kill.mockReset();
    h.write.mockReset();
    h.getPid.mockReset().mockReturnValue(4242);
    h.isAlive.mockReset().mockReturnValue(false);
    ap = makeAgent();
  });

  afterEach(() => {
    try { priv().clearSessionTimer(); } catch { /* no-op */ }
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('1/19: observed pid + OS-dead spawn rejection uses the sole clean rejection path', async () => {
    h.spawn.mockRejectedValue(new Error('spawn failed'));
    const probe = vi.spyOn(priv(), 'probePid').mockReturnValue('dead');
    await expect(ap.start()).rejects.toThrow('spawn failed');
    expect(h.kill).toHaveBeenCalledWith('SIGKILL');
    expect(probe).toHaveBeenCalledWith(4242);
    expect(ap.isLifecycleWithheld()).toBe(false);
  });

  it.each(['alive', 'unknown'] as const)('2/3/19: %s observed pid quarantines, retains handle, and persists exact schema', async (liveness) => {
    h.spawn.mockRejectedValue(new Error('registration failed'));
    vi.spyOn(priv(), 'probePid').mockReturnValue(liveness);
    identitySpies();
    await expect(ap.start()).resolves.toBe('quarantined');
    expect(h.kill).toHaveBeenCalledTimes(5);
    expect(priv().pty).not.toBeNull();
    expect(ap.getStatus()).toMatchObject({ status: 'quarantined', pid: 4242, quarantineDurable: true });
    const record = JSON.parse(readFileSync(join(root, 'state', 'alice', '.quarantine.json'), 'utf-8'));
    expect(Object.keys(record)).toEqual(['agent', 'pid', 'proc_start', 'boot_id', 'quarantined_at', 'reason']);
    expect(record).toMatchObject({ agent: 'alice', pid: 4242, proc_start: 'proc-token', boot_id: 'boot-token', reason: 'registration failed' });
    expect(h.events.some(call => call[4] === 'agent_quarantined')).toBe(true);
    expect(h.events.some(call => call[4] === 'lifecycle_withheld' && (call[6] as any).reason === 'quarantined')).toBe(true);
  });

  it('4/15/23: no observed pid becomes undurable quarantine and getStatus never throws', async () => {
    h.spawn.mockRejectedValue(new Error('lost child handle'));
    h.getPid.mockReturnValue(null);
    vi.spyOn(priv(), 'probePid').mockReturnValue('unknown');
    identitySpies();
    await expect(ap.start()).resolves.toBe('quarantined');
    expect(ap.getStatus()).toMatchObject({ status: 'quarantined', pid: undefined, quarantineDurable: false });
    expect(existsSync(join(root, 'state', 'alice', '.quarantine.json'))).toBe(false);
    expect(h.events.some(call => call[4] === 'quarantine_undurable')).toBe(true);
  });

  it('23: broken getPid falls back to the captured quarantine identity', async () => {
    h.spawn.mockRejectedValue(new Error('degraded'));
    vi.spyOn(priv(), 'probePid').mockReturnValue('alive');
    identitySpies();
    await ap.start();
    h.getPid.mockImplementation(() => { throw new Error('broken getter'); });
    expect(() => ap.getStatus()).not.toThrow();
    expect(ap.getStatus()).toMatchObject({ status: 'quarantined', pid: 4242, quarantineDurable: true });
  });

  it('20 PIN 2: attached alive child quarantines BEFORE any mutating mode resolution (no marker/receipt consume)', async () => {
    await ap.start();              // establish a live attached PTY
    priv().status = 'stopped';     // non-running but still attached (BUG-040 window)
    vi.spyOn(priv(), 'probePid').mockReturnValue('alive');
    identitySpies();
    // resolveStartMode is the mutating step (consumes .force-fresh, writes/deletes
    // the supersede receipt). Blocker 2: it must NEVER run for an attached live child.
    const resolveSpy = vi.spyOn(priv(), 'resolveStartMode');
    h.spawn.mockClear();
    await expect(ap.start()).resolves.toBe('quarantined');
    expect(resolveSpy).not.toHaveBeenCalled();   // no mutation of any start artifact
    expect(h.spawn).not.toHaveBeenCalled();        // no replacement spawn
    const record = JSON.parse(readFileSync(join(root, 'state', 'alice', '.quarantine.json'), 'utf-8'));
    expect(record.reason).toMatch(/attached PTY is alive/i); // generic non-mutating diagnostic
  });

  it('20 PIN 2: attached unknown child also quarantines before mode resolution', async () => {
    await ap.start();
    priv().status = 'stopped';
    vi.spyOn(priv(), 'probePid').mockReturnValue('unknown');
    identitySpies();
    const resolveSpy = vi.spyOn(priv(), 'resolveStartMode');
    h.spawn.mockClear();
    await expect(ap.start()).resolves.toBe('quarantined');
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('20 PIN 2: attached alive child leaves a REAL .force-fresh marker AND valid receipt byte-for-byte unchanged', async () => {
    await ap.start();
    priv().status = 'stopped';
    vi.spyOn(priv(), 'probePid').mockReturnValue('alive');
    identitySpies();
    // real start artifacts on disk (ctxRoot-based) that resolveStartMode would otherwise consume/mutate
    const stateDir = join(root, 'state', 'alice');
    mkdirSync(stateDir, { recursive: true });
    const markerPath = join(stateDir, '.force-fresh');
    const receiptPath = join(stateDir, '.restart-marker-superseded.json');
    const markerBytes = 'arming-restart-id-xyz\n';
    const receiptBytes = JSON.stringify({ agent: 'alice', intent: 'preserve', decision: 'continue', marker_conflict: 'superseded', timestamp: '2026-06-12T17:00:00.000Z' });
    writeFileSync(markerPath, markerBytes);
    writeFileSync(receiptPath, receiptBytes);
    h.spawn.mockClear();
    await expect(ap.start()).resolves.toBe('quarantined');
    expect(h.spawn).not.toHaveBeenCalled();
    // quarantine happened BEFORE any mode resolution => both artifacts are byte-for-byte intact
    expect(readFileSync(markerPath, 'utf-8')).toBe(markerBytes);
    expect(readFileSync(receiptPath, 'utf-8')).toBe(receiptBytes);
  });

  it('20 PIN 2: attached OS-dead handle is detached before the clean rejection escapes', async () => {
    await ap.start();
    priv().status = 'stopped';
    vi.spyOn(priv(), 'probePid').mockReturnValue('dead');
    vi.spyOn(priv(), 'resolveStartMode').mockImplementation(() => { throw new Error('pre-spawn fail'); });
    await expect(ap.start()).rejects.toThrow('pre-spawn fail');
    expect(priv().pty).toBeNull();
  });

  it('blocker 1: PTY exits during spawn => returns withheld (not started), established stays false, status truthful', async () => {
    vi.useFakeTimers();
    try {
      // spawn resolves, but the child exits DURING spawn (onExit fires) before it settles;
      // handleExit nulls this.pty and classifies the exit (status -> crashed, schedules recovery).
      h.spawn.mockImplementation(async () => { h.exit?.(0); });
      const outcome = await ap.start();
      expect(outcome).toBe('withheld');                 // NOT 'started'
      expect(priv().pty).toBeNull();                    // no live child
      expect((ap as unknown as { established: boolean }).established).toBe(false); // never established
      expect(ap.isLifecycleWithheld()).toBe(true);      // services withheld, registry retained
      expect(ap.getStatus().status).toBe('crashed');    // handleExit's truthful classification, not overridden
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('blocker 1: the handleExit recovery scheduled during exit-in-spawn is neutralized by the withhold guard (no orphan)', async () => {
    vi.useFakeTimers();
    try {
      h.spawn.mockImplementation(async () => { h.exit?.(0); });
      const startSpy = vi.spyOn(ap, 'start');
      await ap.start();                 // -> withheld, a recovery setTimeout was scheduled by handleExit
      startSpy.mockClear();
      h.spawn.mockReset().mockResolvedValue(undefined); // a recovery, if it fired, would now succeed
      await vi.advanceTimersByTimeAsync(600000); // advance past any backoff
      expect(startSpy).not.toHaveBeenCalled();   // recovery neutralized by isLifecycleWithheld guard => no orphan
      expect(ap.isLifecycleWithheld()).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('21/24: established pre-spawn rejection becomes stopped-but-owned before rejection escapes', async () => {
    await ap.start();
    priv().pty = null;
    priv().status = 'stopped';
    let callbackObservedWithheld = false;
    ap.onLifecycleWithhold(() => { callbackObservedWithheld = ap.isLifecycleWithheld(); });
    vi.spyOn(priv(), 'resolveStartMode').mockImplementation(() => { throw new Error('receipt invalid'); });
    await expect(ap.start()).rejects.toThrow('receipt invalid');
    expect(callbackObservedWithheld).toBe(true);
    expect(ap.isQuarantined()).toBe(false);
    expect(ap.isLifecycleWithheld()).toBe(true);
    expect(ap.getStatus().status).toBe('stopped');
  });

  it('21c2/d2: established spawn-reject + OS-dead also becomes stopped-but-owned', async () => {
    await ap.start();
    priv().pty = null;
    priv().status = 'stopped';
    h.spawn.mockRejectedValue(new Error('second spawn failed'));
    vi.spyOn(priv(), 'probePid').mockReturnValue('dead');
    await expect(ap.start()).rejects.toThrow('second spawn failed');
    expect(ap.isQuarantined()).toBe(false);
    expect(ap.isLifecycleWithheld()).toBe(true);
    expect(ap.getStatus().status).toBe('stopped');
  });

  it('8/8a: tracked quarantined exit clears record then transitions to stopped-but-owned without restart', async () => {
    h.spawn.mockRejectedValue(new Error('degraded'));
    vi.spyOn(priv(), 'probePid').mockReturnValue('alive');
    identitySpies();
    await ap.start();
    const startSpy = vi.spyOn(ap, 'start');
    expect(h.exit).not.toBeNull();
    h.exit!(1, 0);
    expect(ap.isQuarantined()).toBe(false);
    expect(ap.isLifecycleWithheld()).toBe(true);
    expect(ap.getStatus().status).toBe('stopped');
    expect(existsSync(join(root, 'state', 'alice', '.quarantine.json'))).toBe(false);
    expect(startSpy).not.toHaveBeenCalled();
    expect(h.events.some(call => call[4] === 'lifecycle_withheld' && (call[6] as any).reason === 'quarantine-exited')).toBe(true);
  });

  it('9: forceReap verifies identity, SIGKILLs, proves ESRCH, and never waits for exitPromise', async () => {
    h.spawn.mockRejectedValue(new Error('degraded'));
    const probe = vi.spyOn(priv(), 'probePid').mockReturnValue('alive');
    identitySpies();
    await ap.start();
    probe.mockReset().mockReturnValueOnce('alive').mockReturnValue('dead');
    await expect(ap.forceReap()).resolves.toBe('reaped');
    expect(h.kill).toHaveBeenLastCalledWith('SIGKILL');
    expect(ap.isLifecycleWithheld()).toBe(false);
    expect(existsSync(join(root, 'state', 'alice', '.quarantine.json'))).toBe(false);
  });

  it('9: stop routes quarantined ownership through forceReap and returns typed stopped', async () => {
    h.spawn.mockRejectedValue(new Error('degraded'));
    vi.spyOn(priv(), 'probePid').mockReturnValue('alive');
    identitySpies();
    await ap.start();
    const reap = vi.spyOn(ap, 'forceReap').mockResolvedValue('gone');
    await expect(ap.stop()).resolves.toBe('stopped');
    expect(reap).toHaveBeenCalledTimes(1);
  });

  it('10: forceReap staying alive is unreapable, loud, and remains quarantined', async () => {
    h.spawn.mockRejectedValue(new Error('degraded'));
    vi.spyOn(priv(), 'probePid').mockReturnValue('alive');
    identitySpies();
    await ap.start();
    await expect(ap.forceReap()).resolves.toBe('unreapable');
    expect(ap.isQuarantined()).toBe(true);
    expect(ap.getStatus().status).toBe('quarantined');
    expect(h.events.some(call => call[4] === 'agent_reap_failed')).toBe(true);
  });

  it('16: proc-start mismatch means gone and never kills a squatter', async () => {
    h.spawn.mockRejectedValue(new Error('degraded'));
    vi.spyOn(priv(), 'probePid').mockReturnValue('alive');
    const proc = vi.spyOn(priv(), 'captureProcStart').mockReturnValue('owned-token');
    vi.spyOn(priv(), 'captureBootId').mockReturnValue('boot-token');
    await ap.start();
    h.kill.mockClear();
    proc.mockReturnValue('squatter-token');
    await expect(ap.forceReap()).resolves.toBe('gone');
    expect(h.kill).not.toHaveBeenCalled();
    expect(ap.isLifecycleWithheld()).toBe(false);
  });

  it('16: boot identity mismatch means gone and never dispatches SIGKILL', async () => {
    h.spawn.mockRejectedValue(new Error('degraded'));
    vi.spyOn(priv(), 'probePid').mockReturnValue('alive');
    const boot = vi.spyOn(priv(), 'captureBootId').mockReturnValue('owned-boot');
    vi.spyOn(priv(), 'captureProcStart').mockReturnValue('proc-token');
    await ap.start();
    h.kill.mockClear();
    boot.mockReturnValue('new-boot');
    await expect(ap.forceReap()).resolves.toBe('gone');
    expect(h.kill).not.toHaveBeenCalled();
  });

  it('16: missing identity refuses SIGKILL and remains unreapable', async () => {
    h.spawn.mockRejectedValue(new Error('lost pid'));
    h.getPid.mockReturnValue(null);
    vi.spyOn(priv(), 'probePid').mockReturnValue('unknown');
    identitySpies();
    await ap.start();
    h.kill.mockClear();
    await expect(ap.forceReap()).resolves.toBe('unreapable');
    expect(h.kill).not.toHaveBeenCalled();
  });

  it('15: persistent atomic-write failure retries exactly three times and reports undurable ownership', async () => {
    h.spawn.mockRejectedValue(new Error('degraded'));
    vi.spyOn(priv(), 'probePid').mockReturnValue('alive');
    identitySpies();
    const write = vi.spyOn(priv(), 'writeAtomicQuarantineRecord').mockImplementation(() => { throw new Error('disk full'); });
    await expect(ap.start()).resolves.toBe('quarantined');
    expect(write).toHaveBeenCalledTimes(3);
    expect(ap.getStatus()).toMatchObject({ status: 'quarantined', quarantineDurable: false });
    expect(h.events.some(call => call[4] === 'quarantine_undurable')).toBe(true);
  });

  it('PIN 3: tracked-exit record-delete failure stays quarantined and emits a loud failure', async () => {
    h.spawn.mockRejectedValue(new Error('degraded'));
    vi.spyOn(priv(), 'probePid').mockReturnValue('alive');
    identitySpies();
    await ap.start();
    vi.spyOn(priv(), 'deleteQuarantineRecord').mockReturnValue(false);
    h.exit!(1, 0);
    expect(ap.isQuarantined()).toBe(true);
    expect(ap.getStatus().status).toBe('quarantined');
  });

  it('PIN 3: reap record-delete failure returns unreapable instead of a false cleared claim', async () => {
    h.spawn.mockRejectedValue(new Error('degraded'));
    const probe = vi.spyOn(priv(), 'probePid').mockReturnValue('alive');
    identitySpies();
    await ap.start();
    probe.mockReset().mockReturnValueOnce('alive').mockReturnValue('dead');
    vi.spyOn(priv(), 'deleteQuarantineRecord').mockReturnValue(false);
    await expect(ap.forceReap()).resolves.toBe('unreapable');
    expect(ap.isQuarantined()).toBe(true);
    expect(ap.getStatus().status).toBe('quarantined');
  });

  it('18: Darwin process identity uses exact argv and fixed UTC/C locale regardless of caller env', () => {
    vi.spyOn(priv(), 'identityPlatform').mockReturnValue('darwin');
    const run = vi.spyOn(priv(), 'runIdentityCommand').mockReturnValue('Fri Jun 12 17:00:00 2026\n');
    const oldTz = process.env.TZ; const oldLocale = process.env.LC_ALL;
    process.env.TZ = 'America/Chicago'; process.env.LC_ALL = 'fr_FR.UTF-8';
    try {
      expect(priv().captureProcStart(4242)).toBe('Fri Jun 12 17:00:00 2026');
      expect(run).toHaveBeenCalledWith('ps', ['-p', '4242', '-o', 'lstart='], expect.objectContaining({ TZ: 'UTC', LC_ALL: 'C' }));
      run.mockReturnValue('   ');
      expect(priv().captureProcStart(4242)).toBeNull();
    } finally {
      if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz;
      if (oldLocale === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = oldLocale;
    }
  });

  it('25: Linux proc stat parser anchors on the last parenthesis and rejects anomalies', () => {
    const prefix = Array.from({ length: 19 }, (_, i) => i === 0 ? 'S' : String(i)).join(' ');
    expect(priv().parseLinuxProcStat(`123 (weird )name) ${prefix} 98765 21 22`)).toBe('98765');
    expect(priv().parseLinuxProcStat(`123 (a b c) ${prefix} 444 21`)).toBe('444');
    expect(priv().parseLinuxProcStat('123 malformed no close')).toBeNull();
    expect(priv().parseLinuxProcStat('123 (x) S 1 2')).toBeNull();
  });
});
