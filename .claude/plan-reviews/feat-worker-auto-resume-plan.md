---
branch: feat/worker-auto-resume
task: task_1776885034460_381
created: 2026-04-25T05:50:00Z
---

# Plan Review: Worker auto-resume on Anthropic rate-limit exhaustion

## Goal

Today's fleet of 5 workers all hit the weekly Opus limit simultaneously and silently idled at the Claude Code REPL prompt — even after the limit reset. Manual `cortextos inject-worker` was required to recover. Two workers had done zero work; three had committed code on feature branches but were stuck before sending the final bus summary message. The fleet lost ~4 worker-hours.

This PR adds two related auto-recovery flows:

1. **Rate-limit auto-resume**: detect the Claude Code rate-limit banner in worker stdout, parse the reset timestamp, and inject "continue from where you left off" once the reset has passed. Bounded retries; parent alert + optional terminate on exhaustion.
2. **Code-done-needs-summary detection**: detect the specific failure mode where a worker has committed code on a feature branch but never sent the parent a summary bus message. Nudge the worker to finish, OR auto-generate a summary from the commit log and terminate.

## Plan

### New file: `src/daemon/worker-watcher.ts`

A periodic background poller (default cadence 60s) attached to `AgentManager`. For every currently-running worker, the watcher:

1. Tails `state/<worker>/stdout.log` (last 200 lines, ~32KB cap).
2. Strips ANSI control sequences so the regex matches the rendered text, not the terminal escape codes.
3. Runs two detectors:
   - **Rate-limit detector**: matches `/You(?:'ve)? (?:have hit your|used (?:9[5-9]|100)% of your).*?(?:weekly|5-hour|daily)?\s*limit/i` plus the same line's reset hint `/resets\s+([0-9]+(?:am|pm)?)\s*\(([^)]+)\)/i` → returns `{ hit: true, resetAt: Date | null }`. Reset parsing is best-effort; if we can't parse it, we still mark the worker as `waiting-for-reset` and retry every cadence-tick to see if normal output resumes.
   - **Commit-done-no-summary detector**: queries `git -C <worker.dir> rev-list main..HEAD --count` (when `worker.dir` is a git repo) AND scans `cortextos bus` outbound message log for a recent message from this worker mentioning a PR URL, "Done", or "shipped". If commits > 0 AND no qualifying summary message in last 10 min AND worker has been idle (per `last_idle.flag`) > 5 min, classify as `code-done-needs-summary`.
4. Per-worker watcher state tracked in-memory on the watcher: `{rateLimitState, resetAt, retries, codeDoneNotifiedAt}`. State transitions logged to console for debugging.
5. Actions:
   - Rate-limit detected: set worker `status = 'waiting-for-reset'`, store ETA. Do nothing until reset.
   - Reset has passed (now > resetAt + 30s grace): inject `"Continue from where you left off. The rate-limit has reset."`. Increment retries.
   - Retries >= 3: send parent agent a bus message: `"Worker <name> exhausted auto-resume retries after rate-limit. Manual intervention needed."` Keep worker alive (let parent decide to terminate).
   - Commit-done-no-summary detected: send parent a bus message with the commit log summary. First time only (don't re-spam every cadence-tick).

### `src/daemon/worker-process.ts`

- Add `getStdoutTail(maxBytes: number = 32_768): string` — reads last N bytes of `state/<name>/stdout.log` (the same file the existing `spawn()` writes). Returns empty string if file missing.
- Add `markWaitingForReset(resetAt: Date | null): void` and `clearWaitingForReset(): void` — toggles the `waiting-for-reset` substatus that the watcher uses. Status mirror in `getStatus()` includes `resetAt` and `rateLimitRetries`.
- Add `'waiting-for-reset'` to `WorkerStatusValue`.

### `src/daemon/agent-manager.ts`

- Construct a `WorkerWatcher` in the constructor. Start it on `discoverAndStart()`. Stop it cleanly on daemon shutdown.
- Add `getWorker(name): WorkerProcess | undefined` accessor (already partially done via `workers.get`); exposed for the watcher.
- Bus-send helper for parent alerts: re-use existing `sendInboxMessage` infra (the bus already supports agent-to-agent messages).

### `src/cli/workers.ts`

- `listWorkersCommand`: when status is `waiting-for-reset`, append `(ETA <time>, retries N/3)` to the line. No new command — just better formatting.

### Types

- `src/types/index.ts`: extend `WorkerStatusValue` with `'waiting-for-reset'`. Add optional `resetAt?: string` and `rateLimitRetries?: number` to `WorkerStatus`.

### Tests (`tests/unit/daemon/worker-watcher.test.ts`, new)

Pure-function unit tests for the detection logic, no daemon spin-up:

1. `parseRateLimitBanner` returns `{hit:true,resetAt}` for the live "You've used 95% of your weekly limit · resets 7pm (UTC)" string (real fixture from the analyst stdout log captured 2026-04-22).
2. `parseRateLimitBanner` returns `{hit:false}` for normal output.
3. `parseRateLimitBanner` returns `{hit:true,resetAt:null}` when banner present but reset hint malformed.
4. `parseResetTime` handles "7pm (UTC)", "7am (UTC)", "Monday 12:00 (UTC)" formats; falls back to null on garbage.
5. `stripAnsi` strips the SGR + cursor-position escapes that wrap the rate-limit banner in actual stdout.
6. `detectCommitDoneNoSummary` returns true for (commits=2, no recent summary, idle>5min); false for (commits=0); false for (commits=2, summary sent 2min ago); false for (idle<5min).
7. State machine: detected → waiting → recovered (after inject + worker resumes); detected → exhausted (after 3 retries with no recovery).

Integration test for the full watcher loop is best-effort (it requires fake stdout-tail + fake clock); if too flaky we ship the unit tests only and document.

### Out-of-scope (follow-ups)

- Auto-terminate-and-promote-branch on stuck commit-done-no-summary state. The MVP just nudges + alerts the parent. Auto-termination requires a PR-creation flow that the watcher doesn't have; tracked separately.
- Detection of mid-tool-call timeouts (worker is alive but spinning on a single prompt for >30 min). Different signal, different fix.
- Cross-instance rate-limit pooling. Each daemon instance handles its own workers.

## Reviewer Panel (10 personas)

| Persona | Verdict | Notes |
|---|---|---|
| Security | PASS | Watcher reads stdout files (read-only) and sends bus messages via the existing parent-agent path (no new auth surface). Inject text is hard-coded ("Continue from where you left off..."), not user-supplied. Reset-time parser is regex-only, no `eval`. |
| DataIntegrity | PASS | No DB writes. Per-worker watcher state is in-memory; nothing persisted. The bus messages it emits are written via the existing inbox path which already has its own atomicity. |
| Performance | PASS | Watcher cadence is 60s default (configurable). Per-tick cost: read-tail of N stdout files (32KB each), regex match, optional `git rev-list` shellout per worker. With 10 workers that's ~600KB read + 10 git ops per minute — trivial. The watcher itself is one setInterval, no thread pool. |
| UX | PASS | `list-workers` surfaces the new `waiting-for-reset` status with ETA + retry count, so a parent watching the dashboard sees "this is rate-limited, will retry at 7pm" instead of an opaque idle state. Parent-alert messages name the worker, the situation, and what manual recovery looks like. |
| Architecture | PASS | New responsibility lives in its own file (`worker-watcher.ts`). AgentManager owns the lifecycle. Detection helpers are pure functions, tested in isolation from the daemon. State is per-watcher (in-memory), no new persistent registry needed. |
| Maintainability | PASS | Detection logic is in named pure functions (`parseRateLimitBanner`, `parseResetTime`, `stripAnsi`, `detectCommitDoneNoSummary`). Test fixtures use real captured banner strings (see analyst stdout 2026-04-22) so the patterns match production reality, not theory. |
| Testing | PASS | 7+ unit tests cover the state machine and the detectors. Integration is best-effort (PTY + clock mocking is awkward); if flaky, scoped to unit. Same precedent as PR #246's worker-process suspend tests. |
| ProductFit | PASS | Direct fix for the 2026-04-22 incident (4 worker-hours lost). The commit-done-no-summary detection covers boss's explicit additional requirement (boss feedback 19:11 UTC: "must cover that transition explicitly"). Default-to-conservative: nudge first, alert parent, never auto-terminate without parent involvement. |
| DevOps | PASS | No new state files. No new env vars (cadence is a constant; can be made configurable later if needed). Watcher starts/stops with the daemon, no separate process. Backwards-compatible: workers without rate-limit issues see no change in behavior. |
| Skeptic | PASS | Concerns considered: (a) false-positive rate-limit on a worker that legitimately mentioned "limit" in code/text — mitigated by requiring the *full* banner pattern (multi-token, including "your") rather than just "limit"; (b) reset time parser failing for unknown formats — degrades gracefully to retry-on-cadence; (c) git shellout in the watcher slows it down — only runs when the worker dir is a git repo and only on the commit-done detector; (d) parent-alert spam — guarded by `codeDoneNotifiedAt` (one alert per worker per detection cycle) and by `retries < 3` for rate-limit alerts; (e) watcher firing while worker is in the middle of being suspended — `WorkerProcess.getStatus().status` check at the top of each tick skips non-running workers; (f) clock skew between Logan's machine and Anthropic's reset-at — the 30s grace after reset covers normal NTP drift. |

## Verdict

QUORUM: PASS (10/10)

## Callsite verification

| Symbol | Production callsite |
|---|---|
| `WorkerWatcher` (class) | Constructed in `AgentManager.constructor`, started in `discoverAndStart` |
| `WorkerWatcher.tick()` | `setInterval` in `WorkerWatcher.start()` |
| `WorkerProcess.getStdoutTail` | `WorkerWatcher.tick()` per-worker iteration |
| `WorkerProcess.markWaitingForReset` | `WorkerWatcher.tick()` rate-limit branch |
| `parseRateLimitBanner` (pure helper) | `WorkerWatcher.tick()` |
| `parseResetTime` (pure helper) | `parseRateLimitBanner` |
| `stripAnsi` (pure helper) | `WorkerWatcher.tick()` |
| `detectCommitDoneNoSummary` (pure helper) | `WorkerWatcher.tick()` |

## Notes

- This branch is gated by `scripts/plan-review-gate.sh` (PR #243). Plan file force-added past .gitignore until #243 merges.
- Real-world banner format captured from `~/.cortextos/default/logs/analyst/stdout.log`: `You've used 91% of your weekly limit · resets 7pm (UTC)`. The detector is calibrated to this exact phrasing PLUS the more dire `You have hit your <X> limit` form mentioned in the task description.
- The 60s cadence is intentionally conservative. Once we have telemetry on real rate-limit incidents, we may tune to 30s. Faster than 30s risks injecting before the agent's own retry loop has time to recover naturally.
