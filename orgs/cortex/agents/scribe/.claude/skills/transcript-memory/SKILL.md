---
name: transcript-memory
description: "Use when capturing, backfilling, auditing, or synthesizing full chat/session transcripts into Obsidian. This is the raw-record layer for Claude, Codex, Cortex agent messages, and Cortex task audit logs."
triggers: ["transcript", "every input", "every output", "chat archive", "full chat", "Obsidian transcript", "research paper from chats", "conversation memory", "raw memory"]
---

# Transcript Memory

The transcript archive is loss-preserving and source-grounded. Summaries and research papers sit on top of raw transcript notes; they never replace them.

## Layers

1. **Raw transcript archive**
   - Script: `scripts/vault-sync-chat-transcripts.mjs`
   - Output: `Vault/Research/cortextos/transcripts/`
   - Includes redacted Claude Code JSONL, Codex rollouts/history indexes, Cortex task audit JSONL, and Cortex agent message/runtime logs.

2. **Research synthesis**
   - Script: `scripts/vault-synthesize-chat-research.mjs`
   - Output: `Vault/Research/cortextos/chat-research/YYYY-MM-DD.md`
   - Extracts decisions, blockers, recurring patterns, operating-system failures, and improvement ideas with source links.
   - Uses each transcript note's `source_mtime_utc`, not the Obsidian note write time, so a full backfill does not make old chats look recent.

3. **Operational memory promotion**
   - Decisions/episodes go to Neon through `cortextos bus log-decision` and `log-episode`.
   - Durable docs and research papers get ingested to KB.
   - Scribe updates `Cortex Index.md` and `State/Fleet.md` so Logan can see the surfaces.

## Normal Hourly Sync

```bash
node /Users/loganbronstein/cortextos/orgs/cortex/agents/scribe/scripts/vault-sync-chat-transcripts.mjs
```

## Full Historical Backfill

This can mirror more than 1 GB of source material. Run only when the user wants a full backfill.

```bash
SYNC_ALL=1 MAX_FILES=0 node /Users/loganbronstein/cortextos/orgs/cortex/agents/scribe/scripts/vault-sync-chat-transcripts.mjs
```

After backfill, run a secret scan before treating the archive as clean:

```bash
rg -n "postgres(ql)?://|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|[0-9]{8,12}:[A-Za-z0-9_-]{25,}" \
  "/Users/loganbronstein/Sale Advisor/Vault/Research/cortextos/transcripts" || true
```

## Research Paper

```bash
node /Users/loganbronstein/cortextos/orgs/cortex/agents/scribe/scripts/vault-synthesize-chat-research.mjs
```

## Rules

- Redact secrets before writing to Obsidian.
- Preserve raw source bodies inside transcript notes.
- Do not use summaries as the only memory layer.
- Every synthesis claim must link to source transcript notes.
- Daily research must prioritize recent source conversations, not recently rewritten archive notes.
- Ingest research papers to KB after generation.
