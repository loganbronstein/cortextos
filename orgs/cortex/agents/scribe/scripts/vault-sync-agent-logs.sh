#!/usr/bin/env bash
# vault-sync-agent-logs.sh
# Incrementally mirrors Cortex agent runtime logs into Logan's Vault.
#
# This is a recovery ledger, not a transcript replacement. It captures new log
# bytes from the five primary agents, redacts common secret patterns, and appends
# them to Research/cortextos/_agent-logs/YYYY-MM-DD.md. First run bootstraps only
# the tail of each log so a stale machine does not dump months of noise.
set -euo pipefail

VAULT="${VAULT:-$HOME/Sale Advisor/Vault}"
LOGS_ROOT="${LOGS_ROOT:-$HOME/.cortextos/default/logs}"
STATE_DIR="${STATE_DIR:-$HOME/.cortextos/default/state/scribe/agent-log-sync}"
OUT_DIR="$VAULT/Research/cortextos/_agent-logs"
TODAY="$(date -u +%Y-%m-%d)"
OUT_FILE="$OUT_DIR/$TODAY.md"
BOOTSTRAP_BYTES="${BOOTSTRAP_BYTES:-16384}"
AGENTS=(boss analyst coder marketing scribe)
LOG_FILES=(inbound-messages.jsonl outbound-messages.jsonl crashes.log restarts.log)

mkdir -p "$STATE_DIR" "$OUT_DIR"

redact() {
  perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g; s/\e\].*?\a//g' | sed -E \
    -e 's/sk-proj-[A-Za-z0-9_-]{20,}/[OPENAI_KEY_REDACTED]/g' \
    -e 's/sk-ant-[A-Za-z0-9_-]{20,}/[ANTHROPIC_KEY_REDACTED]/g' \
    -e 's/sk-[A-Za-z0-9_-]{32,}/[API_KEY_REDACTED]/g' \
    -e 's/[A-Za-z0-9_=-]*AIza[0-9A-Za-z_-]{20,}/[GOOGLE_KEY_REDACTED]/g' \
    -e 's/[0-9]{8,12}:[A-Za-z0-9_-]{35,}/[BOT_TOKEN_REDACTED]/g' \
    -e 's/(BOT_TOKEN|TELEGRAM_BOT_TOKEN|GEMINI_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|DATABASE_URL|CORTEX_NEON_URL|SUPABASE_SERVICE_ROLE_KEY|RESEND_API_KEY|TELNYX_API_KEY|TWILIO_AUTH_TOKEN)(["'\'']?[=:][[:space:]]*)[^"'\''[:space:]]+/\1\2[REDACTED]/g' \
    -e 's#postgres(ql)?://[^[:space:]")'\'']+#postgres://[REDACTED]#g'
}

file_key() {
  printf '%s' "$1" | shasum | awk '{print $1}'
}

append_header_if_needed() {
  if [[ ! -f "$OUT_FILE" ]]; then
    cat > "$OUT_FILE" << EOF
---
type: agent-log-ledger
source_agent: scribe
date_utc: ${TODAY}T00:00:00Z
people: [[Logan Bronstein]]
project: Cortex
tags: [#agent-logs, #memory, #cortex]
related: [[Cortex Index]], [[Fleet]]
status: active
confidence: high
---

# Cortex agent log ledger — $TODAY

Incremental redacted runtime log excerpts for recovery after compact/restart.

EOF
  fi
}

total_appended=0

for agent in "${AGENTS[@]}"; do
  for log_name in "${LOG_FILES[@]}"; do
    log_path="$LOGS_ROOT/$agent/$log_name"
    [[ -f "$log_path" ]] || continue

    size="$(wc -c < "$log_path" | tr -d ' ')"
    key="$(file_key "$log_path")"
    offset_file="$STATE_DIR/$key.offset"

    if [[ -f "$offset_file" ]]; then
      offset="$(cat "$offset_file" 2>/dev/null || echo 0)"
    else
      if [[ "$size" -gt "$BOOTSTRAP_BYTES" ]]; then
        offset=$((size - BOOTSTRAP_BYTES))
      else
        offset=0
      fi
    fi

    if [[ "$offset" -gt "$size" ]]; then
      offset=0
    fi
    if [[ "$offset" -eq "$size" ]]; then
      printf '%s' "$size" > "$offset_file"
      continue
    fi

    chunk="$(mktemp)"
    dd if="$log_path" bs=1 skip="$offset" 2>/dev/null | redact > "$chunk" || true
    if [[ -s "$chunk" ]]; then
      append_header_if_needed
      {
        echo ""
        echo "## $agent / $log_name — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo ""
        echo '```text'
        cat "$chunk"
        echo ""
        echo '```'
      } >> "$OUT_FILE"
      total_appended=$((total_appended + 1))
    fi
    rm -f "$chunk"
    printf '%s' "$size" > "$offset_file"
  done
done

echo "agent log vault sync complete - $total_appended updated stream(s)"
