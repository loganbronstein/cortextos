#!/usr/bin/env bash
# manage-cycle.sh — Manage experiment cycles
# Usage: manage-cycle.sh <action> <agent> [--metric <name>] [--surface <path>] [--direction higher|lower] [--window <dur>] [--cycle <name>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

ACTION="${1:-}"
AGENT="${2:-}"

if [[ -z "$ACTION" || -z "$AGENT" ]]; then
  echo "Usage: manage-cycle.sh <action> <agent> [--metric <name>] [--surface <path>] [--direction higher|lower] [--window <dur>] [--cycle <name>]" >&2
  echo "Actions: create, modify, remove, list" >&2
  exit 1
fi

shift 2
exec node "$CLI" bus manage-cycle "$ACTION" "$AGENT" "$@"
