# Organization Knowledge Base

Shared facts, context, and institutional knowledge for all agents in this org. Read on every session start. Update when you learn something that all agents should know.

<!--
  This file is the org's shared brain. It should contain:
  - Business facts that don't change often (what the company does, key products, team)
  - Technical context (repos, infrastructure, deployment targets)
  - Key people and their roles
  - Important links and resources
  - Decisions that were made and why

  It should NOT contain:
  - Ephemeral task details (use tasks for that)
  - Agent-specific knowledge (use agent MEMORY.md)
  - Secrets or credentials (use .env files)
-->

## Business

<!-- What does this org do? Key products/services, business model, stage -->

## Team

<!-- Key people, their roles, how to reach them -->

## Technical

<!-- Repos, infrastructure, deployment targets, key services -->

- Cortex knowledge uses a hybrid of the live runtime gate plus the original Cortex Knowledge System v3 one-brain architecture.
- Runtime enforcement: substantive Telegram replies must run `cortextos bus vault search "<topic>" --no-rerank -n 5` before `send-telegram`; `send-telegram` blocks replies without a fresh Vault search marker.
- Obsidian surface: Logan's canonical brain is `/Users/loganbronstein/Sale Advisor/Vault`. Cortex agent knowledge should be visible under `/Users/loganbronstein/Sale Advisor/Vault/Cortex/` via symlinks to `orgs/cortex/agents/<agent>/vault/`.
- Ownership rule: each agent writes canonical notes only inside its own `vault/` subtree. Cross-agent edits go through `_proposals-from-others/` and confirmed promotions, not direct cross-writes.
- Runtime config stays in `orgs/cortex/agents/<agent>/` files such as `AGENTS.md`, `SOUL.md`, `config.json`, and `goals.json`; the `vault/` trees are browsable knowledge, not operational config.
- Scribe still owns redacted transcript/chat research surfaces under `Vault/Research/cortextos/`; those are source archives and research papers, while `Vault/Cortex/` is the durable agent-owned knowledge surface.
- Do not dump every durable note into `Vault/Cortex/`. Cortex is the agent operating-memory layer. Domain knowledge should route to its natural Vault home: pricing to `Research/Pricing/` or `Pricer Accuracy.md`, Sorzo to `Research/Sorzo/`, marketing to `Marketing/`, client/ops facts to `Clients/`, `Leads/`, `Operations.md`, decisions/rules to `Decisions.md`, `Rules/`, and business ideas to `Ideas.md`, `Revenue Model.md`, or `Launch Plan.md`.
- Scribe/boss should use `cortextos bus vault route` after `vault fold` to produce a source-linked routing queue before promoting memory into canonical domain notes.
- Graphify is a required memory layer, not replaceable by simple wikilink scanning. Agents should use `/Users/loganbronstein/Sale Advisor/Vault/graphify-out/GRAPH_REPORT.md` for community/god-node orientation and `graphify query` for graph traversal. Wikilinks remain the Obsidian-native source/domain linking layer; Karpathy Ingest/Query/Lint remains the operating loop.

## Key Links

<!-- Dashboards, docs, tools, reference material -->

## Decisions Log

<!-- Important decisions and their rationale. Format: YYYY-MM-DD: decision - why -->
