#!/usr/bin/env bash
# disable-agent.sh - Disable a cortextOS agent
# Usage: disable-agent.sh <agent_name> [--org <org>]

set -euo pipefail

TEMPLATE_ROOT="$(cd "$(dirname "$0")" && pwd)"

# Parse args
AGENT=""
CTX_ORG=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --org) CTX_ORG="$2"; shift 2 ;;
        *) [[ -z "${AGENT}" ]] && AGENT="$1"; shift ;;
    esac
done

if [[ -z "${AGENT}" ]]; then
    echo "Usage: disable-agent.sh <agent_name> [--org <org>]"
    exit 1
fi

# Load instance ID
REPO_ENV="${TEMPLATE_ROOT}/.env"
if [[ -f "${REPO_ENV}" ]]; then
    CTX_INSTANCE_ID=$(grep '^CTX_INSTANCE_ID=' "${REPO_ENV}" 2>/dev/null | cut -d= -f2)
    [[ -z "${CTX_INSTANCE_ID:-}" ]] && CTX_INSTANCE_ID=$(grep '^CRM_INSTANCE_ID=' "${REPO_ENV}" 2>/dev/null | cut -d= -f2)
fi
CTX_INSTANCE_ID="${CTX_INSTANCE_ID:-default}"
CTX_ROOT="${HOME}/.cortextos/${CTX_INSTANCE_ID}"
ENABLED_FILE="${CTX_ROOT}/config/enabled-agents.json"

# Auto-detect org if not provided
if [[ -z "${CTX_ORG}" ]]; then
    CTX_ORG=$(jq -r ".\"${AGENT}\".org // empty" "${ENABLED_FILE}" 2>/dev/null || echo "")
fi

# Build plist name
if [[ -n "${CTX_ORG}" ]]; then
    PLIST_NAME="cortextos.${CTX_INSTANCE_ID}.${CTX_ORG}.${AGENT}"
    TMUX_SESSION="ctx-${CTX_INSTANCE_ID}-${CTX_ORG}-${AGENT}"
else
    PLIST_NAME="cortextos.${CTX_INSTANCE_ID}.${AGENT}"
    TMUX_SESSION="ctx-${CTX_INSTANCE_ID}-${AGENT}"
fi

echo "Disabling ${AGENT}..."

# Unload launchd plist
PLIST="${HOME}/Library/LaunchAgents/${PLIST_NAME}.plist"
if [[ -f "${PLIST}" ]]; then
    launchctl unload "${PLIST}" 2>/dev/null || true
    echo "  launchd: unloaded"
fi

# Kill tmux session if running
tmux kill-session -t "${TMUX_SESSION}" 2>/dev/null || true

# Update enabled status
if [[ -f "${ENABLED_FILE}" ]]; then
    jq ".\"${AGENT}\".enabled = false" "${ENABLED_FILE}" > "${ENABLED_FILE}.tmp"
    mv "${ENABLED_FILE}.tmp" "${ENABLED_FILE}"
fi

echo "  status: disabled"
echo ""
echo "${AGENT} is now disabled. Its configuration is preserved."
echo "Re-enable with: ./enable-agent.sh ${AGENT}"
