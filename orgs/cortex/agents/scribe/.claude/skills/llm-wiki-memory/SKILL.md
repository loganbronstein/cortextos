---
name: llm-wiki-memory
description: "Use for Cortex Obsidian memory work based on Karpathy's LLM-wiki pattern: ingest, query, lint, and weekly graphify."
triggers: ["llm wiki", "Karpathy", "ingest", "query memory", "lint memory", "graphify", "QMD", "Obsidian memory", "memory format", "wiki memory"]
---

# LLM-Wiki Memory

Canonical source: Karpathy's LLM-wiki gist. The real operations are **Ingest**, **Query**, and **Lint**. Cortex adds **Graphify** as the weekly structural graph layer.

Do not confuse tools with the pattern:
- `atomicmemory/llm-wiki-compiler`, `nvk/llm-wiki`, and `SamurAIGPT/llm-wiki-agent` are implementation references.
- QMD supports Query. It is not the whole memory system.
- kepano Obsidian skills support valid Obsidian writing. They are not the whole memory system.
- Graphify is the graph pillar.
- `AgriciDaniel/claude-obsidian` is the strongest full-vault reference design.
- DragonScale's four mechanisms map to Cortex as: fold transcript history into research papers, add stable IDs to new Cortex notes, lint large notes for semantic tiling, and use lint plus Graphify gaps for boundary-first research.

## Commands

```bash
cortextos bus vault fold
cortextos bus vault search "<claim or question>" --no-rerank
cortextos bus vault ingest
cortextos bus vault lint
cortextos bus vault graphify
```

## Rules

- Capture raw truth first. Summaries never replace source transcripts.
- Fold long raw transcript history into source-linked research papers before expecting agents to retrieve from it well.
- Before writing a durable claim about Logan, a decision, a project state, or a standing rule, run `vault search`.
- If prior memory conflicts, do not overwrite silently. Write the conflict with source links or route it to boss.
- Ingest creates promote queues and suggested updates. It does not silently rewrite canonical memory.
- Lint reports broken links, orphans, stale claims, missing provenance, and drift. It is suggestion-first.
- Graphify runs weekly or after major corpus changes to expose clusters and missing structure.
- Scribe owns transcript archive and research papers. Boss owns cross-agent synthesis.
- One writer per canonical memory surface. Cross-agent edits go through proposals.

Source map: `orgs/cortex/docs/llm-wiki-memory-source-map.md`.
