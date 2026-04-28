# Memory Architecture Reference (Cortex Fleet)

> One canonical document for how the cortex fleet remembers things.
> Read this before adding anything to memory, KB, Neon, or Obsidian.
> Source spec: Logan's prior CortextOS Memory Architecture, adapted to this fleet 2026-04-21.

---

## The Four Layers

Every piece of information belongs in exactly ONE of these layers. If it could go in two, it goes in the higher-priority one and the other layer references it.

### 1. Neon Postgres → operational truth

**What lives here:**
- `agent_episodes`: meaningful events (task completion, triage, dispatch, escalation, blocked state, governance action)
- `agent_decisions`: high-value decisions (architecture change, dispatch logic, override, vendor selection, governance call)
- Cross-agent readable, write-own per agent
- Append-only, no deletes, no in-place edits

**What does NOT go here:**
- Heartbeats (too noisy)
- Routine message ACKs
- Low-impact actions (file reads, cron ticks, kb queries)

**Connection:** `CORTEX_NEON_URL` in `orgs/cortex/secrets.env`. Database `neondb` on Neon project `cortex-fleet`.

### 2. Knowledge Base (Gemini embeddings + ChromaDB) → semantic retrieval

**What lives here:**
- Org doctrine docs (brand guide, business rules, client playbook, competitor notes)
- SOPs and playbooks
- Shared research findings (ingested after completing substantive research)
- Architecture reference docs (like this one)

**What does NOT go here:**
- Operational data that belongs in Neon
- Session-ephemeral context
- Secrets, credentials, auth tokens
- Raw logs (they should be summarized and THEN ingested if useful)

**Scope model:**
- `shared`: visible to every agent in the org
- `private` (per agent): visible only to that agent

**Connection:** `GEMINI_API_KEY` in `orgs/cortex/secrets.env`. ChromaDB at `~/.cortextos/default/orgs/cortex/knowledge-base/chromadb`.

### 3. Session memory (MEMORY.md + daily files) → session continuity

**What lives here:**
- `MEMORY.md` per agent: long-term learnings, business context, user preferences, team roster, strategic framing
- `memory/YYYY-MM-DD.md` per agent: today's WORKING ON, COMPLETED, BLOCKED entries. Resets daily.
- Lightweight, written in prose, meant to be read at session start and during heartbeats

**What does NOT go here:**
- Structured events (those go to Neon `agent_episodes`)
- Decisions (those go to Neon `agent_decisions`)
- Docs other agents should query (those go to KB)

**When to promote:** if a memory entry is useful to more than one agent, it should be ingested to KB. If it is a decision with a lifecycle, it should be written to Neon.

### 4. Obsidian vault → human-readable memory surface

**What lives here:**
- Logan's strategic notes (decisions, plans, architecture thinking)
- Client files, competitor research, ad strategy, brand guide
- Scribe-owned daily briefs, conflict scans, onboarding kits, Fleet state, and redacted recovery ledgers
- Linked summaries of agent outputs that Logan needs to inspect or reuse

**What does NOT go here:**
- Unredacted raw logs, credentials, or secrets
- Noisy terminal streams that do not help recovery
- Operational truth that belongs in Neon or task JSON

**Enforcement:** Scribe curates structure and writes memory products. Agents must not overwrite script-owned Daily Notes message blocks or synced `Research/cortextos/{agent}/MEMORY.md` mirrors.

**Location:** `projects/vault/` symlink in each agent's working directory.

---

## The Canonical-Home Rule

Every piece of data has exactly ONE canonical home. Duplication is drift. When you need to reference data from another layer, you READ from there, you do not copy.

Example mappings:

| Data type | Canonical layer |
|---|---|
| "Task 43 completed by coder at 02:15 UTC" | Neon `agent_episodes` |
| "I decided to use Neon instead of Supabase for fleet data" | Neon `agent_decisions` |
| "Logan's sleep window is 23:00 to 06:30 Chicago" | `USER.md` (session memory) |
| "Logan cannot read code" | `USER.md` + KB (shared) |
| "Sale Advisor is Logan's primary live business" | `MEMORY.md` + KB (shared) |
| "Brand voice guide" | Obsidian vault (owned by Logan) + KB (shared, ingested from vault) |
| "Today I fixed the pricing lint error" | `memory/YYYY-MM-DD.md` (session memory) |
| "Running analyst overnight task: pricing readiness check" | Neon `agent_episodes` |
| "Here is what I learned about the eBay Browse API rate limits" | KB (shared, ingested after research) |
| "What did every agent do today?" | Obsidian `Daily/YYYY-MM-DD.md` scribe brief, backed by task logs/session memory |

If two layers disagree, Neon wins for operational truth, KB wins for shared doctrine, session memory wins for "what did I do today."

---

## Agent Memory Profiles

**Rule: No agent is deployed without a completed memory profile.**

Every agent declares what types of episodes and decisions it is authorized to write. The bus enforces this. An agent cannot log episode types outside its profile.

Profile location: `.claude/memory-profile.json` per agent.

### Profile schema

```json
{
  "agent_name": "boss",
  "role": "orchestrator",
  "allowed_episode_types": ["task_dispatched", "briefing_sent", "approval_routed", "goal_cascade", "agent_spawned", "agent_onboarding_complete", "session_start", "session_end"],
  "disallowed_episode_types": ["code_pushed", "deploy_executed", "experiment_run"],
  "allowed_decision_types": ["architecture", "dispatch_logic", "governance", "agent_roster", "cron_schedule", "approval_policy"],
  "disallowed_decision_types": ["code_refactor", "vendor_selection_for_third_party_services"],
  "importance_rules": {
    "high": ["agent_spawned", "goal_cascade", "architecture"],
    "medium": ["task_dispatched", "briefing_sent", "approval_routed"],
    "low": ["session_start", "session_end"]
  },
  "linked_entities": ["agents", "tasks", "approvals", "goals"],
  "logging_boundaries": {
    "never_log": ["heartbeat_pulse", "cron_tick", "inbox_ack"],
    "always_log": ["task_dispatched", "briefing_sent", "approval_routed"]
  },
  "summary_behavior": "daily + weekly",
  "escalation_thresholds": {
    "stuck_task_hours": 2,
    "unanswered_approval_hours": 4,
    "silent_agent_hours": 5
  }
}
```

### Memory profiles required at deployment

- `boss`: orchestrator profile (above)
- `analyst`: data, metrics, system health, autoresearch
- `coder`: full-stack build, Sorzo primary, SA secondary
- `marketing`: Sale Advisor and Sorzo marketing/content strategy
- `scribe`: memory surface, Obsidian structure, daily briefs, conflict scans, onboarding kits
- Any future agent: profile drafted by boss, reviewed by Logan, before enable

---

## What We Only Log (High-Signal Events)

Not every action is memory-worthy. Log only:
- Task lifecycle events (dispatched, accepted, completed, blocked, escalated)
- Briefings sent
- Approvals routed
- Agent lifecycle (spawn, onboarded, stopped, restart after crash)
- Goal cascades
- Architecture and dispatch decisions
- Guardrail triggers (a hard-guardrail nearly crossed)
- Nighttime-mode transitions

NEVER log:
- Heartbeats (they belong in the heartbeat table, not episodes)
- Cron ticks that did nothing
- Inbox ACKs on routine no-reply messages
- KB queries (too high volume)
- File reads

---

## Enforcement

1. **KB ingestion allowlist.** `orgs/cortex/kb-allowlist.json` declares which paths are allowed to be ingested. `cortextos bus kb-ingest` refuses paths outside the allowlist. (To be implemented in phase 2 of this architecture rollout.)
2. **Obsidian read-only for agents.** `projects/vault/` symlink is the mount. Vault folders we want protected are chmod 555, policy files chmod 444. Phase 2.
3. **Memory profile enforcement.** The bus `log-episode` and `log-decision` commands reject calls from agents whose profile disallows the type. Shipped 2026-04-28.
4. **Append-only Neon.** Database user `neondb_owner` grants INSERT and SELECT on episodes and decisions tables to agent service accounts, not UPDATE or DELETE. Phase 1 (initial schema).

---

## Rollout Phases

**Phase 1 (2026-04-21 overnight):**
- This document written, committed to repo
- Neon schema for `agent_episodes` and `agent_decisions` designed and applied
- Initial memory profiles for boss, analyst, coder drafted
- Bash wrappers for episode/decision logging created

**Phase 2A (2026-04-28):**
- First-class TypeScript `cortextos bus log-episode` and `log-decision` commands shipped
- Memory profile enforcement inside `log-episode` and `log-decision` shipped for all five primary agents
- `add-agent` seeds `ctx_autoreset_threshold = 55` and default agent config now includes `ctx_autoreset_threshold: 55`

**Phase 2B (remaining):**
- KB ingestion allowlist enforced in kb-ingest.sh
- Obsidian chmod enforcement
- Migrate existing `cortextos bus log-event` sources that qualify as episodes onto log-episode

**Phase 3 (within a week):**
- Retrospective ingestion: populate agent_episodes from existing event logs
- Cleanup: archive old CMEM and Hive-era storage, dedupe KB if noisy
- Analyst adds episode queries to dashboard

**Phase 4 (when justified):**
- Graphiti or similar graph layer on top of Neon for entity relationships, if query patterns show we need it

---

## For Future Agents

If you are a new agent reading this for the first time:

1. Your memory profile is at `.claude/memory-profile.json`. Read it.
2. When you do something memory-worthy, call `cortextos bus log-episode` or `log-decision` with a type in your allowed list. The bus rejects types you are not authorized for.
3. Write session context to `MEMORY.md` and daily files as you work.
4. Ingest shared findings to the KB with `cortextos bus kb-ingest --scope shared`.
5. Do not dump raw memory into Obsidian. Scribe publishes linked, redacted, human-readable summaries and recovery ledgers there.
6. Never delete anything. Append only.

---

*Last updated: 2026-04-28T17:25:00Z by Codex during Cortex memory/scribe audit.*
