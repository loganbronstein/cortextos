---
name: goal-management
description: "Daily goal lifecycle management. Use when: morning briefing, setting daily focus, refreshing agent goals, reviewing goal progress. Triggered daily as part of morning routine."
triggers: ["morning", "goals", "focus", "priorities", "what should we work on", "daily plan"]
---

# Goal Management

The orchestrator owns the daily goal lifecycle. Goals flow from the human's daily focus down to agent-specific objectives and tasks.

## Hierarchy

```
North Star (org-level, rarely changes, set by human via dashboard or Telegram)
  -> Daily Focus (what the human wants done TODAY — set each morning)
    -> Agent goals.json (orchestrator writes role-specific goals for each agent)
      -> GOALS.md (auto-generated from goals.json — agents read this on boot)
        -> Tasks (agents create from their goals, confirm with orchestrator)
```

## Morning Goal Cascade

Run this every morning as part of your briefing:

### 1. Read current org goals

```bash
cat $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json
```

### 2. Consult the human

Ask via Telegram:
> "Good morning. Our north star is: [north_star from goals.json]. What's the focus for today?"

Wait for their response. They may give specific directives or say "continue yesterday's work."

### 3. Update org goals.json with today's focus

```bash
node $CTX_FRAMEWORK_ROOT/dist/cli.js bus update-goals \
  --org $CTX_ORG \
  --daily-focus "the human's stated focus" \
  --updated-by "$CTX_AGENT_NAME"
```

Or directly via jq:
```bash
jq --arg focus "today's focus" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.daily_focus = $focus | .daily_focus_set_at = $ts' \
    $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json > /tmp/goals.tmp \
  && mv /tmp/goals.tmp $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json
```

### 4. Set each agent's goals

For each agent, based on their role and the daily focus:

1. Determine 2-5 goals appropriate for their role
2. Write their `goals.json`:
   ```bash
   cat > $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/<agent>/goals.json << 'EOF'
   {
     "focus": "role-specific focus derived from daily focus",
     "goals": [
       "goal 1",
       "goal 2",
       "goal 3"
     ],
     "bottleneck": "current blocker or empty string",
     "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
     "updated_by": "$CTX_AGENT_NAME"
   }
   EOF
   ```
3. Regenerate GOALS.md from goals.json:
   ```bash
   cortextos goals generate-md --agent <agent> --org $CTX_ORG
   ```
4. Message the agent:
   ```bash
   cortextos bus send-message <agent> normal "New goals for today set. Check GOALS.md and create tasks."
   ```

### 5. Set your own goals

Write your own `goals.json` too (same format), then regenerate:
```bash
cortextos goals generate-md --agent $CTX_AGENT_NAME --org $CTX_ORG
```

### 6. Confirm task plans

Each agent will create tasks from their goals and send you their task list.
- Review for overlap (two agents doing the same thing)
- Review for missing coverage (daily focus items nobody picked up)
- Approve or adjust

## New Agent Bootstrap

When a new agent comes online with an empty `goals.json` (focus and goals both empty), they will message you requesting goals. Handle this by:

1. Checking their role from `IDENTITY.md`
2. Writing their `goals.json` with appropriate starter goals
3. Running `cortextos goals generate-md --agent <name> --org $CTX_ORG`
4. Replying with confirmation

## Evening Review

At end of day:
1. Check each agent's task completion against their goals
2. Note what was achieved vs planned
3. Update each agent's `goals.json` bottleneck field if new blockers emerged
4. Carry forward unfinished goals to tomorrow's conversation with human
5. Update org `goals.json` bottleneck:
   ```bash
   jq --arg b "today's biggest blocker" '.bottleneck = $b' \
     $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json > /tmp/goals.tmp \
     && mv /tmp/goals.tmp $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json
   ```

## North Star

The north star lives in `orgs/<org>/goals.json`. It is set by the human, rarely changes. The orchestrator references it when setting daily focus to ensure alignment.

If the daily focus drifts from the north star, flag it:
> "Today's focus on [X] is different from our north star of [Y]. Is this intentional?"
