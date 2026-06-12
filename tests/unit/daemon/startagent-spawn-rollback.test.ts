/**
 * tests/unit/daemon/startagent-spawn-rollback.test.ts — BUG-011 (codex follow-up pin).
 *
 * INTEGRATION regression for the transactional rollback in AgentManager.startAgent.
 * This drives the REAL AgentProcess path — only the PTY (../pty/agent-pty.js) is
 * mocked, and its spawn() REJECTS. That exercises the real BUG-011 rethrow in
 * AgentProcess.start() (a PTY-spawn failure must reject, not swallow), which is
 * what lets AgentManager.startAgent roll back.
 *
 * The restart-intent-routing.test.ts rollback case mocks AgentProcess.start()
 * directly (ctrl.rejectStart) — codex flagged that as insufficient: it never
 * proves a genuine PTY-spawn rejection unwinds the lifecycle. This test closes
 * that gap by asserting the spawn was actually reached AND that the scheduler,
 * cron-migration, and fast-checker startup steps NEVER ran.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Shared spies/controls so the test can prove what did (and did not) run.
const h = vi.hoisted(() => ({
  spawn: vi.fn(() => Promise.reject(new Error('PTY spawn failed (integration rollback test)'))),
  checkerStart: vi.fn(() => Promise.resolve()),
  migrate: vi.fn(),
}));

// Mock ONLY the PTY — AgentProcess itself is the real module under test.
vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: class {
    onExit() {}
    getPid() { return 1; }
    isAlive() { return false; }
    write() {}
    kill() {}
    async spawn() { return h.spawn(); }
  },
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { start() { return h.checkerStart(); } stop() {} wake() {} },
}));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class { sendMessage() { return Promise.resolve(); } } }));
vi.mock('../../../src/telegram/poller.js', () => ({ TelegramPoller: class { start() {} stop() {} } }));
vi.mock('../../../src/daemon/cron-migration.js', () => ({ migrateCronsForAgent: h.migrate }));
vi.mock('../../../src/daemon/cron-scheduler.js', () => ({
  CronScheduler: class { start() {} stop() {} reload() {} getNextFireTimes() { return []; } },
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

describe('BUG-011 — startAgent rolls back on a REAL PTY-spawn rejection', () => {
  let testDir: string;
  let am: InstanceType<typeof AgentManager>;

  function agentDirFor(name: string): string {
    const dir = join(testDir, 'framework', 'orgs', 'acme', 'agents', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{}');
    return dir;
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-spawn-rollback-'));
    mkdirSync(join(testDir, 'framework'), { recursive: true });
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
    h.spawn.mockClear();
    h.checkerStart.mockClear();
    h.migrate.mockClear();
    h.spawn.mockImplementation(() => Promise.reject(new Error('PTY spawn failed (integration rollback test)')));
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(testDir, { recursive: true, force: true }); });

  it('a genuine PTY spawn() rejection rejects startAgent and leaves NO registry/scheduler/checker residue', async () => {
    const reg = am as unknown as {
      agents: Map<string, unknown>;
      pendingRestarts: Set<string>;
      cronSchedulers: Map<string, unknown>;
    };
    const dir = agentDirFor('zoe');
    const schedSpy = vi.spyOn(am as unknown as { startAgentCronScheduler: (n: string) => void }, 'startAgentCronScheduler');
    const probeSpy = vi.spyOn(AgentProcess.prototype as unknown as { probePid: (pid: number) => string }, 'probePid').mockReturnValue('dead');

    await expect(am.startAgent('zoe', dir, {}, 'acme', 'auto')).rejects.toThrow(/PTY spawn failed/i);
    expect(probeSpy).toHaveBeenCalledWith(1);

    // The real PTY spawn was actually reached — this is a true spawn rejection
    // travelling through AgentProcess.start()'s rethrow, not a pre-spawn
    // fail-closed or a mocked-out start().
    expect(h.spawn).toHaveBeenCalledTimes(1);

    // Transactional rollback: registry + scheduler map are both clean.
    expect(reg.agents.has('zoe')).toBe(false);          // not registered-dead
    expect(reg.cronSchedulers.has('zoe')).toBe(false);
    expect(reg.pendingRestarts.has('zoe')).toBe(false);

    // The post-start startup steps NEVER ran (rollback threw before them).
    expect(schedSpy).not.toHaveBeenCalled();
    expect(h.migrate).not.toHaveBeenCalled();
    expect(h.checkerStart).not.toHaveBeenCalled();

    // Recovery `cortextos start zoe` is NOT deduped against a registered-dead entry.
    expect(am.inspectAgentOp('start', 'zoe')).toEqual({ ok: true });
  });

  it('a POST-spawn observer/setup throw does NOT roll back the LIVE agent (lifecycle boundary)', async () => {
    // codex follow-up pin: only a real PTY-spawn failure may reject start() and
    // trigger rollback. Once the PTY is live, a post-spawn observability/setup
    // throw (here: maybeSendCodexBootNotification, the exact region the
    // incomplete-Telegram-mock surfaced) must be swallowed — rejecting would
    // unregister a process that is still running.
    vi.useFakeTimers();
    const bootSpy = vi
      .spyOn(AgentProcess.prototype as unknown as { maybeSendCodexBootNotification: () => void }, 'maybeSendCodexBootNotification')
      .mockImplementation(() => { throw new Error('post-spawn boot notification boom'); });
    try {
      const reg = am as unknown as { agents: Map<string, { process: { getStatus: () => { status: string } } }>; cronSchedulers: Map<string, unknown> };
      const dir = agentDirFor('liv');
      h.spawn.mockImplementation(() => Promise.resolve());   // spawn SUCCEEDS → live PTY
      const schedSpy = vi.spyOn(am as unknown as { startAgentCronScheduler: (n: string) => void }, 'startAgentCronScheduler');

      // Must NOT reject despite the post-spawn throw.
      await expect(am.startAgent('liv', dir, {}, 'acme', 'auto')).resolves.toBeUndefined();

      expect(h.spawn).toHaveBeenCalledTimes(1);     // PTY actually spawned (live)
      expect(bootSpy).toHaveBeenCalled();           // the post-spawn step really threw
      // NOT rolled back — the live agent stays registered and the startup steps ran.
      expect(reg.agents.has('liv')).toBe(true);
      expect(reg.cronSchedulers.has('liv')).toBe(true);
      expect(schedSpy).toHaveBeenCalledWith('liv');
      expect(h.checkerStart).toHaveBeenCalled();
      expect(reg.agents.get('liv')!.process.getStatus().status).toBe('running');
    } finally {
      bootSpy.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('positive control: when the SAME harness spawns successfully, the agent registers and the startup steps DO run (rollback assertions are non-vacuous)', async () => {
    vi.useFakeTimers();
    try {
      const reg = am as unknown as { agents: Map<string, unknown>; cronSchedulers: Map<string, unknown> };
      const dir = agentDirFor('max');
      h.spawn.mockImplementation(() => Promise.resolve());
      const schedSpy = vi.spyOn(am as unknown as { startAgentCronScheduler: (n: string) => void }, 'startAgentCronScheduler');

      await am.startAgent('max', dir, {}, 'acme', 'auto');

      expect(h.spawn).toHaveBeenCalledTimes(1);
      expect(reg.agents.has('max')).toBe(true);
      expect(reg.cronSchedulers.has('max')).toBe(true);
      expect(h.migrate).toHaveBeenCalled();
      expect(schedSpy).toHaveBeenCalledWith('max');
      expect(h.checkerStart).toHaveBeenCalled();
    } finally {
      // Drop the long-lived session timer start() registered, then restore.
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
