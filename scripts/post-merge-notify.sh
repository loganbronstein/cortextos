#!/usr/bin/env bash
# post-merge-notify.sh — Classify the just-merged PR and either Tier 1 ping
# Logan now or Tier 2 queue for the daily digest.
#
# Invoked by scripts/hooks/post-merge as a background fork. Runs only on the
# base branch (main). Compares ORIG_HEAD..HEAD to score the merge against
# Logan's notify rules (set 2026-04-23, captured in task task_1776977272110_140):
#
#   NOTIFY (Tier 1):  new skill / agent / bus command / integration /
#                     dashboard surface / material quality upgrade
#   SKIP/DIGEST:      bug fixes (unless prod-down), docs, infra tweaks,
#                     refactors, test coverage
#
# Default-to-quiet on ambiguity: score >= 3 = Tier 1 ping; score 1-2 =
# Tier 2 digest entry; score <= 0 = silent skip.
#
# Never blocks the merge. Every failure path exits 0 so a slow Telegram or a
# missing `cortextos` binary cannot wedge a `git pull`.
#
# Environment overrides:
#   POST_MERGE_NOTIFY_SKIP=1            kill switch — exit 0 immediately
#   POST_MERGE_NOTIFY_DRY_RUN=1         print verdict + would-send, no Telegram
#   POST_MERGE_NOTIFY_BOSS_ENV=<path>   default: orgs/cortex/agents/boss/.env
#   POST_MERGE_NOTIFY_DIGEST_FILE=<p>   default: $CTX_ROOT/state/pr-digest.jsonl
#                                       falls back to ~/.cortextos/default/state
#   POST_MERGE_NOTIFY_BASE_BRANCH=<b>   default: main
#   POST_MERGE_NOTIFY_REPO_URL=<url>    PR link prefix; default derived from origin
#
# macOS bash 3.2 compatible. No mapfile / readarray / associative arrays.

set -uo pipefail

log() { echo "[post-merge-notify] $*" >&2; }

if [[ "${POST_MERGE_NOTIFY_SKIP:-0}" == "1" ]]; then
  log "POST_MERGE_NOTIFY_SKIP=1 — disabled."
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
[[ -z "$REPO_ROOT" ]] && exit 0
cd "$REPO_ROOT"

BASE_BRANCH="${POST_MERGE_NOTIFY_BASE_BRANCH:-main}"
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
if [[ "$branch" != "$BASE_BRANCH" ]]; then
  log "Not on '$BASE_BRANCH' (on '$branch'). Skipping."
  exit 0
fi

if ! git rev-parse --verify ORIG_HEAD >/dev/null 2>&1; then
  log "ORIG_HEAD missing — first checkout or amended hook fire. Skipping."
  exit 0
fi

# ── Gather data about the merge ──────────────────────────────────────────────
# Subjects of every commit pulled in. For squash-merge style this is one
# line; for multi-commit merges it's many. We use the FIRST line as the
# "primary subject" for type detection — that's the one that gets the
# `feat(`/`fix(` prefix in this repo's convention.
PRIMARY_SUBJECT="$(git log ORIG_HEAD..HEAD --format='%s' 2>/dev/null | head -n 1 || true)"
if [[ -z "$PRIMARY_SUBJECT" ]]; then
  log "No new commits between ORIG_HEAD and HEAD. Skipping."
  exit 0
fi

# Merge commit subject (different from PRIMARY_SUBJECT for non-squash merges).
# Carries the "Merge ... (PR #N)" or "Merge pull request #N" string.
MERGE_SUBJECT="$(git log -1 --format='%s' HEAD 2>/dev/null || true)"

# PR number: try merge subject first, then primary subject, then full body.
PR_NUMBER=""
for hay in "$MERGE_SUBJECT" "$PRIMARY_SUBJECT" "$(git log -1 --format='%B' HEAD 2>/dev/null || true)"; do
  num="$(echo "$hay" | grep -oE '#[0-9]+' | head -n 1 | tr -d '#')"
  if [[ -n "$num" ]]; then
    PR_NUMBER="$num"
    break
  fi
done

# Files changed by the merge.
CHANGED_FILES_FILE="$(mktemp -t post-merge-notify.XXXXXX)"
ADDED_FILES_FILE="$(mktemp -t post-merge-notify.XXXXXX)"
trap 'rm -f "$CHANGED_FILES_FILE" "$ADDED_FILES_FILE"' EXIT
git diff --name-only ORIG_HEAD HEAD 2>/dev/null > "$CHANGED_FILES_FILE" || true
file_count="$(wc -l < "$CHANGED_FILES_FILE" | tr -d ' ')"

# Files added (not just modified) — material for "new SKILL", "new bus
# command", "new dashboard page" detection.
git diff --name-only --diff-filter=A ORIG_HEAD HEAD 2>/dev/null > "$ADDED_FILES_FILE" || true

# ── Score the merge ──────────────────────────────────────────────────────────
score=0
signals=""
add_signal() {
  signals="${signals}- $1"$'\n'
  score=$((score + $2))
}

# +signals — new capability surfaces.
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    .claude/skills/*/SKILL.md)
      skill_name="${f#.claude/skills/}"; skill_name="${skill_name%/SKILL.md}"
      add_signal "new skill: /$skill_name" 3
      ;;
    community/skills/*/SKILL.md)
      skill_name="${f#community/skills/}"; skill_name="${skill_name%/SKILL.md}"
      add_signal "new community skill: /$skill_name" 3
      ;;
    community/agents/*)
      add_signal "new community agent: $f" 3
      ;;
    templates/*/CLAUDE.md|templates/*/AGENTS.md)
      add_signal "new agent template: ${f%/*}" 2
      ;;
    dashboard/app/*/page.tsx|dashboard/app/*/page.ts)
      page_path="${f#dashboard/app/}"; page_path="/${page_path%/page.*}"
      add_signal "new dashboard page: $page_path" 3
      ;;
    src/cli/*.ts)
      add_signal "new CLI module: $f" 2
      ;;
  esac
done < "$ADDED_FILES_FILE"

# Modified-file signals (not added — these catch surface upgrades to existing
# files). Smaller weights; default-to-quiet.
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    src/cli/bus.ts) add_signal "bus.ts modified (likely new bus command)" 2 ;;
    src/cli/cli.ts|src/cli/index.ts) add_signal "top-level CLI surface modified" 1 ;;
    dashboard/app/*) add_signal "dashboard surface modified" 1 ;;
    src/integrations/*|src/integrations/**/*) add_signal "integration code modified" 1 ;;
  esac
done < "$CHANGED_FILES_FILE"

# Subject-line signals.
case "$PRIMARY_SUBJECT" in
  feat\(*) add_signal "primary subject is feat(...)" 2 ;;
  fix\(*) add_signal "primary subject is fix(...)" -1 ;;
  chore\(*|refactor\(*|test\(*|docs\(*|style\(*|ci\(*) add_signal "primary subject is non-feature ($PRIMARY_SUBJECT)" -2 ;;
esac

# Doc/test-only diff → strong negative signal (overrides positive noise).
# Capability-surface markdown (SKILL.md / new agent templates) is NOT a doc.
docs_only=1
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    .claude/skills/*/SKILL.md|community/skills/*/SKILL.md|community/agents/*)
      docs_only=0 ;;
    templates/*/CLAUDE.md|templates/*/AGENTS.md)
      docs_only=0 ;;
    *.md|memory/*|docs/*|*.lock|package-lock.json|*.json) ;;
    tests/*|*.test.ts|*.spec.ts) ;;
    *) docs_only=0 ;;
  esac
done < "$CHANGED_FILES_FILE"
if [[ "$docs_only" == "1" && "$file_count" -gt 0 ]]; then
  add_signal "docs/tests-only diff" -3
fi

# Tier decision.
TIER=""
if [[ "$score" -ge 3 ]]; then
  TIER="1"
elif [[ "$score" -ge 1 ]]; then
  TIER="2"
else
  TIER="skip"
fi

# ── Build user-facing strings ────────────────────────────────────────────────
# Repo URL for PR link.
REPO_URL="${POST_MERGE_NOTIFY_REPO_URL:-}"
if [[ -z "$REPO_URL" ]]; then
  origin="$(git remote get-url origin 2>/dev/null || echo "")"
  # git@github.com:owner/repo.git OR https://github.com/owner/repo(.git)
  if [[ "$origin" =~ github\.com[:/]([^/]+)/([^/.]+) ]]; then
    REPO_URL="https://github.com/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  fi
fi

PR_URL=""
[[ -n "$PR_NUMBER" && -n "$REPO_URL" ]] && PR_URL="$REPO_URL/pull/$PR_NUMBER"

# Coaching string from the strongest positive signal.
COACHING=""
first_skill="$(grep -m1 -E '^- new (community )?skill:' <<<"$signals" | sed -E 's/^- new (community )?skill: //')"
first_bus_signal="$(grep -m1 'bus.ts modified' <<<"$signals" || true)"
first_dash="$(grep -m1 'new dashboard page:' <<<"$signals" | sed -E 's/^- new dashboard page: //')"
first_cli="$(grep -m1 'new CLI module:' <<<"$signals" | sed -E 's/^- new CLI module: //')"

if [[ -n "$first_skill" ]]; then
  COACHING="Run with $first_skill or read the SKILL.md."
elif [[ -n "$first_bus_signal" ]]; then
  COACHING="Try cortextos bus --help to see the new command."
elif [[ -n "$first_dash" ]]; then
  COACHING="Visit dashboard at $first_dash."
elif [[ -n "$first_cli" ]]; then
  COACHING="See $first_cli for the new entrypoint."
else
  COACHING="See PR for details."
fi

# Title for the message: prefer PR title from primary subject (strip
# conventional-commit prefix and trailing PR number), fall back to merge
# subject. The PR number is shown on its own line via PR_URL anyway.
# Strip newlines and tabs defensively so they cannot smuggle into JSON or
# Telegram message payloads.
TITLE="$PRIMARY_SUBJECT"
TITLE="$(echo "$TITLE" | sed -E 's/^(feat|fix|chore|refactor|test|docs|style|ci)\([^)]*\):[[:space:]]*//')"
TITLE="$(echo "$TITLE" | sed -E 's/[[:space:]]*\(#[0-9]+\)[[:space:]]*$//')"
TITLE="$(printf '%s' "$TITLE" | tr '\n\t' '  ')"
[[ -z "$TITLE" ]] && TITLE="$MERGE_SUBJECT"

# ── Dry-run path ─────────────────────────────────────────────────────────────
if [[ "${POST_MERGE_NOTIFY_DRY_RUN:-0}" == "1" ]]; then
  echo "TIER=$TIER"
  echo "SCORE=$score"
  echo "PR_NUMBER=$PR_NUMBER"
  echo "TITLE=$TITLE"
  echo "PR_URL=$PR_URL"
  echo "COACHING=$COACHING"
  echo "SIGNALS:"
  echo "$signals"
  exit 0
fi

# ── Skip path ────────────────────────────────────────────────────────────────
if [[ "$TIER" == "skip" ]]; then
  log "Tier=skip score=$score subject='$PRIMARY_SUBJECT' (no notification)."
  exit 0
fi

# ── Resolve digest file path ─────────────────────────────────────────────────
DIGEST_FILE="${POST_MERGE_NOTIFY_DIGEST_FILE:-}"
if [[ -z "$DIGEST_FILE" ]]; then
  state_root="${CTX_ROOT:-$HOME/.cortextos/${CTX_INSTANCE_ID:-default}}"
  DIGEST_FILE="$state_root/state/pr-digest.jsonl"
fi
mkdir -p "$(dirname "$DIGEST_FILE")" 2>/dev/null || true

# ── Tier 2: append to digest, exit ───────────────────────────────────────────
if [[ "$TIER" == "2" ]]; then
  printf '{"ts":"%s","tier":2,"pr":"%s","title":"%s","subject":"%s","score":%s,"url":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "${PR_NUMBER:-?}" \
    "$(echo "$TITLE" | sed 's/"/\\"/g')" \
    "$(echo "$PRIMARY_SUBJECT" | sed 's/"/\\"/g')" \
    "$score" \
    "$PR_URL" \
    >> "$DIGEST_FILE"
  log "Tier=2 score=$score appended to digest: $DIGEST_FILE"
  exit 0
fi

# ── Tier 1: immediate Telegram ───────────────────────────────────────────────
# Resolve chat_id and ensure BOT_TOKEN is in env (cortextos bus send-telegram
# reads BOT_TOKEN from process env or agent .env; we point it at boss .env).
BOSS_ENV="${POST_MERGE_NOTIFY_BOSS_ENV:-$REPO_ROOT/orgs/cortex/agents/boss/.env}"
if [[ ! -r "$BOSS_ENV" ]]; then
  log "Tier=1 but boss .env not readable at '$BOSS_ENV' — appending to digest instead."
  printf '{"ts":"%s","tier":"1-fallback","pr":"%s","title":"%s","reason":"boss .env unreadable"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${PR_NUMBER:-?}" "$(echo "$TITLE" | sed 's/"/\\"/g')" \
    >> "$DIGEST_FILE"
  exit 0
fi

CHAT_ID="$(grep -E '^CHAT_ID=' "$BOSS_ENV" | head -n 1 | sed 's/^CHAT_ID=//' | tr -d '"' | tr -d "'" | tr -d ' ')"
BOT_TOKEN="$(grep -E '^BOT_TOKEN=' "$BOSS_ENV" | head -n 1 | sed 's/^BOT_TOKEN=//' | tr -d '"' | tr -d "'" | tr -d ' ')"

if [[ -z "$CHAT_ID" || -z "$BOT_TOKEN" ]]; then
  log "Tier=1 but CHAT_ID/BOT_TOKEN missing from '$BOSS_ENV' — appending to digest instead."
  printf '{"ts":"%s","tier":"1-fallback","pr":"%s","title":"%s","reason":"no chat_id or token"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${PR_NUMBER:-?}" "$(echo "$TITLE" | sed 's/"/\\"/g')" \
    >> "$DIGEST_FILE"
  exit 0
fi

# Compose message — Logan's exact phrasing template.
MESSAGE="New thing you can use: $TITLE."$'\n'"$COACHING"
if [[ -n "$PR_URL" ]]; then
  MESSAGE="$MESSAGE"$'\n'"PR: $PR_URL"
fi

# Send via cortextos bus — reuses Markdown-fallback handling.
if ! command -v cortextos >/dev/null 2>&1; then
  log "cortextos binary missing — cannot send Tier 1 ping. Falling back to digest."
  printf '{"ts":"%s","tier":"1-fallback","pr":"%s","title":"%s","reason":"cortextos missing"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${PR_NUMBER:-?}" "$(echo "$TITLE" | sed 's/"/\\"/g')" \
    >> "$DIGEST_FILE"
  exit 0
fi

BOT_TOKEN="$BOT_TOKEN" cortextos bus send-telegram "$CHAT_ID" "$MESSAGE" --plain-text \
  >/dev/null 2>&1 || {
    log "send-telegram failed — falling back to digest entry."
    printf '{"ts":"%s","tier":"1-fallback","pr":"%s","title":"%s","reason":"send-telegram failed"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${PR_NUMBER:-?}" "$(echo "$TITLE" | sed 's/"/\\"/g')" \
      >> "$DIGEST_FILE"
    exit 0
  }

log "Tier=1 ping sent for PR ${PR_NUMBER:-?} (score=$score)."
exit 0
