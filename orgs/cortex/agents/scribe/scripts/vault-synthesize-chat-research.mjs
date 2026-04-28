#!/usr/bin/env node
/**
 * Build a research paper from recent transcript archive notes.
 *
 * This is deliberately extractive and source-grounded. It does not replace the
 * raw transcript archive; it points Cortex toward recurring themes, decisions,
 * blockers, and system improvements worth acting on.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, relative } from 'path';

const HOME = homedir();
const VAULT = process.env.VAULT || join(HOME, 'Sale Advisor', 'Vault');
const TRANSCRIPT_ROOT = join(VAULT, 'Research', 'cortextos', 'transcripts');
const OUT_DIR = join(VAULT, 'Research', 'cortextos', 'chat-research');
const SINCE_DAYS = Number(process.env.SINCE_DAYS || '7');
const MAX_TRANSCRIPTS = Number(process.env.MAX_TRANSCRIPTS || '80');

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
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'Index.md') out.push(p);
    }
  }
  return out;
}

function sourceType(text) {
  const m = text.match(/^source_type:\s*(.+)$/m);
  return m ? m[1].trim() : 'unknown';
}

function sourceMtimeMs(text, fallbackMs) {
  const m = text.match(/^source_mtime_utc:\s*(.+)$/m);
  if (!m) return fallbackMs;
  const parsed = Date.parse(m[1].trim());
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

function redactSensitiveLine(line) {
  const credentialContext = /\b(api[_ -]?key|secret|token|password|credential|private[_ -]?key|bearer|authorization|fal_key|openai|anthropic|live key|revoked key|\.env)\b/i;
  if (credentialContext.test(line)) {
    return '[credential detail redacted]';
  }
  return line
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-openai-key]')
    .replace(/\bAIza[0-9A-Za-z_-]{12,}\b/g, '[redacted-google-key]')
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{20,}\b/g, '[redacted-bot-token]')
    .replace(/\bre_[A-Za-z0-9_-]{12,}\b/g, '[redacted-api-key]')
    .replace(/\bpostgres(?:ql)?:\/\/\S+/gi, '[redacted-database-url]')
    .replace(/\b[A-Za-z0-9_-]{16,}\.{3,}\b/g, '[redacted-key-fragment]');
}

function importantLines(text) {
  const body = text.replace(/^---[\s\S]*?---\s*/, '');
  const lines = body
    .split(/\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !l.startsWith('~~~') && !l.startsWith('{') && !l.startsWith('}') && l.length > 18);
  const patterns = [
    /\b(must|need|needs|should|blocked|blocker|fix|bug|broken|risk|decision|approved|rejected|wrong|stale|missing|failed|ship|shipped|verify|verified|restart|memory|scribe|obsidian|cortex)\b/i,
    /\b(Logan|Sale Advisor|Sorzo|Valuation Core|marketing|boss|coder|analyst|scribe)\b/i,
  ];
  return lines
    .filter(l => patterns.some(re => re.test(l)))
    .map(redactSensitiveLine)
    .filter((line, idx, arr) => arr.indexOf(line) === idx)
    .slice(0, 30);
}

function bucketLine(line) {
  if (/\b(decision|approved|rejected|canonical|rule|must|never)\b/i.test(line)) return 'Decisions and rules';
  if (/\b(blocked|blocker|missing|failed|broken|bug|risk|wrong|stale)\b/i.test(line)) return 'Blockers and risks';
  if (/\b(memory|scribe|obsidian|transcript|context|restart|compact)\b/i.test(line)) return 'Memory and operating system';
  if (/\b(ship|shipped|fixed|verified|passed|built|created)\b/i.test(line)) return 'Completed work';
  return 'Other useful signals';
}

mkdirSync(OUT_DIR, { recursive: true });

const cutoff = Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000;
const transcripts = walk(TRANSCRIPT_ROOT)
  .map(p => {
    const st = statSync(p);
    const text = readFileSync(p, 'utf-8');
    return { p, st, text, sourceMtime: sourceMtimeMs(text, st.mtimeMs) };
  })
  .filter(({ sourceMtime }) => sourceMtime >= cutoff)
  .sort((a, b) => b.sourceMtime - a.sourceMtime)
  .slice(0, MAX_TRANSCRIPTS);

const buckets = new Map();
const sources = [];

for (const { p, text } of transcripts) {
  const rel = relative(VAULT, p).replace(/\.md$/, '');
  sources.push(`- [[${rel}]] (${sourceType(text)})`);
  for (const line of importantLines(text)) {
    const bucket = bucketLine(line);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push({ line, rel });
  }
}

const today = new Date().toISOString().slice(0, 10);
const outPath = join(OUT_DIR, `${today}.md`);
const body = [
  '---',
  'type: research-paper',
  'source_agent: scribe',
  'source_task: chat-research-synthesis',
  `date_utc: ${new Date().toISOString()}`,
  'tags: [#research-paper, #transcripts, #memory, #cortex]',
  'status: active',
  'confidence: medium',
  '---',
  '',
  `# Chat research synthesis — ${today}`,
  '',
  '## Bottom line',
  '',
  `This paper distills recent redacted transcript archive notes. It is not a replacement for raw transcripts; every claim below links back to source transcript notes.`,
  '',
  '## What Cortex should improve next',
  '',
  '- Reduce user-visible restart noise; context auto-resets should be internal unless a real crash happens.',
  '- Keep raw transcripts searchable, but route decisions, blockers, and durable rules into Neon/KB/Vault index surfaces.',
  '- Generate daily research papers from transcripts so Cortex can retrieve patterns without rereading raw logs every time.',
  '- Add source-backed acceptance checks to every scribe memory product so memory quality is testable.',
  '',
];

for (const [bucket, items] of buckets) {
  body.push(`## ${bucket}`, '');
  for (const item of items.slice(0, 20)) {
    body.push(`- ${item.line.replace(/\s+/g, ' ').slice(0, 500)} ([[${item.rel}]])`);
  }
  body.push('');
}

body.push('## Sources', '', ...sources.slice(0, 120), '');

while (body[body.length - 1] === '') body.pop();
writeFileSync(outPath, `${body.join('\n')}\n`, 'utf-8');
writeFileSync(join(OUT_DIR, 'Index.md'), [
  '---',
  'type: research-paper-index',
  'source_agent: scribe',
  `last_updated_utc: ${new Date().toISOString()}`,
  'tags: [#research-paper, #transcripts, #memory, #cortex]',
  'status: active',
  '---',
  '',
  '# Chat research papers',
  '',
  `- [[Research/cortextos/chat-research/${today}]]`,
  '',
].join('\n'), 'utf-8');

console.log(`chat research synthesis complete - ${transcripts.length} transcript note(s), ${outPath}`);
