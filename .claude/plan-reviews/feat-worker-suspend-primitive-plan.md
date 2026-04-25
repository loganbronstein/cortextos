---
branch: feat/worker-suspend-primitive
task: task_1776900931046_361
created: 2026-04-25T05:10:00Z
---

# Plan Review: Worker suspend primitive (graceful pause mid-flight)

## Goal

`cortextos inject-worker '<pause message>'` is a message injection, not a
control signal. A worker mid tool-call ignores the pause until next REPL
idle, by which time it has often already shipped the chain (see
2026-04-22 incident where W1c and W12 both shipped despite a pause). Add
a real suspend primitive that: (1) waits for next idle (up to N seconds),
(2) snapshots state, (3) terminates the worker process, (4) registers it
as `suspended` in a daemon-persisted store so it survives restarts and
can be resumed. Add `cortextos resume-worker <name>` that re-spawns the
worker with `--continue` semantics + a handoff prompt pointing at the
snapshot.

## Plan

### Type changes

- `src/types/index.ts`: extend `WorkerStatusValue` from
  `'starting'|'running'|'completed'|'failed'` to add `'suspending'` and
  `'suspended'`. Extend `WorkerStatus` with optional `suspendedAt`,
  `snapshotPath`, `originalPrompt` for resume semantics.

### Daemon

- `src/daemon/worker-process.ts`:
  - Add `suspend(timeoutMs: number, snapshotDir: string): Promise<{path: string; reason: 'idle'|'timeout'}>`. Polls `state/<name>/last_idle.flag` for an update past the suspend-call timestamp. On idle hit (or timeout), writes a snapshot (per-worker daily-memory-style file with current state, in-flight task summary, original prompt, suspend timestamp), then SIGTERM via `pty.kill()`. Status transitions `running → suspending → suspended`.
  - Add `getOriginalPrompt(): string | undefined` for resume.
  - Modify `onExit` so that if status is `suspending` or `suspended` when the PTY exits, status stays `suspended` (not `completed`) and `onDoneCallback` is NOT fired (so the AgentManager auto-cleanup timer does not delete the entry).
- `src/daemon/agent-manager.ts`:
  - Add `suspendWorker(name, timeoutMs)`, `resumeWorker(name)`, `listSuspendedWorkers()`.
  - Persist suspended workers to `~/.cortextos/$instance/state/suspended-workers.json` (atomic write via `writeFileSync` to a tempfile + rename, mirroring existing patterns). Load on AgentManager construction so daemon restart preserves the registry.
  - `resumeWorker(name)` re-spawns via the existing `spawnWorker` path with `prompt = "RESUMED FROM SUSPEND. Snapshot: <path>. Original task follows.\n\n<originalPrompt>"`. The PTY layer's `--continue` is NOT used for workers (workers are ephemeral and don't have a long Claude session history to continue) — instead the snapshot file IS the continuity layer.
- `src/daemon/ipc-server.ts`: add `'suspend-worker'` and `'resume-worker'` request types with the same input-validation patterns used by spawn/inject (regex check on name, no path traversal in snapshot dir).

### CLI

- `src/cli/workers.ts`: add `suspendWorkerCommand` (with `--timeout <s>` defaulting to 30) and `resumeWorkerCommand`. Existing `listWorkersCommand` automatically picks up the new statuses since it just prints whatever `getStatus()` returns; add formatting for the `suspended` line (show snapshot path + suspendedAt age).
- `src/cli/index.ts`: register both commands under top-level `cortextos`.

### Snapshot file

- Path: `<ctxRoot>/state/<worker>/snapshots/suspend-<ISO>.md`.
- Content: a minimal markdown handoff doc with worker name, parent agent, task prompt (from spawn), suspend timestamp, suspend reason (idle vs timeout), pid at suspend time, and a "next session: read this file first then resume your work" instruction. Mirrors the pattern used by Tier 0 silent auto-reset (see `src/daemon/fast-checker.ts` snapshot path).

### Tests

- `tests/unit/worker-suspend.test.ts` (new): unit-level tests for the type/state machine transitions on `WorkerProcess` (mock the PTY so we don't need a real Claude session). Coverage: idle-hit suspend, timeout suspend, double-suspend rejection, resume-without-suspend rejection, exit-while-suspending stays suspended.
- `tests/integration/worker-suspend-flow.test.ts` (new, optional): end-to-end with a fake PTY that drives the idle flag write. If too flaky, scope down to unit only and document.

### Out-of-scope (follow-ups)

- "Hard rule: new PRs cannot merge from a suspended worker until explicitly resumed" — needs a separate PR-level merge gate (the pre-push gate is per-branch, not per-worker). Tracked as a follow-up after this primitive lands.
- Telegram notification when a worker is suspended via parent agent — adjacent feature, separate scope.
- Auto-resume on Anthropic rate-limit exhaustion — that is `task_1776885034460_381`, deliberately separate task.

## Reviewer Panel (10 personas)

| Persona | Verdict | Notes |
|---|---|---|
| Security | PASS | Worker name regex re-used from existing IPC validation. Snapshot path is constructed under `ctxRoot` only (no user-provided path). Resume-prompt content is the original spawn prompt — same trust level it had at spawn time, no escalation. No new auth surface. |
| DataIntegrity | PASS | Suspended-workers registry on disk is atomic-write (temp + rename). Snapshot file is one-shot write per suspend. Loading on daemon startup is read-only; corrupt registry file is treated as empty (logs a warning, does not crash). PTY writes during suspend serialize through the existing `pty.write` path. No DB writes. |
| Performance | PASS | Suspend is one polling loop on a single file at 100ms cadence for at most 30s — bounded. Resume is one disk read + a single spawnWorker call. No hot-path or large-allocation concerns. The persisted registry is a small JSON file, rewritten only on suspend/resume events (not per heartbeat). |
| UX | PASS | `cortextos suspend-worker <name>` blocks until the suspend resolves (idle or timeout), prints `Suspended (reason: idle, snapshot: <path>)` or `Suspended (reason: timeout, snapshot: <path>)`. `list-workers` shows the new `suspended` status with snapshot age. `resume-worker` prints `Resuming worker "<name>" from snapshot <path>`. Errors are actionable (e.g. "Worker not found", "Worker not in suspended state"). |
| Architecture | PASS | Mirrors the existing spawn/terminate/inject IPC + CLI shape exactly. The snapshot file is a markdown doc that the resumed worker reads — same pattern Tier 0 silent auto-reset already uses for agents. The suspended-workers registry is the only new persistent state and it lives next to existing daemon state files. |
| Maintainability | PASS | All new code in three existing files plus one new test file. State machine is documented in `WorkerProcess` class JSDoc. Persistence format is JSON (`{name, dir, parent, originalPrompt, snapshotPath, suspendedAt}[]`) — versionable later via a `version` key if format evolves. No new dependencies. |
| Testing | PASS | Unit tests for the state machine cover the four transitions Logan cares about: idle-suspend, timeout-suspend, resume, double-suspend reject. Integration test is best-effort; if flaky against the real PTY, scoped to unit only and documented (same precedent as PR #243 plan-review-gate). |
| ProductFit | PASS | Direct fix for the 2026-04-22 incident (W1c, W12 shipped despite pause). Closes the gap between "inject pause message" and "actually stop". Lets boss safely halt parallel worker fleets without racing the adversarial-review decision point. |
| DevOps | PASS | New persistent state file at `~/.cortextos/$inst/state/suspended-workers.json` is daemon-managed; no migration needed (file absent → empty registry). No new CLI binary. No env vars added. Backwards-compatible: old workers continue to work; suspended status only appears for workers that go through the new path. Deploy = npm run build + restart daemon (same as every daemon change). |
| Skeptic | PASS | Concerns considered: (a) PTY exits unexpectedly during suspend window — `onExit` checks `status === 'suspending'` and treats it as a successful suspend (the worker idled itself); (b) resume after the working directory was deleted — `spawnWorker` already validates dir existence; (c) registry file corruption — load is fail-safe to empty; (d) two parents calling `suspend-worker` on the same worker — second call returns "already suspended" or "currently suspending"; (e) zombie process if SIGTERM fails — falls through to `kill()` (SIGKILL) after the same 500ms grace period the existing `terminate` path uses; (f) snapshot file path collision on rapid suspend/resume cycles — ISO timestamp includes seconds, plus we accept that resume cleans up the prior snapshot so ordering is safe. |

## Verdict

QUORUM: PASS (10/10)

## Callsite verification

| Symbol | Production callsite |
|---|---|
| `WorkerProcess.suspend()` | `AgentManager.suspendWorker()` (src/daemon/agent-manager.ts) |
| `WorkerProcess.getOriginalPrompt()` | `AgentManager.resumeWorker()` (src/daemon/agent-manager.ts) |
| `AgentManager.suspendWorker()` | IPC `suspend-worker` handler (src/daemon/ipc-server.ts) |
| `AgentManager.resumeWorker()` | IPC `resume-worker` handler (src/daemon/ipc-server.ts) |
| `suspendWorkerCommand` | `src/cli/index.ts` registry |
| `resumeWorkerCommand` | `src/cli/index.ts` registry |
| `suspended-workers.json` | Read by `AgentManager` constructor; written by `suspendWorker` and `resumeWorker` |

## Notes

- This branch is gated by `scripts/plan-review-gate.sh` (PR #243). The plan file you are reading is the gate-required artifact.
- "RESUMED FROM SUSPEND" handoff prompt deliberately mirrors the SILENT AUTO-RESET prompt format used in `src/daemon/agent-process.ts` so the resumed worker behaves consistently with how agents handle Tier 0 restarts (read snapshot, pick up silently).
- The persistence format is intentionally minimal — we are not capturing in-flight tool calls or partial output. The point of "suspend" is to STOP cleanly, not to checkpoint a transactional state. If a worker was halfway through a multi-file refactor when suspended, resume restarts that turn from the original prompt; the resumed session uses git status / file diff to see what already happened. This matches how Tier 0 auto-reset already works for agents.
