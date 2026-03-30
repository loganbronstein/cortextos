#!/usr/bin/env bash
# read-all-heartbeats.sh - Aggregate all agent heartbeats into single JSON
# Usage: read-all-heartbeats.sh
# Output: JSON object keyed by agent name

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/_ctx-env.sh" 2>/dev/null || true

# Iterate all agent state dirs that have heartbeat files
# Use jq to build JSON safely instead of string concatenation
RESULT='{}'

for hb_file in "${CTX_ROOT}/state"/*/heartbeat.json; do
    [[ ! -f "${hb_file}" ]] && continue
    AGENT_NAME=$(basename "$(dirname "${hb_file}")")

    # Validate agent name to prevent JSON injection
    [[ ! "${AGENT_NAME}" =~ ^[a-z0-9_-]+$ ]] && continue

    HB_DATA=$(cat "${hb_file}" 2>/dev/null || echo '{}')
    # Validate it's actual JSON before merging
    if echo "${HB_DATA}" | jq empty 2>/dev/null; then
        RESULT=$(echo "${RESULT}" | jq -c --arg name "${AGENT_NAME}" --argjson data "${HB_DATA}" '. + {($name): $data}')
    fi
done

echo "${RESULT}"
