#!/usr/bin/env bash
# pre-compact-snapshot.sh
# Fires before Claude Code auto-compacts an agent's context.
# Saves a snapshot to today's memory file + logs to Neon + pings Telegram.
# Must complete in <10s (hook timeout). Never blocks compaction.
#
# Agent-agnostic: reads CTX_AGENT_NAME and CTX_AGENT_DIR from env (set by daemon).
# Log-episode wrapper is referenced by absolute path to boss's experiments/ dir
# (single source of truth until phase 2 converts these to a real bus command).

set +e  # NEVER fail the hook, compaction must proceed

AGENT="${CTX_AGENT_NAME:-scribe}"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TODAY=$(date -u +%Y-%m-%d)
AGENT_DIR="${CTX_AGENT_DIR:-/Users/loganbronstein/cortextos/orgs/cortex/agents/${AGENT}}"
MEMORY_FILE="$AGENT_DIR/memory/$TODAY.md"
LOG_EPISODE="/Users/loganbronstein/cortextos/orgs/cortex/agents/boss/experiments/log-episode.sh"
SECRETS_FILE="${CTX_FRAMEWORK_ROOT:-/Users/loganbronstein/cortextos}/orgs/${CTX_ORG:-cortex}/secrets.env"

# 1. Append compact marker to this agent's memory file
mkdir -p "$AGENT_DIR/memory" 2>/dev/null
{
  echo ""
  echo "## PRE-COMPACT SNAPSHOT - $TIMESTAMP ($AGENT)"
  echo ""
  echo "Claude Code is about to auto-compact $AGENT's context. Post-compact $AGENT should:"
  echo "- Re-read MEMORY.md, USER.md, today's daily file (this one), GOALS.md"
  echo "- Query Neon recent episodes: psql \$CORTEX_NEON_URL -c \"SELECT * FROM agent_episodes WHERE agent_name='$AGENT' AND created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC;\""
  echo "- Query active decisions: psql \$CORTEX_NEON_URL -c \"SELECT * FROM agent_decisions WHERE lifecycle_state = 'active' ORDER BY created_at DESC LIMIT 20;\""
  echo "- Check inbox: cortextos bus check-inbox"
  echo "- Read active tasks: cortextos bus list-tasks --status in_progress"
  echo ""
  echo "If someone mentions something earlier in the session that $AGENT does not remember, apologize, ask them to restate, and SAVE IT to MEMORY.md this time so it survives the next compact."
  echo ""
} >> "$MEMORY_FILE" 2>/dev/null

# 2. Log pre_compact_triggered episode to Neon (best-effort, swallow errors)
if [[ -f "$SECRETS_FILE" ]] && [[ -x "$LOG_EPISODE" ]]; then
  # shellcheck disable=SC1090
  set -o allexport && source "$SECRETS_FILE" 2>/dev/null && set +o allexport
  bash "$LOG_EPISODE" "$AGENT" guardrail_triggered medium \
    "Pre-compact snapshot taken at $TIMESTAMP ($AGENT)" \
    "{\"hook\":\"pre_compact\",\"snapshot_at\":\"$TIMESTAMP\",\"memory_file\":\"$MEMORY_FILE\",\"agent\":\"$AGENT\"}" \
    2>/dev/null || true
fi

# 3. Telegram notification (inline so hook is not dependent on framework command)
if [[ -n "${BOT_TOKEN:-}" ]] && [[ -n "${CHAT_ID:-}" ]]; then
  curl -s --max-time 4 -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\":\"${CHAT_ID}\",\"text\":\"[${AGENT}] Context auto-compacting. Snapshot saved to memory/${TODAY}.md. Resuming shortly.\"}" \
    >/dev/null 2>&1 || true
fi

exit 0
