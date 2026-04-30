#!/usr/bin/env node
/**
 * Route folded transcript memory into the right Obsidian domains.
 *
 * This does not mutate Logan's canonical notes. It creates a source-linked
 * routing queue so scribe/boss can promote useful knowledge into the right
 * domain instead of dumping everything into Vault/Cortex.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const VAULT = process.env.VAULT || path.join(os.homedir(), 'Sale Advisor', 'Vault');
const TODAY = new Date().toISOString().slice(0, 10);
const RESEARCH_DIR = path.join(VAULT, 'Research', 'cortextos', 'chat-research');
const OUT_DIR = path.join(VAULT, 'Reports', 'cortextos-routing');
const ORG_QUEUE = path.join(VAULT, 'Cortex', '_org', 'Inbox', '_route-queue.md');

const DOMAINS = [
  {
    id: 'pricing',
    title: 'Pricing and Valuation',
    targets: ['Research/Pricing/', 'Pricer Accuracy.md', 'IKEA Depreciation.md'],
    keywords: ['pricing', 'pricer', 'valuation', 'autoresearch', 'ground truth', 'comps', 'comparables', 'ebay finding', '77.7', '90+'],
  },
  {
    id: 'sorzo',
    title: 'Sorzo',
    targets: ['Research/Sorzo/', 'Sorzo Sell Side.md'],
    keywords: ['sorzo', 'marketplace intelligence', 'sell side', 'buy side', 'expo', 'edge function'],
  },
  {
    id: 'sale-advisor-ops',
    title: 'Sale Advisor Operations',
    targets: ['Operations.md', 'Client Playbook.md', 'Clients/', 'Leads/', 'SMS and Messaging.md'],
    keywords: ['sale advisor', 'crm', 'client', 'lead', 'listing', 'payout', 'commission', 'telnyx', 'phone number', 'keller'],
  },
  {
    id: 'marketing',
    title: 'Marketing',
    targets: ['Marketing/', 'Marketing Intel/', 'Content Calendar.md', 'Ad Strategy.md', 'Brand Guide.md'],
    keywords: ['marketing', 'caption', 'flyer', 'ad', 'meta', 'instagram', 'facebook', 'tiktok', 'fal', 'brand', 'campaign'],
  },
  {
    id: 'business-strategy',
    title: 'Business Strategy and Ideas',
    targets: ['Ideas.md', 'Revenue Model.md', 'Launch Plan.md', 'Business Rules.md'],
    keywords: ['idea', 'business idea', 'strategy', 'revenue', 'launch', 'market', 'opportunity', 'business model'],
  },
  {
    id: 'decisions-rules',
    title: 'Decisions and Rules',
    targets: ['Decisions.md', 'Rules/', 'Lessons Learned.md'],
    keywords: ['decision', 'decided', 'approved', 'rejected', 'canonical', 'rule', 'must', 'never', 'locked'],
  },
  {
    id: 'technical',
    title: 'Technical Systems',
    targets: ['Tech Stack.md', 'Automation Map.md', 'Skills and Tools.md', 'Reports/'],
    keywords: ['api', 'database', 'db', 'github', 'vercel', 'build', 'test', 'deploy', 'pr ', 'commit', 'hook', 'cron'],
  },
  {
    id: 'people',
    title: 'People and Relationships',
    targets: ['People/', 'Clients/', 'Contacts.md'],
    keywords: ['logan', 'keller', 'client', 'customer', 'contact', 'person'],
  },
  {
    id: 'cortex-os',
    title: 'Cortex OS and Agent Memory',
    targets: ['Cortex/', 'Memory Architecture.md', 'Cortex Index.md', 'Reports/memory-health/'],
    keywords: ['cortex', 'memory', 'scribe', 'obsidian', 'agent', 'boss', 'coder', 'analyst', 'restart', 'compact', 'telegram'],
  },
];

function latestResearchPaper() {
  if (!fs.existsSync(RESEARCH_DIR)) return null;
  return fs.readdirSync(RESEARCH_DIR)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .map((name) => path.join(RESEARCH_DIR, name))
    .sort()
    .at(-1) || null;
}

function sourceLink(line) {
  const match = line.match(/\(\[\[([^\]]+)\]\]\)/);
  return match ? match[1] : null;
}

function cleanLine(line) {
  return line
    .replace(/^- /, '')
    .replace(/\s*\(\[\[[^\]]+\]\]\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function isUsefulCandidate(line) {
  const text = cleanLine(line);
  if (text.length < 40) return false;
  if (/^(Source:|# Transcript|~~~|generated |read \d+ files\b)/i.test(text)) return false;
  if (/[⏺❯⎿✻✶✳✢◼]/.test(text)) return false;
  if (/\b(ctrl\+o|whirring|jitterbugging|julienning|frolicking|tip: name your conversations|press up to edit|shell cwd was reset)\b/i.test(text)) return false;
  if (/^(bash|todo|running|listing|reading)\(/i.test(text)) return false;
  return /\b(Logan|Sale Advisor|Sorzo|pricing|pricer|valuation|marketing|client|decision|rule|approved|rejected|blocked|blocker|must|never|memory|Cortex|Obsidian|scribe|shipped|verified|fixed|task_|PR #|FAL|Meta|phone)\b/i.test(text);
}

function scoreDomain(text, domain) {
  const lower = text.toLowerCase();
  return domain.keywords.reduce((score, keyword) => score + (lower.includes(keyword) ? 1 : 0), 0);
}

function routeLine(line) {
  const text = cleanLine(line);
  const scored = DOMAINS
    .map((domain) => ({ domain, score: scoreDomain(text, domain) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.domain.id.localeCompare(b.domain.id));
  const primary = scored[0]?.domain || DOMAINS.find((d) => d.id === 'cortex-os');
  return {
    text,
    source: sourceLink(line),
    primary,
    secondary: scored.slice(1, 3).map((item) => item.domain),
  };
}

const source = latestResearchPaper();
if (!source) {
  console.error(`No chat research paper found in ${RESEARCH_DIR}`);
  process.exit(1);
}

const raw = fs.readFileSync(source, 'utf8');
const lines = raw
  .split('\n')
  .filter((line) => line.startsWith('- ') && line.includes('([['))
  .filter(isUsefulCandidate)
  .map(routeLine);

const grouped = new Map();
for (const domain of DOMAINS) grouped.set(domain.id, []);
for (const item of lines) grouped.get(item.primary.id)?.push(item);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.dirname(ORG_QUEUE), { recursive: true });

const outPath = path.join(OUT_DIR, `${TODAY}.md`);
const sourceRel = path.relative(VAULT, source).replace(/\.md$/, '').split(path.sep).join('/');

const report = [
  '---',
  `date: ${TODAY}`,
  'type: memory-routing-report',
  'source_agent: scribe',
  `source: ${sourceRel}`,
  'status: proposal',
  '---',
  '',
  `# Memory Routing Report - ${TODAY}`,
  '',
  '> This is a routing queue, not canonical memory. Raw transcripts stay in Research/cortextos. Cortex/system lessons go to Cortex. Domain knowledge should be promoted into the existing domain notes below.',
  '',
  '## Routing Rules',
  '',
  '- Cortex OS / agent behavior -> `Vault/Cortex/`, `Memory Architecture.md`, `Cortex Index.md`',
  '- Pricing / valuation -> `Research/Pricing/`, `Pricer Accuracy.md`',
  '- Sorzo -> `Research/Sorzo/`, `Sorzo Sell Side.md`',
  '- Sale Advisor ops / clients / leads -> `Operations.md`, `Client Playbook.md`, `Clients/`, `Leads/`',
  '- Marketing -> `Marketing/`, `Marketing Intel/`, `Content Calendar.md`, `Brand Guide.md`',
  '- Business ideas / strategy -> `Ideas.md`, `Revenue Model.md`, `Launch Plan.md`',
  '- Decisions / rules -> `Decisions.md`, `Rules/`, `Lessons Learned.md`',
  '',
  '## Source',
  '',
  `- [[${sourceRel}]]`,
  '',
];

for (const domain of DOMAINS) {
  const items = grouped.get(domain.id) || [];
  report.push(`## ${domain.title}`, '', `Suggested targets: ${domain.targets.map((target) => `\`${target}\``).join(', ')}`, '');
  if (!items.length) {
    report.push('(none)', '');
    continue;
  }
  for (const item of items.slice(0, 25)) {
    const sourcePart = item.source ? ` ([[${item.source}]])` : '';
    const secondary = item.secondary.length ? ` Secondary: ${item.secondary.map((d) => d.title).join(', ')}.` : '';
    report.push(`- [ ] ${item.text}${sourcePart}${secondary}`);
  }
  if (items.length > 25) report.push(`- ... and ${items.length - 25} more candidate(s).`);
  report.push('');
}

fs.writeFileSync(outPath, `${report.join('\n')}\n`);

const queue = [
  `## ${TODAY}`,
  '',
  `- Review [[Reports/cortextos-routing/${TODAY}]] before promoting memory. Do not dump all knowledge into Cortex; route domain knowledge to its natural Vault home.`,
  '',
];
fs.appendFileSync(ORG_QUEUE, queue.join('\n'));

console.log(`Memory routing report: ${outPath}`);
console.log(`Route queue updated: ${ORG_QUEUE}`);
