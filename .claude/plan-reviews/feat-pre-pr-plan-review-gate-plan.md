---
branch: feat/pre-pr-plan-review-gate
task: task_1776901569063_764
created: 2026-04-25T02:05:00Z
---

# Plan Review: Pre-push Plan-First Review gate

## Goal

Close the W9b follow-up from PR #216. The Plan-First Review rule (10-persona
panel before push, from Bradley Banner via Logan 2026-04-22) is currently
enforced by convention only. Add a tool-level git `pre-push` gate so the
rule can't be skipped by accident, while keeping a documented bypass for the
cases where the rule itself is the blocker.

## Plan

- `scripts/plan-review-gate.sh` (new, 162 lines, macOS bash 3.2 compatible):
  the gate itself. Resolves branch → plan file slug, exits 0 on protected
  branches, supports `PLAN_REVIEW_BYPASS=true`, accepts two plan shapes
  (full 10-persona quorum ≥ 8 with mandatory Security + DataIntegrity PASS,
  OR a single-line `TRIVIAL-TASK-EXEMPT: <reason>`). Best-effort telemetry
  via `cortextos bus log-event` so every pass/bypass/exemption is visible
  on the dashboard.
- `scripts/hooks/pre-push` (modified): invoke the gate BEFORE `npm run
  build` + tests so the push fails fast on missing plan instead of burning
  2 minutes of test runtime first.
- `.gitignore` (modified): flip `.claude/` from blanket ignore to
  `.claude/*` + explicit re-includes, and add `!.claude/plan-reviews/` +
  `!.claude/plan-reviews/**` so plan files are tracked across clones and
  visible in the PR diff.
- `.claude/plan-reviews/README.md` (new): author-facing explanation of the
  rule, file location, two acceptable shapes, bypass, protected branches.
- `.claude/plan-reviews/TEMPLATE-plan.md` (new): copy-paste scaffold with
  the 10-persona table + QUORUM line.
- Test plan: 9 scenarios exercised against a scratch repo before commit
  (missing plan BLOCK, trivial exempt PASS, empty trivial reason BLOCK,
  full 8/10 PASS, 7/10 BLOCK, Security FAIL BLOCK, Security missing BLOCK,
  BYPASS env PASS, protected main PASS). All behaved as specified.
- Acceptance: pre-push on a feature branch with no plan file blocks with a
  readable coaching message; trivial-exempt and full-quorum paths let the
  push through; bypass works; main/master never gated.

## Reviewer Panel (10 personas)

| Persona | Verdict | Notes |
|---|---|---|
| Security | PASS | Gate is read-only against the plan file; no auth surface, no secrets. Bypass env var is logged to telemetry so abuse is discoverable post-hoc. Script uses `grep -E` patterns on file contents, no eval. |
| DataIntegrity | PASS | No migrations, no DB writes. Modifies only local git hook + adds new script. `.gitignore` change re-includes a path but does not un-ignore anything sensitive (plan-reviews only). Rollback = `git revert`. |
| Performance | PASS | Gate is 3 greps against a small markdown file, runs once per `git push`. Adds <50 ms to the push path; insignificant next to the 2-min build/test that follows. |
| UX | PASS | Error messages name the expected file path, the template to copy, the trivial-exempt format, the bypass escape, and the spec source. The coaching block is the primary UX surface — deliberately verbose. |
| Architecture | PASS | Single-responsibility script, invoked by the hook via subshell, uses env vars for test seams (`PLAN_REVIEW_DIR`, `PLAN_REVIEW_BRANCH`, `PLAN_REVIEW_PROTECTED_REGEX`). No coupling to the rest of the codebase beyond the optional telemetry call. |
| Maintainability | PASS | Pure shell, bash 3.2 compatible (no `mapfile`, no `readarray`), banner comment explains the spec source and exit codes, env-var overrides are documented inline. |
| Testing | PASS | 9 scenarios manually run pre-commit. CI-level tests are deferred — shell hook tests are awkward in this repo and the gate is small enough that the 9-case matrix is the honest coverage. Trade-off accepted. |
| ProductFit | PASS | Direct Logan ask (2026-04-22) to make the Plan-First rule unskippable, logged as W9b follow-up in PR #216. This branch is exactly that follow-up. |
| DevOps | PASS | Hook is local-only (`scripts/hooks/pre-push`), not CI. Deploy = merge to main. Rollback = `git revert` or `PLAN_REVIEW_BYPASS=true` until revert lands. No new env vars required in prod. |
| Skeptic | PASS | Concerns considered: (a) authors could `chmod -x` the gate — but they'd have to commit that change and it'd show up in review; (b) `--no-verify` skips all hooks — documented limitation of git itself, same as every other pre-push gate; (c) bootstrap paradox (this branch needs its own plan file) — resolved by shipping this very file. |

## Verdict

QUORUM: PASS (10/10)

## Callsite verification

| Symbol | Production callsite |
|---|---|
| `scripts/plan-review-gate.sh` | `scripts/hooks/pre-push` (invokes via `"$REPO_ROOT/scripts/plan-review-gate.sh"`) |
| `TEMPLATE-plan.md` | Referenced by `scripts/plan-review-gate.sh` coaching message ("cp .claude/plan-reviews/TEMPLATE-plan.md ...") and by `.claude/plan-reviews/README.md` |

## Notes

- This branch satisfies its own gate. The committed plan file contains a
  full 10/10 panel, so once the hook is installed on a fresh clone the
  push would pass cleanly.
- Future work (not in this branch): add a GitHub Actions check that
  re-runs the gate in CI for PRs opened from forks or local clones where
  the hook was bypassed. Tracked as a separate follow-up.
- The `.gitignore` flip from `.claude/` to `.claude/*` + re-includes is
  the standard pattern; the existing `!.claude/commands/` + `!.claude/
  orchestration-cortextos-node/` entries already rely on it working, so
  no existing ignore behavior changes.
