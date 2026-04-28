# Cortex LLM-Wiki Memory Source Map

Date: 2026-04-28
Owner: scribe
Status: active

## What is canonical

The canonical pattern is Andrej Karpathy's LLM-wiki gist, dated 2026-04-04.
It defines three operations:

- Ingest: turn raw sources into maintained wiki pages, update indexes, record what changed.
- Query: answer from the wiki with citations, then optionally save valuable answers back into the wiki.
- Lint: periodically health-check contradictions, stale claims, broken links, orphan pages, and missing concepts.

Graphify is not one of Karpathy's three operations. Cortex treats Graphify as the fourth operational pillar because Logan explicitly wants a structural graph layer and because the Cortex plan already selected `safishamsi/graphify` for weekly topology review.

Older Cortex notes mentioned "Bryce Robbie" as a source name, but the later v3 plan says that name returned no useful source result and was dropped. Do not treat Bryce Robbie as one of the repos unless a real source is provided later.

## Repo/tool definitions

### AgriciDaniel/claude-obsidian

Source: `https://github.com/AgriciDaniel/claude-obsidian`

Role: closest full "Obsidian as a self-organizing AI brain" reference. This is probably the source Logan was remembering when he said "that guy" and asked about the extra skills. It is based on Karpathy's LLM-wiki pattern, ships wiki commands, and includes the optional DragonScale memory extension.

Cortex decision: do not copy this repo wholesale into Cortex. Cortex already has agents, bus tasks, Obsidian surfaces, transcript capture, and Neon logging. Use it as the strongest reference design for hot cache, save/fold, research papers, lint, and cross-project vault usage.

### DragonScale extension in claude-obsidian

Source: `https://github.com/AgriciDaniel/claude-obsidian/releases/tag/v1.6.0`

Role: optional extension with four mechanisms:

- Fold operator: extractive rollups of logs into fold pages.
- Deterministic page addresses: stable frontmatter IDs for wiki pages.
- Semantic tiling lint: find pages that should be split or reorganized.
- Boundary-first autoresearch: use graph/frontier gaps to suggest research candidates.

Cortex decision: implement these as Cortex-native operations, not as a separate cloned vault. Current mapping:

- Fold operator: `cortextos bus vault fold` runs scribe's source-linked chat-research synthesis over raw transcript notes.
- Deterministic page addresses: new transcript and chat-research notes get stable `id:` frontmatter; `cortextos bus vault lint` reports generated Cortex notes still missing IDs before any broad backfill.
- Semantic tiling lint: `cortextos bus vault lint` now reports large notes that need tiling or fold rollups.
- Boundary-first autoresearch: `cortextos bus vault lint` now reports repeated missing targets and useful orphans as research candidates; Graphify provides the heavier structural layer.
- Runtime memory gate: inbound Telegram messages now tell agents to search Vault first, and `cortextos bus send-telegram` blocks substantive replies until a `cortextos bus vault search` has run after the latest inbound message.

### Karpathy LLM Wiki gist

Source: `https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f`

Role: primary specification. It is not an installable app. It is the operating model Cortex must implement.

Important detail: the gist calls QMD optional search tooling. It does not make QMD the memory system.

### atomicmemory/llm-wiki-compiler

Source: `https://github.com/atomicmemory/llm-wiki-compiler`

Role: closest current repo-style implementation of the Karpathy pattern. It exposes `llmwiki ingest`, `compile`, `query`, `lint`, `watch`, and MCP tools such as `ingest_source`, `compile_wiki`, `query_wiki`, and `lint_wiki`.

Cortex decision: do not replace Cortex with this repo. Use it as a benchmark for what first-class operations should feel like: explicit commands, provenance, review queue, saved queries, lint diagnostics, and agent integration.

### nvk/llm-wiki

Source: `https://github.com/nvk/llm-wiki`

Role: more expansive agent-skill implementation. It has `/wiki:ingest`, `/wiki:query`, `/wiki:lint`, research, output generation, project manifests, and librarian scans.

Cortex decision: use as a feature benchmark, not as the substrate. Its research/project workflow is useful, but Cortex already has bus tasks, agents, Obsidian, Neon, and scribe ownership.

### SamurAIGPT/llm-wiki-agent

Source: `https://github.com/SamurAIGPT/llm-wiki-agent`

Role: lightweight agent skill with `/wiki-ingest`, `/wiki-query`, and `/wiki-lint`. This may be the "S" repo Logan remembered.

Cortex decision: use as another naming/UX reference. The underlying operations match Karpathy, but Cortex needs stronger multi-agent ownership and audit logging than this alone provides.

### tobi/qmd

Source: `https://github.com/tobi/qmd`

Role: retrieval/search tool. QMD is not the full memory format. It supports Query by giving agents hybrid BM25/vector/LLM-reranked search over markdown.

Cortex decision: use QMD through `cortextos bus vault search` when available, with KB and grep fallback.

### kepano/obsidian-skills

Source: `https://github.com/kepano/obsidian-skills`

Role: Obsidian writing and formatting guidance: CLI/daily-note conventions, Obsidian-flavored markdown, Bases, canvas JSON, and web extraction.

Cortex decision: supporting skill set only. It helps write valid Obsidian notes; it is not the memory loop.

### safishamsi/graphify

Source: `https://github.com/safishamsi/graphify`

Role: weekly structural graph layer. It analyzes topology and supports query/path/explain over `graph.json`.

Cortex decision: first-class fourth pillar through `cortextos bus vault graphify`.

## Cortex implementation contract

Cortex must expose four first-class operations:

```bash
cortextos bus vault fold
cortextos bus vault ingest
cortextos bus vault search "<query>"
cortextos bus vault lint
cortextos bus vault graphify
```

Every agent uses the same rule:

1. Capture raw truth into the transcript archive and append-only memory.
2. Fold raw transcript history into source-linked research papers for retrieval.
3. Before making a substantive user reply or durable claim, run Query. The Telegram reply path enforces this for direct Logan messages.
4. Promote useful findings through Ingest queues, not silent rewrites.
5. Run Lint as suggestions, not automatic mutation.
6. Run Graphify weekly to surface clusters, orphaned concepts, and high-centrality nodes.
7. Scribe owns transcript archive and research papers. Boss owns cross-agent synthesis. Agents do not write each other's canonical memory files.
