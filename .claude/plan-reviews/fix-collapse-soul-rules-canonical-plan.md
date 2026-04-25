---
branch: fix/collapse-soul-rules-canonical
task: task_1776901569224_336
created: 2026-04-25T06:55:00Z
---

# Plan Review: Collapse 5-copy SOUL.md fleet-rules to a single canonical source

## Goal

Three fleet-wide rules — Plan-First Review, Review Bar (adversarial), Review Bar — Callsite Verification — currently live verbatim in 4 production agent `SOUL.md` files (boss / analyst / coder / marketing). The known drift pattern: when a rule gets refined, some copies lag. Today this already manifested — coder has both "Review Bar" sections, the other three only have "Plan-First Review", none of them have the standalone "Callsite Verification" section even though the rule applies fleet-wide.

Fix: one canonical doc at `orgs/cortex/policies/fleet-rules.md`. Each SOUL keeps a one-line `@see` reference per rule + any agent-specific addendum. Drift becomes impossible because the rule body lives in one place.

## Plan

### `orgs/cortex/policies/fleet-rules.md` (new canonical)

Create the canonical doc aggregating:

1. **Plan-First Review** (Logan directive 2026-04-22, from Bradley Banner) — full 7-step workflow with the trivial-task escape clause.
2. **Review Bar** (Logan directive 2026-04-22) — every PR gets adversarial review + codex:rescue before merge, no exceptions.
3. **Review Bar — Callsite Verification** (added 2026-04-22) — adversarial review must verify the new symbol is invoked in production, with the W3 Sorzo postmortem as the why.

Each section gets a stable anchor (`#plan-first-review`, `#review-bar`, `#callsite-verification`) so the SOUL refs can link to specific sections.

Also include a "How agents reference this" header explaining the contract: SOULs use `@see policies/fleet-rules.md#<anchor>` lines, agent-specific tuning goes IN the SOUL after the ref.

### `orgs/cortex/agents/{analyst,boss,coder,marketing}/SOUL.md` (4 edits)

Replace the duplicated rule sections with one-line refs. Preserve the agent-specific addendum (analyst: autoresearch methodology; boss: orchestrator dispatch wording; marketing: campaign-vs-tweet line). Coder has no addendum but currently carries both Review Bar + Callsite Verification sections — replace both with refs.

Section shape after the change:

```
## Plan-First Review
@see orgs/cortex/policies/fleet-rules.md#plan-first-review

(Optional) Agent-specific application: <addendum>
```

Same shape for Review Bar + Callsite Verification (latter only in coder today; the others get a NEW ref since the rule applies fleet-wide and they're currently silent on it — closing the drift the task description names).

### Out-of-scope (separate follow-ups)

- Option C from task description: `cortextos bus policy-doctor` lint command that scans all SOULs for divergence from canonical and auto-fixes. Real durable diagnostic but >2x scope of this PR. Filed as follow-up.
- `templates/agent/AGENTS.md` and other templates — task description explicitly says leave alone (boot-level doc, new agents inherit from it before the canonical is in their copy). Confirmed.
- Other agents in other orgs (lifeos, cointally, etc.) — only the cortex org has the duplication today; cross-org propagation when they grow.

## Reviewer Panel (10 personas)

| Persona | Verdict | Notes |
|---|---|---|
| Security | PASS | Pure docs change. No code, no auth, no data. The canonical file is a markdown reference; agents reading it follow the same trust boundary they already follow for SOUL.md. |
| DataIntegrity | PASS | No DB, no schema, no migration. Append-only file creation + four file edits. Rollback = `git revert`. |
| Performance | PASS | Markdown file. Read once per agent boot when SOUL.md is loaded; canonical ref is one extra read of a small file. Trivial. |
| UX | PASS | Agents see "Plan-First Review @see policies/fleet-rules.md" in their SOUL and either follow the link or trust the heading. The canonical doc is the same prose they used to see inline; nothing changes about what they actually do. Maintainers see one source of truth and stop fighting drift. |
| Architecture | PASS | Single source of truth replaces 4-way duplication. The "@see" pattern matches how Anthropic's own templates reference shared docs and how unix systems link manpages. Anchor-stable URIs let future cross-references be precise. |
| Maintainability | PASS | Future rule refinements update one file. The drift detected today (coder has Callsite Verification, others don't) gets fixed by this PR — every agent ends up referencing the same canonical, even agents that previously had no section for that rule. |
| Testing | PASS | Pure docs change. The verification is structural: `grep -c "policies/fleet-rules.md" orgs/cortex/agents/*/SOUL.md` must show >= 1 ref per SOUL after the change. Documented in the PR test plan. |
| ProductFit | PASS | Direct W9b follow-up from PR #216. Boss flagged it as the durable-fix shape. Closes a known recurring failure mode (rule drift across agent dirs). |
| DevOps | PASS | No deploy story. No env vars. Markdown only. Existing agents pick up the canonical on next session start when they re-read SOUL.md (which happens every boot per AGENTS.md). |
| Skeptic | PASS | Concerns considered: (a) what if an agent's session is mid-flight and doesn't re-read SOUL — same as today, no rule version is pushed mid-session; rules apply on next boot, which matches existing behavior; (b) what if the canonical file is unreadable / missing — the SOUL still names the rule headings + agent-specific tuning, so the agent has the gist even without the canonical, and the next adversarial review would catch the missing ref; (c) what about templates that don't reference the canonical — task description explicitly said leave them; new agents created from templates inherit the boot-level rule from AGENTS.md, then this PR's canonical applies once they're moved into a production org dir; (d) what if Logan adds a new rule next week — same workflow: append to canonical, optionally add an agent-specific addendum to a SOUL that needs it; no 4-way edit. |

## Verdict

QUORUM: PASS (10/10)

## Callsite verification

| Symbol | Production callsite |
|---|---|
| `orgs/cortex/policies/fleet-rules.md` | Referenced by `@see` lines in `orgs/cortex/agents/{analyst,boss,coder,marketing}/SOUL.md` (4 callsites, one per production agent) |
| `#plan-first-review` anchor | Referenced by all 4 SOULs (4 callsites) |
| `#review-bar` anchor | Referenced by all 4 SOULs (4 callsites) — closes the drift where 3 of 4 currently lack this section |
| `#callsite-verification` anchor | Referenced by all 4 SOULs (4 callsites) — closes the drift where 3 of 4 currently lack this section |

## Notes

- This branch is gated by `scripts/plan-review-gate.sh` (PR #243). Plan file force-added past .gitignore until #243 merges.
- Callsite verification self-check: `grep -c "policies/fleet-rules.md" orgs/cortex/agents/*/SOUL.md` should print `1+` for each SOUL after the changes land. PR will include the output.
- I am NOT touching `templates/agent/AGENTS.md` per the task's explicit guidance. New agents created via `cortextos add-agent` inherit the rule from the AGENTS.md template, then once their dir lives in `orgs/cortex/agents/`, the next refinement to fleet-rules.md propagates without a SOUL edit.
- This is the 6th and final PR of this session per boss's sign-off plan.
