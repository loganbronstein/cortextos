#!/usr/bin/env bash
set -euo pipefail

# Build the original Cortex Knowledge System v3 "one brain" surface safely.
#
# This script is intentionally non-destructive:
# - It creates orgs/cortex/agents/<agent>/vault/ skeletons.
# - It creates /Users/loganbronstein/Sale Advisor/Vault/Cortex symlinks.
# - It does NOT move old memory files yet. Existing memory/ scripts keep working.
# - It can be rerun.

VAULT="${VAULT:-$HOME/Sale Advisor/Vault}"
CORTEX="${CORTEX:-$HOME/cortextos/orgs/cortex}"
AGENTS=(boss analyst coder marketing scribe)
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: scripts/vault-restructure.sh [--dry-run] [--agent <name>]...

Creates the non-destructive Vault/Cortex symlink surface and per-agent vault
skeletons from the Cortex Knowledge System v3 plan.
USAGE
}

selected_agents=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --agent)
      [[ $# -ge 2 ]] || { echo "--agent requires a name" >&2; exit 2; }
      selected_agents+=("$2")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ${#selected_agents[@]} -gt 0 ]]; then
  AGENTS=("${selected_agents[@]}")
fi

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'DRY-RUN:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

write_file_if_missing() {
  local path="$1"
  local content="$2"
  if [[ -e "$path" ]]; then
    return
  fi
  run mkdir -p "$(dirname "$path")"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'DRY-RUN: write %q\n' "$path"
  else
    printf '%s\n' "$content" > "$path"
  fi
}

valid_agent() {
  case "$1" in
    boss|analyst|coder|marketing|scribe) return 0 ;;
    *) return 1 ;;
  esac
}

[[ -d "$VAULT" ]] || { echo "Vault not found: $VAULT" >&2; exit 1; }
[[ -d "$CORTEX/agents" ]] || { echo "Cortex agents dir not found: $CORTEX/agents" >&2; exit 1; }

run mkdir -p "$VAULT/Cortex"

ORG_VAULT="$CORTEX/_org/vault"
run mkdir -p "$ORG_VAULT/Compound" "$ORG_VAULT/_graph" "$ORG_VAULT/Inbox/_proposals-from-others"
write_file_if_missing "$ORG_VAULT/_index.md" "# Cortex org vault

Boss-owned fleet synthesis. Other agents propose into boss or _org proposal inboxes; they do not write canonical org notes directly."
write_file_if_missing "$ORG_VAULT/Compound/pattern-library.md" "# Pattern Library

Fleet-wide durable patterns promoted by boss."

if [[ ! -e "$VAULT/Cortex/_org" ]]; then
  run ln -s "$ORG_VAULT" "$VAULT/Cortex/_org"
fi

write_file_if_missing "$VAULT/Cortex/_index.md" "# Cortex

This is the Obsidian surface for Cortex OS agent memory. Runtime configuration stays in cortextos; this folder is for browsable knowledge.

- [[_org/_index|_org]]: boss-owned fleet synthesis
- [[boss/_index|boss]]
- [[analyst/_index|analyst]]
- [[coder/_index|coder]]
- [[marketing/_index|marketing]]
- [[scribe/_index|scribe]]
"

for agent in "${AGENTS[@]}"; do
  valid_agent "$agent" || { echo "Invalid agent: $agent" >&2; exit 2; }
  agent_root="$CORTEX/agents/$agent"
  agent_vault="$agent_root/vault"
  [[ -d "$agent_root" ]] || { echo "Agent dir not found: $agent_root" >&2; exit 1; }

  run mkdir -p \
    "$agent_vault/Inbox/_proposals-from-others" \
    "$agent_vault/Projects" \
    "$agent_vault/Areas" \
    "$agent_vault/Resources/people" \
    "$agent_vault/Resources/businesses" \
    "$agent_vault/Resources/tools" \
    "$agent_vault/Resources/patterns" \
    "$agent_vault/Compound" \
    "$agent_vault/Archive/$(date +%Y-%m)"

  write_file_if_missing "$agent_vault/_index.md" "# $agent vault

Owned by $agent. This tree follows Inbox / Projects / Areas / Resources / Compound / Archive.

Hard rule: $agent writes canonical notes only inside this subtree. Cross-agent edits use Inbox/_proposals-from-others/."
  write_file_if_missing "$agent_vault/Inbox/_promote-queue.md" "# Promote Queue

Suggestion-only queue. Do not auto-promote. Confirm before running \`cortextos bus vault promote\`."
  write_file_if_missing "$agent_vault/Inbox/_link-suggestions.md" "# Link Suggestions

Suggestion-only semantic link candidates from lint/query passes."
  write_file_if_missing "$agent_vault/Compound/_index.md" "# $agent Compound

Durable synthesized knowledge owned by $agent. Rewrite sparingly; preserve provenance."

  if [[ ! -e "$VAULT/Cortex/$agent" ]]; then
    run ln -s "$agent_vault" "$VAULT/Cortex/$agent"
  fi
done

echo "Vault/Cortex surface ready at: $VAULT/Cortex"
