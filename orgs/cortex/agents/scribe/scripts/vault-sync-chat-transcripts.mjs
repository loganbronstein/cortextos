#!/usr/bin/env node
/**
 * Sync redacted chat/session transcripts into Logan's Vault.
 *
 * This is intentionally loss-preserving: each source file is mirrored as a
 * Markdown note containing the full redacted raw JSONL/log body. Research and
 * summaries are layered on top by vault-synthesize-chat-research.mjs; they do
 * not replace the transcript archive.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, relative } from 'path';
import { execFileSync } from 'child_process';

const HOME = homedir();
const VAULT = process.env.VAULT || join(HOME, 'Sale Advisor', 'Vault');
const OUT_ROOT = join(VAULT, 'Research', 'cortextos', 'transcripts');
const STATE_DIR = process.env.STATE_DIR || join(HOME, '.cortextos', 'default', 'state', 'scribe', 'chat-transcript-sync');
const SINCE_DAYS = Number(process.env.SINCE_DAYS || '14');
const MAX_FILES = Number(process.env.MAX_FILES || '200');
const SYNC_ALL = process.env.SYNC_ALL === '1' || process.argv.includes('--all');
const DRY_RUN = process.argv.includes('--dry-run');

const sourceDirs = [
  join(HOME, '.claude', 'projects'),
  join(HOME, '.codex', 'sessions'),
  join(HOME, '.cortextos', 'default', 'logs'),
  join(HOME, '.cortextos', 'default', 'orgs', 'cortex', 'tasks', 'audit'),
];

const explicitFiles = [
  join(HOME, '.codex', 'history.jsonl'),
  join(HOME, '.codex', 'session_index.jsonl'),
];

mkdirSync(OUT_ROOT, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
      } else if (entry.isFile() && /\.(jsonl|log)$/i.test(entry.name)) {
        out.push(p);
      }
    }
  }
  return out;
}

function readCodexThreadRollouts() {
  const db = join(HOME, '.codex', 'state_5.sqlite');
  if (!existsSync(db)) return [];
  try {
    const rows = execFileSync('sqlite3', [
      '-json',
      db,
      "select rollout_path from threads where rollout_path is not null and rollout_path != ''",
    ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(rows).map(r => r.rollout_path).filter(p => p && existsSync(p));
  } catch {
    return [];
  }
}

function sha(text) {
  return createHash('sha256').update(text).digest('hex');
}

function keyForPath(p) {
  return sha(p);
}

function safeName(text) {
  return text
    .replace(/^\/Users\/[^/]+\/?/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'transcript';
}

function sourceKind(p) {
  if (p.startsWith(join(HOME, '.claude', 'projects'))) return 'claude-code';
  if (p.startsWith(join(HOME, '.codex', 'sessions'))) return 'codex';
  if (p.endsWith(join('.codex', 'history.jsonl'))) return 'codex-history';
  if (p.endsWith(join('.codex', 'session_index.jsonl'))) return 'codex-index';
  if (p.includes(join('.cortextos', 'default', 'orgs', 'cortex', 'tasks', 'audit'))) return 'cortex-task-audit';
  if (p.includes(join('.cortextos', 'default', 'logs'))) return 'cortex-agent-log';
  return 'unknown';
}

function redact(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\].*?\x07/g, '')
    .replace(/sk-proj-[A-Za-z0-9_-]{20,}/g, '[OPENAI_KEY_REDACTED]')
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, '[ANTHROPIC_KEY_REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{32,}/g, '[API_KEY_REDACTED]')
    .replace(/[A-Za-z0-9_=-]*AIza[0-9A-Za-z_-]{20,}/g, '[GOOGLE_KEY_REDACTED]')
    .replace(/[0-9]{8,12}:[A-Za-z0-9_-]{25,}/g, '[BOT_TOKEN_REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s"')]+/g, 'postgres://[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/gi, 'Bearer [REDACTED]')
    .replace(/\b((?:BOT_TOKEN|TELEGRAM_BOT_TOKEN|GEMINI_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|DATABASE_URL|CORTEX_NEON_URL|SUPABASE_SERVICE_ROLE_KEY|RESEND_API_KEY|TELNYX_API_KEY|TWILIO_AUTH_TOKEN|UPSTASH_REDIS_REST_TOKEN|UPSTASH_REDIS_REST_URL|APPLE|RESEND|UPSTASH|TOKEN|SECRET|PASSWORD|API_KEY)\b\s*[:=]\s*)[^\s"',}]+/gi, '$1[REDACTED]');
}

function parseFirstTimestamp(raw, st) {
  const firstLines = raw.split(/\n/).slice(0, 50);
  for (const line of firstLines) {
    try {
      const obj = JSON.parse(line);
      const candidate = obj.timestamp || obj.ts || obj.created_at || obj.updated_at;
      if (typeof candidate === 'string' && !Number.isNaN(Date.parse(candidate))) return new Date(candidate);
      if (typeof candidate === 'number') return new Date(candidate > 10_000_000_000 ? candidate : candidate * 1000);
    } catch {
      const m = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      if (m) return new Date(`${m[0]}Z`);
    }
  }
  return st.mtime;
}

function extractSearchText(raw) {
  const pieces = [];
  for (const line of raw.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      collectStrings(obj, pieces, 0);
    } catch {
      pieces.push(line);
    }
    if (pieces.join('\n').length > 12000) break;
  }
  return redact(pieces.join('\n')).slice(0, 12000);
}

function collectStrings(value, pieces, depth) {
  if (depth > 5 || pieces.length > 80) return;
  if (typeof value === 'string') {
    if (value.trim()) pieces.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, pieces, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const keys = [
    'content', 'text', 'message', 'summary', 'note', 'prompt', 'instruction',
    'last_assistant_message', 'stdout', 'stderr', 'result', 'body',
  ];
  for (const key of keys) {
    if (key in value) collectStrings(value[key], pieces, depth + 1);
  }
}

function shouldSync(p, st) {
  if (SYNC_ALL) return true;
  const cutoff = Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000;
  if (st.mtimeMs < cutoff) return false;
  const statePath = join(STATE_DIR, `${keyForPath(p)}.json`);
  if (!existsSync(statePath)) return true;
  try {
    const prev = JSON.parse(readFileSync(statePath, 'utf-8'));
    return prev.size !== st.size || prev.mtimeMs !== st.mtimeMs;
  } catch {
    return true;
  }
}

function writeTranscript(p) {
  const st = statSync(p);
  const raw = readFileSync(p, 'utf-8');
  const firstDate = parseFirstTimestamp(raw, st);
  const date = firstDate.toISOString().slice(0, 10);
  const kind = sourceKind(p);
  const rel = p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
  const outDir = join(OUT_ROOT, kind, date);
  const outPath = join(outDir, `${safeName(rel)}-${keyForPath(p).slice(0, 10)}.md`);
  const searchableText = extractSearchText(raw);
  const redactedRaw = redact(raw);
  const body = `---\n` +
    `id: cortex-transcript-${keyForPath(p).slice(0, 16)}\n` +
    `type: transcript\n` +
    `source_agent: scribe\n` +
    `source_type: ${kind}\n` +
    `source_path: ${rel}\n` +
    `date_utc: ${new Date().toISOString()}\n` +
    `source_mtime_utc: ${st.mtime.toISOString()}\n` +
    `source_size_bytes: ${st.size}\n` +
    `tags: [#transcript, #memory, #cortex]\n` +
    `status: active\n` +
    `confidence: high\n` +
    `---\n\n` +
    `# Transcript — ${kind} — ${date}\n\n` +
    `Source: \`${rel}\`\n\n` +
    `## Search text\n\n` +
    `${searchableText || '(no extractable text)'}\n\n` +
    `## Full redacted source\n\n` +
    `~~~${p.endsWith('.jsonl') ? 'jsonl' : 'text'}\n` +
    `${redactedRaw}\n` +
    `~~~\n`;

  if (!DRY_RUN) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, body, 'utf-8');
    writeFileSync(join(STATE_DIR, `${keyForPath(p)}.json`), JSON.stringify({
      source: p,
      output: outPath,
      size: st.size,
      mtimeMs: st.mtimeMs,
      syncedAt: new Date().toISOString(),
    }, null, 2), 'utf-8');
  }
  return { p, outPath, kind, date, size: st.size };
}

function updateIndex(results) {
  const lines = [
    '---',
    'id: cortex-transcript-index',
    'type: transcript-index',
    'source_agent: scribe',
    `last_updated_utc: ${new Date().toISOString()}`,
    'tags: [#transcript, #memory, #cortex]',
    'status: active',
    '---',
    '',
    '# Cortex transcript archive index',
    '',
    'Raw chat/session sources are mirrored as redacted transcript notes. Synthesis papers live in `Research/cortextos/chat-research/`.',
    '',
    '## Latest sync',
    '',
    `- Files synced this run: ${results.length}`,
    `- Full historical backfill: run \`SYNC_ALL=1 MAX_FILES=0 node /Users/loganbronstein/cortextos/orgs/cortex/agents/scribe/scripts/vault-sync-chat-transcripts.mjs\``,
    '',
    '## Recent files',
    '',
  ];
  for (const result of results.slice(0, 200)) {
    lines.push(`- [[${relative(VAULT, result.outPath).replace(/\.md$/, '')}]] (${result.kind}, ${(result.size / 1024).toFixed(1)} KB)`);
  }
  if (!DRY_RUN) writeFileSync(join(OUT_ROOT, 'Index.md'), `${lines.join('\n')}\n`, 'utf-8');
}

const files = [
  ...sourceDirs.flatMap(walk),
  ...explicitFiles.filter(existsSync),
  ...readCodexThreadRollouts(),
];

const unique = Array.from(new Set(files)).filter(p => existsSync(p));
const candidates = unique
  .map(p => ({ p, st: statSync(p) }))
  .filter(({ p, st }) => shouldSync(p, st))
  .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

const selected = MAX_FILES > 0 ? candidates.slice(0, MAX_FILES) : candidates;
const results = selected.map(({ p }) => writeTranscript(p));
updateIndex(results);

console.log(`chat transcript sync complete - ${results.length} file(s) mirrored, ${candidates.length} candidate(s)`);
