#!/usr/bin/env bash
# generate-launchd.sh - Generate and load a launchd plist for an agent
# Usage: generate-launchd.sh <agent_name> [agent_dir]
#
# agent_dir defaults to detecting from org structure or $TEMPLATE_ROOT/agents/
# Can also be set via CTX_AGENT_DIR env var.

set -euo pipefail

AGENT="$1"
TEMPLATE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Validate agent name to prevent XML injection in plist
if [[ ! "${AGENT}" =~ ^[a-zA-Z0-9._-]+$ ]]; then
    echo "ERROR: Invalid agent name '${AGENT}' (allowed: a-zA-Z0-9 . _ -)" >&2
    exit 1
fi

# XML-escape a string for safe plist interpolation
xml_escape() {
    local s="$1"
    s="${s//&/&amp;}"
    s="${s//</&lt;}"
    s="${s//>/&gt;}"
    s="${s//\"/&quot;}"
    echo "$s"
}

# Agent directory: explicit arg > env var > legacy path
if [[ -n "${2:-}" ]]; then
    AGENT_DIR="$2"
elif [[ -n "${CTX_AGENT_DIR:-}" ]]; then
    AGENT_DIR="${CTX_AGENT_DIR}"
else
    # Legacy: check templates/ first, then scan orgs/
    if [[ -d "${TEMPLATE_ROOT}/agents/${AGENT}" ]]; then
        AGENT_DIR="${TEMPLATE_ROOT}/agents/${AGENT}"
    else
        # Scan orgs for the agent
        for org_dir in "${TEMPLATE_ROOT}"/orgs/*/agents/"${AGENT}"; do
            if [[ -d "${org_dir}" ]]; then
                AGENT_DIR="${org_dir}"
                break
            fi
        done
    fi
fi

if [[ -z "${AGENT_DIR:-}" || ! -d "${AGENT_DIR}" ]]; then
    echo "ERROR: Could not find agent directory for '${AGENT}'" >&2
    exit 1
fi

CONFIG_FILE="${AGENT_DIR}/config.json"

# Load instance ID from repo .env
ENV_FILE="${TEMPLATE_ROOT}/.env"
if [[ -f "${ENV_FILE}" ]]; then
    CTX_INSTANCE_ID=$(grep '^CTX_INSTANCE_ID=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2)
    [[ -z "${CTX_INSTANCE_ID:-}" ]] && CTX_INSTANCE_ID=$(grep '^CRM_INSTANCE_ID=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2)
fi
CTX_INSTANCE_ID="${CTX_INSTANCE_ID:-default}"

# Validate instance ID
if [[ ! "${CTX_INSTANCE_ID}" =~ ^[a-zA-Z0-9._-]+$ ]]; then
    echo "ERROR: Invalid instance ID '${CTX_INSTANCE_ID}'" >&2
    exit 1
fi

# Detect org from agent path (e.g., .../orgs/shoptally/agents/atlas -> shoptally)
if [[ -z "${CTX_ORG:-}" ]]; then
    case "${AGENT_DIR}" in
        */orgs/*/agents/*)
            CTX_ORG=$(echo "${AGENT_DIR}" | sed 's|.*/orgs/\([^/]*\)/agents/.*|\1|')
            ;;
    esac
fi
CTX_ORG="${CTX_ORG:-}"

# Validate org name if set
if [[ -n "${CTX_ORG}" && ! "${CTX_ORG}" =~ ^[a-zA-Z0-9._-]+$ ]]; then
    echo "ERROR: Invalid org name '${CTX_ORG}'" >&2
    exit 1
fi

# Detect project root (parent of orgs/ or parent of agents/)
if [[ -z "${CTX_PROJECT_ROOT:-}" ]]; then
    case "${AGENT_DIR}" in
        */orgs/*/agents/*)
            CTX_PROJECT_ROOT=$(echo "${AGENT_DIR}" | sed 's|/orgs/.*||')
            ;;
        */agents/*)
            CTX_PROJECT_ROOT=$(echo "${AGENT_DIR}" | sed 's|/agents/.*||')
            ;;
    esac
fi
CTX_PROJECT_ROOT="${CTX_PROJECT_ROOT:-}"

# Build plist label (include org if present)
if [[ -n "${CTX_ORG}" ]]; then
    PLIST_NAME="cortextos.${CTX_INSTANCE_ID}.${CTX_ORG}.${AGENT}"
else
    PLIST_NAME="cortextos.${CTX_INSTANCE_ID}.${AGENT}"
fi

PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_FILE="${PLIST_DIR}/${PLIST_NAME}.plist"
CTX_ROOT="${HOME}/.cortextos/${CTX_INSTANCE_ID}"
LOG_DIR="${CTX_ROOT}/logs/${AGENT}"

WRAPPER="${TEMPLATE_ROOT}/scripts/agent-wrapper.sh"

mkdir -p "${PLIST_DIR}" "${LOG_DIR}"

# Auto-detect PATH: find where claude, jq, and python3 live
CLAUDE_BIN=$(which claude 2>/dev/null || echo "")
if [[ -z "${CLAUDE_BIN}" ]]; then
    echo "ERROR: 'claude' not found in PATH. Install Claude Code CLI first." >&2
    exit 1
fi
CLAUDE_DIR=$(dirname "${CLAUDE_BIN}")

# Detect the active Node.js version (the one that will actually work with claude)
NODE_BIN=$(which node 2>/dev/null || echo "")
if [[ -z "${NODE_BIN}" ]]; then
    echo "ERROR: 'node' not found in PATH. Install Node.js first." >&2
    exit 1
fi
NODE_DIR=$(dirname "${NODE_BIN}")

# Build PATH with only the active node version + detected dirs + standard system dirs
LAUNCHD_PATH="${NODE_DIR}:${CLAUDE_DIR}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"

# Include pyenv shims if present
[[ -d "${HOME}/.pyenv/shims" ]] && LAUNCHD_PATH="${HOME}/.pyenv/shims:${LAUNCHD_PATH}"

# XML-escape all interpolated values for safe plist generation
X_PLIST_NAME=$(xml_escape "${PLIST_NAME}")
X_WRAPPER=$(xml_escape "${WRAPPER}")
X_AGENT=$(xml_escape "${AGENT}")
X_TEMPLATE_ROOT=$(xml_escape "${TEMPLATE_ROOT}")
X_LOG_DIR=$(xml_escape "${LOG_DIR}")
X_LAUNCHD_PATH=$(xml_escape "${LAUNCHD_PATH}")
X_HOME=$(xml_escape "${HOME}")
X_CTX_INSTANCE_ID=$(xml_escape "${CTX_INSTANCE_ID}")
X_CTX_ROOT=$(xml_escape "${CTX_ROOT}")
X_CTX_PROJECT_ROOT=$(xml_escape "${CTX_PROJECT_ROOT}")
X_CTX_ORG=$(xml_escape "${CTX_ORG}")
X_AGENT_DIR=$(xml_escape "${AGENT_DIR}")

# Generate plist
cat > "${PLIST_FILE}" <<ENDPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${X_PLIST_NAME}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${X_WRAPPER}</string>
        <string>${X_AGENT}</string>
        <string>${X_TEMPLATE_ROOT}</string>
    </array>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${X_LOG_DIR}/stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${X_LOG_DIR}/stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${X_LAUNCHD_PATH}</string>
        <key>HOME</key>
        <string>${X_HOME}</string>
        <key>CTX_AGENT_NAME</key>
        <string>${X_AGENT}</string>
        <key>CTX_INSTANCE_ID</key>
        <string>${X_CTX_INSTANCE_ID}</string>
        <key>CTX_ROOT</key>
        <string>${X_CTX_ROOT}</string>
        <key>CTX_FRAMEWORK_ROOT</key>
        <string>${X_TEMPLATE_ROOT}</string>
        <key>CTX_PROJECT_ROOT</key>
        <string>${X_CTX_PROJECT_ROOT}</string>
        <key>CTX_ORG</key>
        <string>${X_CTX_ORG}</string>
        <key>CTX_AGENT_DIR</key>
        <string>${X_AGENT_DIR}</string>
    </dict>

    <key>WorkingDirectory</key>
    <string>${X_AGENT_DIR}</string>

    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
ENDPLIST

echo "Generated: ${PLIST_FILE}"

# Load the plist
launchctl unload "${PLIST_FILE}" 2>/dev/null || true
launchctl load "${PLIST_FILE}"

echo "Loaded: ${PLIST_NAME}"
