# Fleet-rules canonical-policies pattern

When you have a fleet of agents (boss / coder / analyst / specialist) that
all need to follow the same rules — plan-first review, adversarial review
bar, callsite-verification, etc. — do NOT copy the rule body into every
agent's `SOUL.md`. That pattern drifts: a refinement to one copy doesn't
land in the others, and you end up with subtly different versions of the
same rule across the fleet.

Use a canonical-policies file in your org dir instead.

## Layout

```
orgs/
  <your-org>/
    policies/
      fleet-rules.md          ← canonical rule body lives here
    agents/
      boss/
        SOUL.md               ← @see refs to fleet-rules.md anchors
      coder/
        SOUL.md               ← @see refs to fleet-rules.md anchors
      ...
```

## Convention

In each agent's `SOUL.md`, replace the rule sections with one-line refs:

```markdown
## Plan-First Review
@see orgs/<your-org>/policies/fleet-rules.md#plan-first-review

(Optional) Agent-specific application: <one or two lines tuning the rule
to this agent's domain — analyst's autoresearch, orchestrator's worker
dispatch, marketing's campaign-vs-tweet line, etc.>
```

The `@see` line is the contract. The agent reads the canonical when it
boots (its boot loop reads `SOUL.md`, follows the `@see`, applies the
rule). Any agent-specific tuning lives BELOW the `@see` line in the
SOUL.

## How rules get added or changed

1. Edit the canonical (`orgs/<your-org>/policies/fleet-rules.md`).
2. The change applies fleet-wide on every agent's next boot.
3. If the change needs per-agent tuning, edit that agent's SOUL's
   "Agent-specific application" line in addition.
4. Do **NOT** copy the rule body back into a SOUL. That's the drift this
   pattern exists to prevent.

## Why not put the canonical in `templates/`?

`templates/agent/AGENTS.md` is the boot-level doc — it carries the rule
text inline so a NEW agent created via `cortextos add-agent` has the
rule available before the canonical exists in its copy of the org.
Once an agent is established in `orgs/<your-org>/agents/`, its
`SOUL.md` should be migrated to use the `@see` ref pattern; the rule
body in templates is the bootstrapping seed, not the long-term home.

## Reference implementation

The cortex org runs this pattern. See `orgs/cortex/policies/fleet-rules.md`
in the operator's local install (the `orgs/` directory is `.gitignore`d
because it's user-specific configuration, but the pattern is identical
across orgs that adopt it).

## Provenance

Filed as `task_1776901569224_336` after the W9b PR #216 follow-up
identified rule drift across 4 cortex agent SOULs (coder had 2 review-bar
sections that the other 3 lacked, etc.). Shipped as the durable fix.
