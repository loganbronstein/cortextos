---
branch: fix/fast-checker-spawn-on-new-agent
task: task_1776901473789_637
created: 2026-04-25T06:18:00Z
---

# Plan Review: Fix the silent-Telegram-disable bug behind "fast-checker not spawned for new agent"

## Goal

Logan filed a bug saying "Fast-checker not spawned for new agent: marketing got 5 Telegram messages between 18:23-21:00 UTC, none reached the session, no fast-checker.log in logs/marketing/". I traced this in the daemon log (`~/.pm2/logs/cortextos-daemon-out.log`) and the actual root cause is different from the title:

```
[ipc] start-agent marketing from cortextos start
[marketing] SECURITY: BOT_TOKEN is set but ALLOWED_USER is missing.
            Refusing to enable Telegram. Set ALLOWED_USER to your numeric
            Telegram user ID in .env, or remove BOT_TOKEN to start the
            agent without Telegram.
[marketing] Starting in fresh mode
[marketing] Starting. Waiting for bootstrap...
[marketing] Bootstrap complete. Beginning poll loop.
```

The fast-checker IS spawning. The silent failure is the **TelegramPoller**, which agent-manager.ts only constructs `if (telegramApi && chatId)` (line 297). The security gate at lines 224-231 nulls `telegramApi` when `ALLOWED_USER` is missing, leaving the poller unconstructed. Result: agent runs, but Telegram messages never get pulled from the API.

The reason a user can hit this: `cortextos add-agent` writes a `.env` template containing only `BOT_TOKEN=` and `CHAT_ID=` — no `ALLOWED_USER=` field, no comment explaining it's required. Same gap in `cortextos setup`'s `writeAgentEnv()`. The daemon's runtime warning lands in `~/.pm2/logs/cortextos-daemon-out.log` which most users never read. From the user's perspective `cortextos start <agent>` returns success, the agent appears running, and Telegram is silently deaf.

## Plan

### `src/cli/add-agent.ts`

Extend the `.env` template (lines 111-127) to:
- Include an `ALLOWED_USER=` placeholder
- Add a comment block explaining what it is, why it's required, and how to find your numeric Telegram user ID
- Keep the existing BOT_TOKEN / CHAT_ID / CLAUDE_CODE_DISABLE_1M_CONTEXT lines unchanged so existing onboarding docs still match

### `src/cli/setup.ts`

Update `writeAgentEnv(agentDir, botToken, chatId, allowedUser?)` to accept an optional `allowedUser` parameter and write it when present. Update the wizard's prompt sequence: after fetching/confirming the chat ID, also prompt for the user's numeric Telegram user ID (with a one-line explanation + a "skip for now (Telegram disabled)" option). When skipped, write `ALLOWED_USER=` empty so the daemon's existing security gate fires and the user knows what to fill.

### `src/cli/start.ts`

Add a pre-flight `.env` sanity check before delegating to the IPC `start-agent` call. When the agent dir has a `.env` with `BOT_TOKEN` set but `ALLOWED_USER` empty/missing, print a user-visible warning to stdout (not stderr — this is informational, not blocking):

```
  ⚠ Telegram disabled: ALLOWED_USER not set in .env
    BOT_TOKEN is configured but ALLOWED_USER is missing. The daemon will
    refuse to enable Telegram for security reasons (any user who finds the
    bot @handle could otherwise control the agent).
    Fix: edit orgs/<org>/agents/<name>/.env and set ALLOWED_USER to your
    numeric Telegram user ID. Get yours by sending any message to
    @userinfobot. Then re-run: cortextos start <name>
```

This gate is informational — start still proceeds, agent still runs (just without Telegram). The user is no longer surprised when their messages don't arrive.

### Tests

Two new test files:

1. `tests/unit/cli/add-agent-env-template.test.ts`: verifies the `.env` template content includes `ALLOWED_USER=` and an explanatory comment. Uses a tmpdir + invoking the add-agent code path with a stub project root.
2. `tests/unit/cli/start-env-warning.test.ts`: extracts the warning logic into a pure helper (`checkTelegramEnvCompleteness(envContent: string): {warn: boolean, missing: string[]}`), unit-tests it for the four cases (no BOT_TOKEN → no warn, BOT_TOKEN + ALLOWED_USER → no warn, BOT_TOKEN + missing ALLOWED_USER → warn, BOT_TOKEN + empty ALLOWED_USER → warn).

### Out-of-scope (separate follow-ups)

- Reframe the daemon-side log message to reference `cortextos start` so users see the fix path even when grepping daemon logs (low priority — CLI warning covers the common case).
- `cortextos doctor` check that scans every agent's `.env` and flags incomplete-Telegram state (broader feature, separate).
- The bug title "Fast-checker not spawned" is itself misleading. I'm leaving the task description alone but the PR + commit message will name the actual cause for future grep-ability.

## Reviewer Panel (10 personas)

| Persona | Verdict | Notes |
|---|---|---|
| Security | PASS | The fix preserves the existing security default (fail-closed when ALLOWED_USER missing). No new auth surface; we are just making the silent failure visible. ALLOWED_USER must still be a numeric Telegram user ID — the runtime validator at agent-manager.ts:218-222 stays in place. |
| DataIntegrity | PASS | No DB changes. `.env` writes are atomic (writeFileSync) and only happen in code paths that already write `.env`. The pre-flight check in start.ts is read-only. |
| Performance | PASS | One additional readFileSync per `cortextos start <agent>` invocation. <1ms. |
| UX | PASS | This is the WHOLE point of the fix. Users no longer need to grep ~/.pm2/logs to diagnose silent Telegram disable. The warning names the file to edit, the field to set, and a working source for the user ID (@userinfobot). |
| Architecture | PASS | Pure-helper extraction (`checkTelegramEnvCompleteness`) keeps the warning logic testable in isolation from the CLI Command framework. No new modules; touches three existing CLI files. |
| Maintainability | PASS | The .env template is one source-of-truth for new-agent credentials; comments explain WHY ALLOWED_USER is required (security against bot @handle discovery), not just what. setup.ts wizard prompt is keyboard-driven, no new dep. |
| Testing | PASS | 2 new test files (unit-level, fast). The existing add-agent test (if any) is unaffected. The new helper has 4 cases covering the warn/no-warn matrix. |
| ProductFit | PASS | Direct fix to a real user-reported bug Logan saw with the marketing agent. Fleet-self-healing infra per boss redirect: prevents future agents from the silent-deaf state Logan + Marketing both hit this week. |
| DevOps | PASS | No new env vars. No new services. No migration. The .env template change is forward-only — existing agents already running are unaffected (their `.env` already has whatever Logan put in). New agents pick up the better template. |
| Skeptic | PASS | Concerns considered: (a) what if a user genuinely wants Telegram off — they can leave BOT_TOKEN empty (the warning only fires when BOT_TOKEN is set + ALLOWED_USER missing); (b) what if an org has multiple Telegram users — the existing single-user gate is the broader limitation, not addressed here; (c) what if the .env file is unreadable at start time — the pre-flight check catches the read error and proceeds without warning (no change to existing behavior, just no extra warning); (d) what about the recent PR #235 (fix(telegram): validate BOT_TOKEN and CHAT_ID against Telegram API) — that fix added validation for token + chat_id but not for allowed_user, this PR completes the trio. |

## Verdict

QUORUM: PASS (10/10)

## Callsite verification

| Symbol | Production callsite |
|---|---|
| `.env` template (add-agent) | Generated when `cortextos add-agent <name>` runs and the file does not exist (line 110) |
| `writeAgentEnv` (setup) | Called from the setup wizard's orchestrator setup step |
| `checkTelegramEnvCompleteness` (new helper) | Called from `start.ts` action handler before IPC delegate; tested in isolation in unit test |

## Notes

- The bug title "Fast-checker not spawned" is technically wrong. Fast-checker IS spawned. The actual silent failure is the TelegramPoller construction guarded by `if (telegramApi && chatId)`. PR description names the actual cause.
- Force-added past .gitignore until PR #243 merges (same bootstrap pattern as my prior PRs this session).
- I considered changing the daemon-side check to require ALLOWED_USER as a positive opt-in flag rather than fail-closed silence. Rejected: the current behavior is correct security-wise. The bug is purely UX, not authorization.
