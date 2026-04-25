#!/usr/bin/env bash
# post-merge-digest-send.sh — Read the Tier 2 PR digest accumulator, send one
# consolidated Telegram to Logan, and truncate the file.
#
# Designed for a daily cron at 22:00 America/Chicago (03:00 UTC). Wiring to
# cron is a follow-up; this script ships runnable so Logan can trigger it
# manually or wire to whatever scheduler he prefers.
#
# Reads the same accumulator that scripts/post-merge-notify.sh writes:
#   $POST_MERGE_NOTIFY_DIGEST_FILE   default: $CTX_ROOT/state/pr-digest.jsonl
#                                    falls back to ~/.cortextos/default/state
#
# Reads chat_id + bot_token from:
#   $POST_MERGE_NOTIFY_BOSS_ENV      default: orgs/cortex/agents/boss/.env
#   (resolved relative to git repo root, falls back to $REPO_ROOT)
#
# Environment overrides:
#   POST_MERGE_DIGEST_DRY_RUN=1      print what would be sent, do not send,
#                                    do not truncate
#   POST_MERGE_DIGEST_KEEP=1         send but do NOT truncate (debugging)
#
# Exit codes:
#   0 = success (sent + truncated, OR digest empty so nothing to do)
#   1 = misconfiguration (no chat_id, etc.)
#
# macOS bash 3.2 compatible.

set -uo pipefail

log() { echo "[post-merge-digest-send] $*" >&2; }

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

DIGEST_FILE="${POST_MERGE_NOTIFY_DIGEST_FILE:-}"
if [[ -z "$DIGEST_FILE" ]]; then
  state_root="${CTX_ROOT:-$HOME/.cortextos/${CTX_INSTANCE_ID:-default}}"
  DIGEST_FILE="$state_root/state/pr-digest.jsonl"
fi

if [[ ! -s "$DIGEST_FILE" ]]; then
  log "Digest file empty or missing ($DIGEST_FILE) — nothing to send."
  exit 0
fi

# Build the message body. We do not depend on jq — parse the simple JSONL
# format we wrote ourselves. Each line has "title", "pr", "url" fields.
COUNT="$(wc -l < "$DIGEST_FILE" | tr -d ' ')"
MESSAGE="Daily PR digest ($COUNT shipped, minor):"
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  title="$(echo "$line" | sed -nE 's/.*"title":"([^"]+)".*/\1/p')"
  pr="$(echo "$line" | sed -nE 's/.*"pr":"([^"]+)".*/\1/p')"
  [[ -z "$title" ]] && title="(no title)"
  if [[ -n "$pr" && "$pr" != "?" ]]; then
    MESSAGE="$MESSAGE"$'\n'"- #$pr $title"
  else
    MESSAGE="$MESSAGE"$'\n'"- $title"
  fi
done < "$DIGEST_FILE"

if [[ "${POST_MERGE_DIGEST_DRY_RUN:-0}" == "1" ]]; then
  echo "$MESSAGE"
  exit 0
fi

BOSS_ENV="${POST_MERGE_NOTIFY_BOSS_ENV:-$REPO_ROOT/orgs/cortex/agents/boss/.env}"
if [[ ! -r "$BOSS_ENV" ]]; then
  log "boss .env not readable at '$BOSS_ENV' — cannot send."
  exit 1
fi

CHAT_ID="$(grep -E '^CHAT_ID=' "$BOSS_ENV" | head -n 1 | sed 's/^CHAT_ID=//' | tr -d '"' | tr -d "'" | tr -d ' ')"
BOT_TOKEN="$(grep -E '^BOT_TOKEN=' "$BOSS_ENV" | head -n 1 | sed 's/^BOT_TOKEN=//' | tr -d '"' | tr -d "'" | tr -d ' ')"

if [[ -z "$CHAT_ID" || -z "$BOT_TOKEN" ]]; then
  log "CHAT_ID/BOT_TOKEN missing from '$BOSS_ENV'."
  exit 1
fi

if ! command -v cortextos >/dev/null 2>&1; then
  log "cortextos binary missing — cannot send."
  exit 1
fi

if ! BOT_TOKEN="$BOT_TOKEN" cortextos bus send-telegram "$CHAT_ID" "$MESSAGE" --plain-text >/dev/null 2>&1; then
  log "send-telegram failed — leaving digest file intact for next attempt."
  exit 1
fi

if [[ "${POST_MERGE_DIGEST_KEEP:-0}" == "1" ]]; then
  log "Sent $COUNT entries; POST_MERGE_DIGEST_KEEP=1 so digest file preserved."
  exit 0
fi

# Atomic rename clears the digest. We do NOT then create an empty file at
# the same path: a concurrent post-merge-notify.sh fire might otherwise
# write into the new file between our `mv` and `: >`, and the truncate
# would silently delete that entry. Leaving the path absent means the next
# concurrent or future fire creates it fresh via `>>`, preserving the line.
TMP_TRUNC="$(mktemp -t pr-digest-trunc.XXXXXX)"
mv "$DIGEST_FILE" "$TMP_TRUNC"
rm -f "$TMP_TRUNC"

log "Sent $COUNT entries; digest cleared."
exit 0
