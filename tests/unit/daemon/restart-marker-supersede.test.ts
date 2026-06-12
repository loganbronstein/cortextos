/**
 * tests/unit/daemon/restart-marker-supersede.test.ts — BUG-011 (codex iteration-3).
 *
 * The preserve supersede path writes an AUTHORITATIVE in-flight receipt
 * (.restart-marker-superseded.json) BEFORE removing a conflicting .force-fresh
 * marker, fails closed if either step fails, validates an existing receipt as a
 * journal for THIS agent, treats restarts.log/event as best-effort projections,
 * and cleans the receipt (best-effort) only after a successful spawn.
 *
 * Uses an in-memory fs so receipt-write / marker-delete / telemetry failures can
 * be injected deterministically.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CTX = '/tmp/test-ctx';
const MARKER = `${CTX}/state/alice/.force-fresh`;
const RECEIPT = `${CTX}/state/alice/.restart-marker-superseded.json`;
const VALID_RECEIPT = JSON.stringify({ agent: 'alice', intent: 'preserve', decision: 'continue', marker_conflict: 'superseded', timestamp: '2026-06-12T17:00:00.000Z' });

// In-memory fs for the tracked state files + injectable failures.
const files = new Map<string, string>();
const fail = { atomicWrite: false, unlinkMarker: false, unlinkReceipt: false, append: false, spawn: false };
let receiptAtSpawn: boolean | null = null;

const mockPty = {
  spawn: vi.fn().mockImplementation(() => { receiptAtSpawn = files.has(RECEIPT); return fail.spawn ? Promise.reject(new Error('spawn fail')) : Promise.resolve(); }),
  kill: vi.fn(), write: vi.fn(), getPid: vi.fn().mockReturnValue(1), isAlive: vi.fn().mockReturnValue(true), onExit: vi.fn(),
};
vi.mock('../../../src/pty/agent-pty.js', () => ({ AgentPTY: function AgentPTY() { return mockPty; } }));
vi.mock('../../../src/pty/inject.js', () => ({ injectMessage: vi.fn(), MessageDedup: class { isDuplicate() { return false; } } }));
vi.mock('../../../src/utils/env.js', () => ({ writeCortextosEnv: vi.fn(), resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: CTX }) }));
vi.mock('../../../src/bus/reminders.js', () => ({ getOverdueReminders: vi.fn().mockReturnValue([]) }));
vi.mock('../../../src/utils/paths.js', () => ({ resolvePaths: vi.fn().mockReturnValue({ stateDir: `${CTX}/state/alice`, logDir: `${CTX}/logs/alice` }) }));

const mockLogEvent = vi.fn();
vi.mock('../../../src/bus/event.js', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: (p: string, data: string) => { if (fail.atomicWrite) throw new Error('atomic write fail'); files.set(String(p), data); },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    existsSync: (p: unknown) => files.has(String(p)),
    readFileSync: (p: unknown, ...rest: unknown[]) => (files.has(String(p)) ? files.get(String(p)) : (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)),
    unlinkSync: (p: unknown) => { const s = String(p); if (fail.unlinkMarker && s === MARKER) throw new Error('EACCES'); if (fail.unlinkReceipt && s === RECEIPT) throw new Error('EACCES'); files.delete(s); },
    appendFileSync: (p: unknown, data: unknown) => { if (fail.append) throw new Error('append fail'); files.set(String(p), (files.get(String(p)) || '') + String(data)); },
    writeFileSync: (p: unknown, data: unknown) => { files.set(String(p), String(data)); },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');
const mockEnv = { instanceId: 'test', ctxRoot: CTX, frameworkRoot: '/tmp/fw', agentName: 'alice', agentDir: '/tmp/fw/orgs/acme/agents/alice', org: 'acme', projectRoot: '/tmp/fw' };

function makeAgent(resumable = true) {
  const ap = new AgentProcess('alice', mockEnv, {});
  vi.spyOn(ap as unknown as { hasResumableSession: () => boolean }, 'hasResumableSession').mockReturnValue(resumable);
  return ap;
}
const makePreserveAgent = () => makeAgent(true);
const FOREIGN_RECEIPT = JSON.stringify({ agent: 'someone-else', intent: 'preserve', decision: 'continue', marker_conflict: 'superseded', timestamp: '2026-06-12T17:00:00.000Z' });
const EXTRA_FIELD_RECEIPT = JSON.stringify({ agent: 'alice', intent: 'preserve', decision: 'continue', marker_conflict: 'superseded', timestamp: '2026-06-12T17:00:00.000Z', extra: 1 });

beforeEach(() => {
  files.clear();
  fail.atomicWrite = false; fail.unlinkMarker = false; fail.unlinkReceipt = false; fail.append = false; fail.spawn = false;
  receiptAtSpawn = null;
  mockPty.spawn.mockClear();
  mockLogEvent.mockClear();
});

describe('BUG-011 — preserve marker-supersede receipt (codex iteration-3 contract)', () => {
  it('success: receipt written + present at spawn + marker gone + spawn + receipt cleaned after; telemetry emitted', async () => {
    files.set(MARKER, '');
    await makePreserveAgent().start('preserve');

    expect(mockPty.spawn.mock.calls[0][0]).toBe('continue');
    expect(receiptAtSpawn).toBe(true);          // authoritative receipt existed at spawn
    expect(files.has(MARKER)).toBe(false);      // marker removed
    expect(files.has(RECEIPT)).toBe(false);     // receipt cleaned AFTER spawn
    // best-effort projections fired
    expect(files.get(`${CTX}/logs/alice/restarts.log`)).toContain('PRESERVE-CONTINUE');
    expect(mockLogEvent.mock.calls.filter(c => c[4] === 'restart_marker_superseded')).toHaveLength(1);
  });

  it('receipt-write failure: marker remains, no spawn', async () => {
    files.set(MARKER, '');
    fail.atomicWrite = true;
    await expect(makePreserveAgent().start('preserve')).rejects.toThrow(/could not persist the marker-supersede receipt/i);
    expect(files.has(MARKER)).toBe(true);       // marker left in place
    expect(files.has(RECEIPT)).toBe(false);     // no receipt
    expect(mockPty.spawn).not.toHaveBeenCalled();
  });

  it('marker-delete failure after receipt: receipt remains, no spawn', async () => {
    files.set(MARKER, '');
    fail.unlinkMarker = true;
    await expect(makePreserveAgent().start('preserve')).rejects.toThrow(/could not be removed/i);
    expect(files.has(RECEIPT)).toBe(true);      // receipt left for recovery
    expect(files.has(MARKER)).toBe(true);       // marker still present
    expect(mockPty.spawn).not.toHaveBeenCalled();
  });

  it('retry with valid receipt + marker: completes without rewriting the receipt (no duplicate)', async () => {
    files.set(MARKER, '');
    files.set(RECEIPT, VALID_RECEIPT);          // valid in-flight receipt from a prior attempt
    await makePreserveAgent().start('preserve');

    expect(mockPty.spawn.mock.calls[0][0]).toBe('continue');
    expect(files.has(MARKER)).toBe(false);      // marker removal completed on retry
    expect(files.has(RECEIPT)).toBe(false);     // cleaned after spawn
    expect(receiptAtSpawn).toBe(true);          // the SAME receipt carried through (not rewritten)
  });

  it('leftover valid receipt with no marker: recognized, spawn proceeds, receipt cleaned', async () => {
    files.set(RECEIPT, VALID_RECEIPT);          // marker already removed previously; spawn had failed
    await makePreserveAgent().start('preserve');

    expect(mockPty.spawn.mock.calls[0][0]).toBe('continue');
    expect(files.has(RECEIPT)).toBe(false);     // leftover cleaned after spawn
  });

  it('malformed receipt: fail closed, no spawn, no overwrite', async () => {
    files.set(MARKER, '');
    files.set(RECEIPT, '{ not valid json');
    const before = files.get(RECEIPT);
    await expect(makePreserveAgent().start('preserve')).rejects.toThrow(/invalid or foreign/i);
    expect(mockPty.spawn).not.toHaveBeenCalled();
    expect(files.get(RECEIPT)).toBe(before);    // NOT overwritten
    expect(files.has(MARKER)).toBe(true);       // marker untouched
  });

  it('foreign-agent receipt: fail closed, no spawn', async () => {
    files.set(MARKER, '');
    files.set(RECEIPT, JSON.stringify({ agent: 'someone-else', intent: 'preserve', decision: 'continue', marker_conflict: 'superseded', timestamp: '2026-06-12T17:00:00.000Z' }));
    await expect(makePreserveAgent().start('preserve')).rejects.toThrow(/invalid or foreign/i);
    expect(mockPty.spawn).not.toHaveBeenCalled();
  });

  it('telemetry (restarts.log append) failure does NOT block the supersede or falsify the receipt', async () => {
    files.set(MARKER, '');
    fail.append = true;                         // projection sink down
    await makePreserveAgent().start('preserve'); // must NOT throw
    expect(mockPty.spawn.mock.calls[0][0]).toBe('continue');
    expect(files.has(MARKER)).toBe(false);      // authoritative path still completed
    expect(files.has(RECEIPT)).toBe(false);     // cleaned after spawn
  });
});

describe('BUG-011 — all-intent receipt recovery / cancellation (codex follow-up loop)', () => {
  // ---- AUTO + VALID receipt ----
  it('auto + valid receipt + resumable + marker PRESENT → recover/continue, marker gone, receipt cleaned', async () => {
    files.set(MARKER, ''); files.set(RECEIPT, VALID_RECEIPT);
    await makeAgent(true).start('auto');
    expect(mockPty.spawn.mock.calls[0][0]).toBe('continue');
    expect(files.has(MARKER)).toBe(false);
    expect(files.has(RECEIPT)).toBe(false);     // cleaned after spawn
  });

  it('auto + valid receipt + resumable + marker ABSENT (interrupted post-removal) → continue, receipt cleaned', async () => {
    files.set(RECEIPT, VALID_RECEIPT);          // no marker
    await makeAgent(true).start('auto');
    expect(mockPty.spawn.mock.calls[0][0]).toBe('continue');
    expect(files.has(RECEIPT)).toBe(false);
  });

  it('auto + valid receipt + NO resumable → FAIL CLOSED, no spawn, receipt+marker unchanged', async () => {
    files.set(MARKER, ''); files.set(RECEIPT, VALID_RECEIPT);
    await expect(makeAgent(false).start('auto')).rejects.toThrow(/no resumable session/i);
    expect(mockPty.spawn).not.toHaveBeenCalled();
    expect(files.get(RECEIPT)).toBe(VALID_RECEIPT);  // unchanged
    expect(files.has(MARKER)).toBe(true);            // untouched
  });

  it('auto + malformed receipt → FAIL CLOSED, no spawn, marker + receipt unchanged', async () => {
    files.set(MARKER, ''); files.set(RECEIPT, '{ not json');
    await expect(makeAgent(true).start('auto')).rejects.toThrow(/invalid or foreign/i);
    expect(mockPty.spawn).not.toHaveBeenCalled();
    expect(files.get(RECEIPT)).toBe('{ not json');
    expect(files.has(MARKER)).toBe(true);
  });

  it('auto + foreign-agent receipt → FAIL CLOSED, no spawn', async () => {
    files.set(MARKER, ''); files.set(RECEIPT, FOREIGN_RECEIPT);
    await expect(makeAgent(true).start('auto')).rejects.toThrow(/invalid or foreign/i);
    expect(mockPty.spawn).not.toHaveBeenCalled();
    expect(files.get(RECEIPT)).toBe(FOREIGN_RECEIPT);
    expect(files.has(MARKER)).toBe(true);
  });

  // ---- FRESH + VALID receipt = EXPLICIT CANCELLATION ----
  it('fresh + valid receipt + marker PRESENT → cancellation: marker removed + receipt deleted + fresh + cancel telemetry', async () => {
    files.set(MARKER, ''); files.set(RECEIPT, VALID_RECEIPT);
    await makeAgent(true).start('fresh');
    expect(mockPty.spawn.mock.calls[0][0]).toBe('fresh');
    expect(files.has(MARKER)).toBe(false);
    expect(files.has(RECEIPT)).toBe(false);
    expect(mockLogEvent.mock.calls.filter(c => c[4] === 'restart_supersede_cancelled')).toHaveLength(1);
  });

  it('fresh + valid receipt + marker ABSENT → cancellation completes (marker no-op) + receipt deleted + fresh', async () => {
    files.set(RECEIPT, VALID_RECEIPT);          // no marker
    await makeAgent(true).start('fresh');
    expect(mockPty.spawn.mock.calls[0][0]).toBe('fresh');
    expect(files.has(RECEIPT)).toBe(false);
  });

  it('fresh + valid receipt + marker-delete-fail → FAIL CLOSED, no spawn, receipt+marker remain', async () => {
    files.set(MARKER, ''); files.set(RECEIPT, VALID_RECEIPT);
    fail.unlinkMarker = true;
    await expect(makeAgent(true).start('fresh')).rejects.toThrow(/could not be removed/i);
    expect(mockPty.spawn).not.toHaveBeenCalled();
    expect(files.has(MARKER)).toBe(true);
    expect(files.get(RECEIPT)).toBe(VALID_RECEIPT);
    expect(mockLogEvent.mock.calls.filter(c => c[4] === 'restart_supersede_cancelled')).toHaveLength(0); // no partial telemetry
  });

  it('fresh + valid receipt + receipt-delete-fail (after marker removed) → FAIL CLOSED; retry completes', async () => {
    files.set(MARKER, ''); files.set(RECEIPT, VALID_RECEIPT);
    fail.unlinkReceipt = true;
    await expect(makeAgent(true).start('fresh')).rejects.toThrow(/could NOT delete the supersede receipt/i);
    expect(mockPty.spawn).not.toHaveBeenCalled();
    expect(files.has(MARKER)).toBe(false);          // marker already removed
    expect(files.get(RECEIPT)).toBe(VALID_RECEIPT); // receipt remains (retryable)
    expect(mockLogEvent.mock.calls.filter(c => c[4] === 'restart_supersede_cancelled')).toHaveLength(0); // never on partial
    // retry with fresh completes the cancellation
    fail.unlinkReceipt = false;
    await makeAgent(true).start('fresh');
    expect(mockPty.spawn.mock.calls.at(-1)?.[0]).toBe('fresh');
    expect(files.has(RECEIPT)).toBe(false);
  });

  it('fresh + malformed/foreign receipt → FAIL CLOSED, no spawn', async () => {
    files.set(MARKER, ''); files.set(RECEIPT, FOREIGN_RECEIPT);
    await expect(makeAgent(true).start('fresh')).rejects.toThrow(/invalid or foreign/i);
    expect(mockPty.spawn).not.toHaveBeenCalled();
  });

  // ---- PRESERVE + VALID receipt ----
  it('preserve + valid receipt + NO resumable → FAIL CLOSED, no spawn', async () => {
    files.set(MARKER, ''); files.set(RECEIPT, VALID_RECEIPT);
    await expect(makeAgent(false).start('preserve')).rejects.toThrow(/no resumable session/i);
    expect(mockPty.spawn).not.toHaveBeenCalled();
  });

  it('preserve + valid receipt + resumable + marker ABSENT → recover/continue, receipt cleaned', async () => {
    files.set(RECEIPT, VALID_RECEIPT);          // no marker
    await makeAgent(true).start('preserve');
    expect(mockPty.spawn.mock.calls[0][0]).toBe('continue');
    expect(files.has(RECEIPT)).toBe(false);
  });

  // ---- exact-schema validation ----
  it('extra-field receipt → invalid → FAIL CLOSED (every intent)', async () => {
    for (const intent of ['auto', 'fresh', 'preserve'] as const) {
      files.clear(); mockPty.spawn.mockClear();
      files.set(MARKER, ''); files.set(RECEIPT, EXTRA_FIELD_RECEIPT);
      await expect(makeAgent(true).start(intent)).rejects.toThrow(/invalid or foreign/i);
      expect(mockPty.spawn).not.toHaveBeenCalled();
      expect(files.get(RECEIPT)).toBe(EXTRA_FIELD_RECEIPT); // unchanged
    }
  });

  // ---- spawn failure after a completed cancellation ----
  it('fresh + valid receipt + cleanup OK + SPAWN FAILS → start REJECTS; no strand (receipt+marker gone); a later start EXECUTES under ABSENT semantics', async () => {
    files.set(MARKER, ''); files.set(RECEIPT, VALID_RECEIPT);
    fail.spawn = true;
    const failingAgent = makeAgent(true);
    vi.spyOn(failingAgent as unknown as { probePid: (pid: number) => string }, 'probePid').mockReturnValue('dead');
    // Cancellation deletes the marker + receipt DURING resolveStartMode, BEFORE the
    // spawn. The spawn then fails and start() REJECTS only after the observed PID
    // is OS-ESRCH-proven dead.
    await expect(failingAgent.start('fresh')).rejects.toThrow(/spawn fail/i);
    expect(mockPty.spawn).toHaveBeenCalled();   // spawn was attempted (cancellation completed first)
    expect(files.has(MARKER)).toBe(false);
    expect(files.has(RECEIPT)).toBe(false);
    // EXECUTE a later start: ABSENT receipt+marker → normal intent semantics.
    fail.spawn = false;
    await makeAgent(true).start('auto');
    expect(mockPty.spawn.mock.calls.at(-1)?.[0]).toBe('continue'); // resumable + no marker → continue
  });

  it('DIRECT: a PTY-spawn rejection makes start() REJECT (and mark crashed) — enables AgentManager rollback', async () => {
    // No receipt/marker: ordinary start, but the PTY spawn rejects.
    fail.spawn = true;
    const ap = makeAgent(true);
    vi.spyOn(ap as unknown as { probePid: (pid: number) => string }, 'probePid').mockReturnValue('dead');
    await expect(ap.start('auto')).rejects.toThrow(/spawn fail/i);
    expect((ap as unknown as { getStatus: () => { status: string } }).getStatus().status).toBe('crashed');
  });

  it('DIRECT: a POST-spawn observer/setup throw is SWALLOWED — start() RESOLVES and the agent stays running (codex lifecycle pin)', async () => {
    // The PTY spawns (live), but a post-spawn step throws. start() must NOT reject
    // (rejecting would let AgentManager roll back a live process) and the agent
    // must remain 'running', not be falsely marked crashed.
    const ap = makeAgent(true);
    vi.spyOn(ap as unknown as { maybeSendCodexBootNotification: () => void }, 'maybeSendCodexBootNotification')
      .mockImplementation(() => { throw new Error('post-spawn boom'); });
    await expect(ap.start('auto')).resolves.toBe('started');
    expect(mockPty.spawn).toHaveBeenCalled();   // spawned (live)
    expect((ap as unknown as { getStatus: () => { status: string } }).getStatus().status).toBe('running');
  });

  // ---- cancellation telemetry distinct from ordinary fresh + best-effort ----
  it('ordinary fresh (no receipt) does NOT emit the cancellation event; cancel-telemetry failure does not block', async () => {
    // ordinary fresh, no receipt → no cancel event
    await makeAgent(true).start('fresh');
    expect(mockLogEvent.mock.calls.filter(c => c[4] === 'restart_supersede_cancelled')).toHaveLength(0);
    // cancellation with a telemetry sink down still completes (best-effort)
    files.clear(); mockPty.spawn.mockClear();
    files.set(MARKER, ''); files.set(RECEIPT, VALID_RECEIPT);
    fail.append = true;
    await makeAgent(true).start('fresh');  // must NOT throw
    expect(mockPty.spawn.mock.calls[0][0]).toBe('fresh');
    expect(files.has(MARKER)).toBe(false);
    expect(files.has(RECEIPT)).toBe(false);
  });
});
