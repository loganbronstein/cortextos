---
name: llm-wiki-memory
description: "Use for Cortex Obsidian memory work based on Karpathy's LLM-wiki pattern: ingest, query, lint, and weekly graphify."
triggers: ["llm wiki", "Karpathy", "ingest", "query memory", "lint memory", "graphify", "QMD", "Obsidian memory", "memory format", "wiki memory"]
---

# LLM-Wiki Memory

Canonical source: Karpathy's LLM-wiki gist. The real operations are **Ingest**, **Query**, and **Lint**. Cortex adds **Graphify** as the weekly structural graph layer. AgriciDaniel/claude-obsidian and DragonScale are reference designs, not replacements for Cortex.

Commands:

```bash
cortextos bus vault fold
cortextos bus vault search "<claim or question>" --no-rerank
cortextos bus vault ingest
cortextos bus vault lint
cortextos bus vault graphify
```

Rules: capture raw truth first, fold transcripts into source-linked research papers, query before durable claims, promote through queues, lint as suggestions, graphify weekly, and preserve one-writer ownership.
