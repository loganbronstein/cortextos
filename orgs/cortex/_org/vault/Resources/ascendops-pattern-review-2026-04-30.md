# AscendOps Pattern Review - 2026-04-30

Source: https://github.com/noogalabs/ascendops

## What Was Useful

- SessionStart restore hook: injects the latest PreCompact fact snapshot into the next compacted session before the agent's first turn.
- Loop detector hook: blocks repeated identical tool calls and ping-pong tool loops.
- Framework-level hook command wiring: hook code should be callable through `cortextos bus`, not just exist in `src/hooks`.
- Stronger template defaults: new agents should inherit compaction restore, fact extraction, and loop detection automatically.

## What Was Not Imported

- Property-management skills and templates: useful for AscendOps' niche, not for Sale Advisor/Cortex.
- Vendor adapter stack: promising for Codex/Gemini routing, but it touches PTY lifecycle and should be reviewed separately.
- A2A facade and Supabase network bus designs: strategically interesting, but design-stage and too large for this pass.
- Skill auto-PR hook: useful for public framework maintenance, not a direct fit for Logan's private Cortex memory workflow right now.

## Changes Adopted

- Added `cortextos bus hook-extract-facts`.
- Added `cortextos bus hook-session-restore`.
- Added `cortextos bus hook-loop-detector`.
- Added built outputs for the new hooks.
- Added loop detector + session restore + fact extraction to Cortex templates.
- Added the same hooks to all five active Cortex agents' Claude settings.

## Acceptance

- JSON settings parse cleanly.
- Hook unit tests pass.
- Manual fact extraction -> SessionStart restore test returns Claude-compatible `additionalContext`.
- Manual repeated-tool test blocks on the 15th identical call.
