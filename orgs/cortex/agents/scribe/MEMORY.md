# Long-Term Memory

## Operating rule (Logan, 2026-04-27)
Before touching the vault or anything in general: think first, plan every word, weigh pros and cons in excruciating detail, then act. Always. This is rule #1 — not a guideline.

## Vault canonical structure (from Boss, 2026-04-27)

### Where I write (UPDATED 2026-04-27, second pass — Logan called Boss out, lanes are wider than first thought)
I can write ANYWHERE in the vault. Add value where it matters. The only carve-outs are narrow real overwrite risks below.

Suggested primary homes (not exclusive — write wherever it adds value):
- `Daily/<YYYY-MM-DD>.md` — my daily morning brief
- `Decisions/Log/<YYYY-MM-DD>.md` — captured decisions with rationale
- `Decisions/Open.md` — mine to enrich (mtime-check before overwriting boss's parallel edits)
- `People/<Name>.md` — relationship + context pages (enrich existing `Entities/` stubs, don't duplicate — 55 already exist)
- `Projects/<Name>.md` — Sale Advisor, Sorzo, Lakeshore Hauling, Risk Digital
- `Onboarding/<agent-name>.md` — per-agent onboarding kits (capability #5)
- `Reports/scribe-<scope>/<YYYY-MM-DD>.md` — cron-generated outputs
- `Research/cortextos/{agent}/` — anywhere here EXCEPT MEMORY.md and MEMORY_ARCHITECTURE.md
- `Daily Notes/<date>.md` — APPEND new sections, do NOT modify the script-written message blocks

### Do NOT touch (NARROW HARD CARVE-OUTS)
1. **Script-written message blocks inside `Daily Notes/<date>.md`** — vault-sync-telegram wrote them. Adding new sections to those files is fine; modifying existing message blocks is not.
2. **`Research/cortextos/{agent}/MEMORY.md`** and **`Research/cortextos/{agent}/MEMORY_ARCHITECTURE.md`** — these two specific files get copied over from each agent's source dir on every sync. My edits would be wiped. Everything else under `Research/cortextos/{agent}/` persists and is fine to enrich.
3. **Files Logan touched manually in the last 12h** — mtime check before every overwrite to protect his live edits. Adding new sections to such a file is okay if I am careful not to clobber his recent text.

### Frontmatter schema (every entry I write)
```
---
type: <daily-brief|decision|people|project|onboarding|distillation|conflict-scan|...>
source_agent: <which agent produced source>
source_task: <task_id if any>
date_utc: <ISO at write>
last_updated_utc: <ISO on every modification>
people: [list of [[Name]] wikilinks]
project: <Sale Advisor|Sorzo|...>
tags: [#flat-tags]
related: [[other pages]]
status: <active|archived|superseded>
superseded_by: <file path if superseded>
confidence: <high|med|low>
---
```
Confidence: low = inferred/distilled, high = direct citation.

### Naming + linking
- Dates: ISO 2026-04-27, UTC always
- Titles: sentence case, descriptive (e.g. `Logan rejected aggressive bg removal 2026-03-22.md`)
- Wikilinks: every named entity with a page in Entities/ or People/ — format `[[Logan Bronstein]]`, `[[Sale Advisor]]`, `[[eBay]]`
- Mirror exactly: `/Users/loganbronstein/Sale Advisor/Vault/Research/Index.md`

### Other writers to coordinate with
- boss: `Decisions/Open.md`, `Research/Index.md`, `Rules/Safety Net.md`, `Reports/safety-net/`, `Reports/memory-health/`
- vault-sync-telegram cron: `Daily Notes/<date>.md` (Telegram archive)
- vault-sync-agents cron: `Research/cortextos/{agent}/` rsync
- vault-entity-extractor cron: wikilinks plain text mentions across most .md files (skips Daily Notes, Templates, attachments)
- vault-stub-pages.py weekly: creates `Entities/<Name>.md` stubs
- vault-lint cron: `Reports/cortextos-lint/<date>.md`

### Boss's initial dispatch (READ-ONLY first cycle)
1. Read `Vault/Research/Index.md`, all 5 papers in `Research/cortextos/topic-papers/`, `Decisions/Open.md`, `Cortex Index.md`
2. Read all 5 agents' MEMORY.md at `Research/cortextos/{agent}/MEMORY.md`
3. Run cross-fleet conflict scan modeled on `boss/scripts/memory-trim.py` — extend to surface contradictions, write to `Reports/scribe-conflict-scan/<date>.md` (do NOT modify source files)
4. Plan-before-write checkpoint: send Boss proposed first 5 entries (what + where + why). After greenlight I write autonomously to my owned directories.

### Housekeeping
- `vault-sync-telegram.sh` now includes all five primary agents: boss, analyst, coder, marketing, and scribe.
- `scripts/vault-sync-agent-logs.sh` is my owned recovery ledger. It mirrors redacted runtime logs into `Vault/Research/cortextos/_agent-logs/YYYY-MM-DD.md` so compact/restart recovery can see recent agent inputs/outputs without dumping secrets into Obsidian.
- `scripts/vault-sync-chat-transcripts.mjs` is my owned full transcript archive. It mirrors redacted Claude, Codex, Cortex task-audit, and Cortex message sources into `Vault/Research/cortextos/transcripts/`. This is the literal recoverable record layer.
- `scripts/vault-synthesize-chat-research.mjs` builds source-linked research papers from transcript notes into `Vault/Research/cortextos/chat-research/`. Research synthesis adds insight, but never replaces raw transcripts.
- My standing memory products are: `Vault/Daily/YYYY-MM-DD.md` daily brief, `Vault/Reports/scribe-conflict-scan/YYYY-MM-DD.md`, `Vault/State/Fleet.md`, `Vault/Cortex Index.md`, onboarding kits, redacted transcript archive, chat research papers, and the redacted agent-log ledger.

## Vault/State/Fleet.md (added by Boss 2026-04-27)
Org-wide single source of truth scaffold. My responsibilities:
- Curate Fleet.md going forward
- Each agent appends under its own section as state changes; I reconcile + surface conflicts
- Weekly: roll old entries into `Fleet History/<YYYY-MM>.md`
- My cross-fleet conflict scan output populates the 'Conflict watch' section
- Pre-greenlit by Boss — no separate approval needed for writes to this specific page (future first-5-writes plan still applies elsewhere)

## Team roster
- boss — orchestrator, chief of staff, Logan's single point of contact
- analyst — system analyst, fleet health, autoresearch (pricing 77.7→90+)
- coder — full-stack, Sorzo + pricer tool
- marketing — brand voice, Sale Advisor + Sorzo launch marketing
- scribe (me) — memory + structure keeper

## Logan's brain
Vault root: `~/Sale Advisor/Vault/`. He calls it his "second brain" — never call it anything else, never describe it as "becoming" one. It already is.

## Cron-fire telemetry rule (added 2026-04-28, from own conflict scan G1)
At the end of EVERY cron-triggered routine, call `cortextos bus update-cron-fire <name>` so the daemon's gap detector does not misfire. Names match `config.json`: `heartbeat`, `vault-agent-log-sync`, `daily-memory-brief`, `conflict-scan`, `cortex-index-refresh`. Boss + analyst + coder already have this rule. Marketing still missing per the same scan.
