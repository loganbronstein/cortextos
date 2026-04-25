# Plan-First Review files

Every non-trivial branch in this repo must include a plan review file in this
directory before its first push. The pre-push hook (`scripts/hooks/pre-push`
+ `scripts/plan-review-gate.sh`) enforces the gate.

## File location

`.claude/plan-reviews/<branch-slug>-plan.md`

Branch slug = the branch name with `/` replaced by `-`. Examples:

| Branch | Plan file |
|---|---|
| `feat/jargon-lint-telegram` | `.claude/plan-reviews/feat-jargon-lint-telegram-plan.md` |
| `fix/dashboard-render` | `.claude/plan-reviews/fix-dashboard-render-plan.md` |
| `chore/bump-deps` | `.claude/plan-reviews/chore-bump-deps-plan.md` |

## Two acceptable shapes

### Full panel (default)

Copy `TEMPLATE-plan.md`, fill in the 10-persona reviewer table, and add a
`QUORUM: PASS (N/10)` line where N is the count of personas who voted PASS.
Minimum N is 8. Security and DataIntegrity must be present and not marked
FAIL/REJECT.

### Trivial-task exempt

For genuinely tiny work (typo, doc tweak, single-line config), the entire
file may consist of:

```
TRIVIAL-TASK-EXEMPT: <one-sentence reason>
```

The gate accepts this and logs it to telemetry so post-hoc review can spot
abuse.

## Override

`PLAN_REVIEW_BYPASS=true git push` skips the gate entirely. Logged to
telemetry. Use only when the rule itself is the problem (e.g. fixing the
gate script, emergency revert).

## Protected branches

Pushes from `main`, `master`, `develop` are not gated — those are merge
targets, not feature work. Override via `PLAN_REVIEW_PROTECTED_REGEX`.

## Spec source

SOUL.md "Plan-First Review (Logan directive 2026-04-22, from Bradley
Banner)" section. Codified fleet-wide via PR #216. This directory is the
implementation that closes the W9b follow-up: the rule was previously
enforced by convention only.
