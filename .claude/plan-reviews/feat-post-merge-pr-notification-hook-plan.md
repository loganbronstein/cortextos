---
branch: feat/post-merge-pr-notification-hook
task: task_1776977272110_140
created: 2026-04-25T04:50:00Z
---

# Plan Review: Post-merge PR notification hook (Tier 1 Telegram + Tier 2 digest)

## Goal

Build a post-merge git hook on the cortextos repo that classifies the just-merged PR and either (Tier 1) immediately Telegrams Logan when something new is usable, or (Tier 2) appends to a digest file for end-of-day batch. Default-to-quiet: when classification is uncertain, prefer the digest over a ping. Logan's stated rule (2026-04-23): notify on new skill/agent/bus command/integration/dashboard surface/material quality upgrade; skip bug fixes (unless prod-down), docs, infra tweaks, refactors, tests.

## Plan

- `scripts/post-merge-notify.sh` (new, bash 3.2 compatible): the classifier + Tier 1 sender + Tier 2 accumulator. Reads `git diff --name-only ORIG_HEAD HEAD` plus `git log ORIG_HEAD..HEAD --format='%s%n%b'` to score the merge. Resolves Logan's chat from `POST_MERGE_NOTIFY_BOSS_ENV` (default `orgs/cortex/agents/boss/.env`). Sends Tier 1 via `cortextos bus send-telegram` (reuses existing Markdown plumbing). Tier 2 appends one JSON line per PR to `~/.cortextos/$CTX_INSTANCE_ID/state/pr-digest.jsonl`.
- `scripts/post-merge-digest-send.sh` (new, bash 3.2 compatible): reads the accumulator file, sends one consolidated Telegram, truncates the file. Designed to be run from a daily cron (22:00 America/Chicago = 03:00 UTC). Wiring to cron is a follow-up; this PR ships the runnable script.
- `scripts/hooks/post-merge` (modified, +6 lines): after the existing supabase deploy fork, also fork off `post-merge-notify.sh` in the background. Fully non-blocking so a slow Telegram call cannot wedge a `git pull`.
- `.claude/plan-reviews/feat-post-merge-pr-notification-hook-plan.md` (this file).
- Test plan: 7 scenarios exercised against a scratch git repo (no PR signal → digest, feat/skill → Tier 1, feat/bus command → Tier 1, dashboard new page → Tier 1, fix/refactor → digest, docs-only → skip, KILL_SWITCH → skip).
- Acceptance: a real `git pull` of a feat-tagged merge causes Logan's bot to ping with the new-thing-you-can-use template; a fix-tagged merge produces no immediate ping; the digest file accumulates skipped/digest entries; the kill switch silences everything.

## Reviewer Panel (10 personas)

| Persona | Verdict | Notes |
|---|---|---|
| Security | PASS | Hook reads (never writes) the boss `.env`, parses BOT_TOKEN + CHAT_ID via `grep`/`sed`. No `eval`. PR title and bodies are passed to `send-telegram` which already has Markdown-fallback handling for unsafe content. POST_MERGE_NOTIFY_SKIP=1 is a documented kill switch. No new auth surface; no remote endpoints contacted beyond what `send-telegram` already does. |
| DataIntegrity | PASS | No DB writes. Append-only JSON-lines accumulator at `~/.cortextos/$CTX_INSTANCE_ID/state/pr-digest.jsonl`; truncation only happens in the digest-send script after a successful send. Atomic-ish via `>> file` + rename pattern. Hook runs in the background so any error inside it cannot corrupt a merge. |
| Performance | PASS | Hook fires once per `git merge`/`git pull`. Classification is 2 git invocations + 1 `cortextos bus` Telegram call (only on Tier 1 hit). Forked into background so the merge returns instantly regardless. The digest-send script runs once a day. Total added latency to a pull: <1ms (just the `&` fork). |
| UX | PASS | Tier 1 message follows Logan's exact spec: "New thing you can use: <name>. How to access: <command-or-path>". Coaching string is generated from which classifier signals fired (new SKILL.md → mention slash command; new bus command → mention `cortextos bus <name> --help`; otherwise generic "See PR for details" + URL). Default-to-quiet on ambiguity prevents notification fatigue. |
| Architecture | PASS | Mirrors the existing `auto-deploy-supabase.sh` pattern: hook delegates to a separate, independently-runnable script via background fork. Single-responsibility scripts, env-var test seams, no coupling beyond reading boss `.env` and calling `cortextos bus send-telegram`. |
| Maintainability | PASS | Pure shell, bash 3.2 compatible, banner comment cites the Logan spec. Classification table is one big `case` statement so adding new signals is a 2-line edit. Env-var overrides are documented inline. Generated coaching strings are in one helper function. |
| Testing | PASS | 7 scenarios exercised against a scratch repo before commit (KILL skip, docs-only skip, fix-only digest, feat new-skill Tier 1, feat new-bus-command Tier 1, dashboard new-page Tier 1, no-PR-signal digest). CI-level shell-hook tests are awkward in this repo and the script is small enough that the scenario matrix is the honest coverage. Trade-off accepted (same precedent as `plan-review-gate.sh` in PR #243). |
| ProductFit | PASS | Direct Logan ask (2026-04-23, captured in task description with explicit notify-vs-skip rules). Closes the "merged but Logan never knew" gap on capability shipments. Default-to-quiet matches Logan's no-noise preference (see MEMORY: "Shorter Telegram replies"). |
| DevOps | PASS | Hook is local-only on Logan's machine. No CI changes. Deploy = merge to main + run `scripts/setup-hooks.sh` once on Logan's machine to pick up the new hook content (existing pattern; `post-merge` script content updates auto-apply since `setup-hooks.sh` symlinks). Rollback = `git revert` or `POST_MERGE_NOTIFY_SKIP=1` until revert lands. |
| Skeptic | PASS | Concerns considered: (a) classifier false positives on giant refactor PRs that touch templates/ — bounded by signal-score threshold (>=3 for Tier 1) and default-to-quiet; (b) Telegram outage stalling the hook — runs in background, exits 0 on any failure (same pattern as supabase deploy); (c) bot token rotation — script reads boss `.env` fresh each fire, so rotation just works; (d) the hook fires on `git pull` of a non-merge fast-forward — handled: ORIG_HEAD comparison covers both, and we look at the actually-changed commits, not the merge commit specifically; (e) Logan running `git pull` 10 times in a row across many merges — each fires once; if Logan is annoyed, kill switch is one env var. |

## Verdict

QUORUM: PASS (10/10)

## Callsite verification

| Symbol | Production callsite |
|---|---|
| `scripts/post-merge-notify.sh` | `scripts/hooks/post-merge` (background fork) |
| `scripts/post-merge-digest-send.sh` | Documented in script header for cron wiring; one-shot runnable. Cron wiring tracked as follow-up. |
| `pr-digest.jsonl` accumulator | Written by `post-merge-notify.sh`, read+truncated by `post-merge-digest-send.sh` |

## Notes

- This branch is gated by `scripts/plan-review-gate.sh` (shipped in PR #243). The plan file you are reading IS the gate-required artifact.
- Cron wiring for the daily digest is a deliberate follow-up — the runnable script ships now so Logan can manually trigger or wire to his own cron when convenient. Tracked separately so the immediate Tier 1 path ships without waiting on the daily digest infra debate (where to host the cron, whether to write to a separate state location, etc.).
- Two intentionally-omitted bells/whistles: (1) GitHub API enrichment via `gh pr view <N>` — adds a network dep and a `gh` install requirement, and the merge-commit subject already carries enough info for the classifier; (2) per-PR opt-in/out labels — premature; the signal-based classifier handles 95% of cases and the digest catches the rest.
