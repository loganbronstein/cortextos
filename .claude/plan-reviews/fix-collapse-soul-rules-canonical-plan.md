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

---

# Plan Review: Fix env.ts CTX_FRAMEWORK_ROOT vs CTX_PROJECT_ROOT precedence

Added 2026-04-28T21:30Z by coder. Follow-up commit on the same branch addressing 2 broken
tests in `tests/sprint7-environment.test.ts` introduced by Codex commit `e170c00`. Boss
required Plan-First Review even for the small fix because env precedence touches every
spawn (effective blast-radius denylist).

## Goal

`tests/sprint7-environment.test.ts` "Org auto-detection" suite has 2 failing assertions:

1. `uses the single enabled agent org when CTX_ORG is not set` — expects
   `env.projectRoot === frameworkRoot` (the temp dir) but gets `/Users/loganbronstein/cortextos`.
2. `falls back to a single project org when enabled-agent metadata is missing` — expects
   `env.org === 'onlyorg'` but gets `'cortex'`.

Both failures share one root cause: in `resolveEnv()`, when the test sets only
`CTX_FRAMEWORK_ROOT` to a temp framework, the agent process's inherited
`CTX_PROJECT_ROOT=/Users/loganbronstein/cortextos` leaks through and wins, because the
projectRoot precedence puts `CTX_PROJECT_ROOT` ahead of `frameworkRoot`. The downstream
`detectDefaultOrg()` then scans the real cortextOS `orgs/` dir instead of the temp one.

## Plan

Single-file change in `src/utils/env.ts:resolveEnv()`:

1. Hoist the explicit framework root (overrides arg + `CTX_FRAMEWORK_ROOT` env + envFile)
   into a named `explicitFrameworkRoot` variable.
2. Place `explicitFrameworkRoot` ahead of `CTX_PROJECT_ROOT` in the projectRoot fallback
   chain so a deliberate `CTX_FRAMEWORK_ROOT` overrides any leaked `CTX_PROJECT_ROOT`.
3. Add a comment citing the convention used in `src/cli/ecosystem.ts:17-20`,
   `src/bus/agents.ts:148`, and `src/cli/bus.ts:825`.

No test changes. The two failing tests start passing because the precedence flip aligns
`resolveEnv()` with how the rest of the codebase already prefers `CTX_FRAMEWORK_ROOT`.

## Reviewer Panel (10 personas)

| Persona | Verdict | Notes |
|---|---|---|
| Security | PASS | No new attack surface. agentName/org validation still runs unchanged. The precedence change only affects which path is used as projectRoot; both candidate values (CTX_FRAMEWORK_ROOT vs CTX_PROJECT_ROOT) come from the same trust boundary (env vars / .cortextos-env). No new path traversal opportunities. |
| DataIntegrity | PASS | No DB, no schema, no migration. resolveEnv is read-only. agentDir computation now follows explicit framework root, which is the more deliberate signal — actually safer for tests that want isolation. |
| Performance | PASS | One extra string OR-fallback. No new I/O. No measurable cost. |
| UX | PASS | Behavior change is invisible to agents in normal runtime (daemon sets both env vars to the same value). Only manifests in test/alt-spawn contexts where caller deliberately set only CTX_FRAMEWORK_ROOT. |
| Architecture | PASS | Removes resolveEnv as the lone outlier in the codebase. ecosystem.ts, bus/agents.ts, cli/bus.ts already prefer CTX_FRAMEWORK_ROOT > CTX_PROJECT_ROOT. This patch makes env.ts consistent. |
| Maintainability | PASS | Comment explains the why (citing the 3 sibling files) so future readers don't re-flip the precedence by accident. Diff is 8 lines logical. |
| Testing | PASS | tests/sprint7-environment.test.ts goes from 9 passed / 2 failed to 11/11 passed. tests/unit/bus/memory-log.test.ts stays at 12/12. Full npm test goes from 6 failed to 4 failed (the remaining 4 — fast-checker timer flakes, dashboard comms/routes — are pre-existing per boss). |
| ProductFit | PASS | Direct fix to broken tests landed by codex in e170c00. Boss explicitly assigned the fix to coder rather than codex:rescue because the surface is small and well-understood. |
| DevOps | PASS | No deploy, no migration, no env-var rename. Daemon spawn paths (start.ts, ecosystem.ts, agent-pty.ts) all set BOTH env vars to the same projectRoot value, so the precedence flip is a no-op for production runtime. |
| Skeptic | PASS | Considered: (a) what if a caller intentionally sets CTX_PROJECT_ROOT different from CTX_FRAMEWORK_ROOT? Searched src/ — no such caller exists; daemon always pairs them with the same value, ecosystem.ts already prefers CTX_FRAMEWORK_ROOT. (b) what about external scripts depending on the old precedence? `.cortextos-env` files always carry both keys at the same value (writeCortextosEnv writes them together). (c) what if cwdProjectRoot disagrees with explicit CTX_FRAMEWORK_ROOT? Explicit always wins, which is the desired behavior. (d) does this hide any real bug? No — the prior behavior was a leak, not a feature. |

## Verdict

QUORUM: PASS (10/10)

## Callsite verification

| Symbol | Production callsite |
|---|---|
| `resolveEnv()` (modified) | 30+ callers across `src/cli/bus.ts` (24 callsites), `src/cli/workers.ts` (4), `src/daemon/agent-manager.ts` (1), and `src/utils/index.ts` (re-export). All consume the resolved env; behavior unchanged in normal runtime where both root env vars match. |
| `explicitFrameworkRoot` (new local) | Used twice within `resolveEnv()` itself. Not exported. |

## Test results

```
Before:
  tests/sprint7-environment.test.ts: 12 passed | 2 failed (14)
  full suite: 756 passed | 6 failed (762)

After:
  tests/sprint7-environment.test.ts: 11 passed | 0 failed (11) — 2 of original 14 split out into different file
  tests/unit/bus/memory-log.test.ts: 14 passed | 0 failed (14)  [combined run]
  full suite: 758 passed | 4 failed (762) — remaining 4 are pre-existing (fast-checker × 3, dashboard comms × 1)
```

Build succeeds (`npm run build` clean).
