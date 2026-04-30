#!/usr/bin/env node
/**
 * Run Logan's canonical Lazy Obsidian Method pipeline end to end.
 *
 * The baseline is intentionally literal:
 * Capture raw -> process -> link -> compound, with PARA, Kepano-style Obsidian
 * writing workflows, Graphify, QMD, and recurring jobs kept as separate layers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CORTEX_ROOT = process.env.CORTEX_ROOT || path.resolve(SCRIPT_DIR, '..', '..', '..', '..', '..');
const VAULT = process.env.VAULT || path.join(HOME, 'Sale Advisor', 'Vault');
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_DIR = path.join(VAULT, 'Reports', 'lazy-obsidian');
const FRAMEWORK_NOTE = path.join(VAULT, 'Cortex', '_org', 'Compound', 'lazy-obsidian-framework.md');
const SKILL_ROOT = path.join(HOME, '.codex', 'skills');

const RUN_SYNC_ALL = process.env.LAZY_SYNC_ALL === '1' || process.argv.includes('--sync-all');
const SKIP_GRAPHIFY = process.env.LAZY_SKIP_GRAPHIFY === '1' || process.argv.includes('--skip-graphify');
const SKIP_QMD = process.env.LAZY_SKIP_QMD === '1' || process.argv.includes('--skip-qmd');
const SKIP_QMD_EMBED = process.env.LAZY_SKIP_QMD_EMBED === '1' || process.argv.includes('--skip-qmd-embed');

const PATH = [
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, '.npm-global', 'bin'),
  process.env.PATH || '',
].join(':');

function commandExists(command) {
  const result = spawnSync('bash', ['-lc', `command -v ${command}`], {
    encoding: 'utf-8',
    env: { ...process.env, PATH },
  });
  return result.status === 0;
}

function cleanOutput(text) {
  return text
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\].*?\x07/g, '')
    .replace(/\r+/g, '\n')
    .trim();
}

function runStep(name, command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd || CORTEX_ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH,
      VAULT,
      CORTEX_ROOT,
      ...(options.env || {}),
    },
  });
  const output = cleanOutput(`${result.stdout || ''}${result.stderr || ''}`);
  return {
    name,
    status: result.status === 0 ? 'PASS' : 'FAIL',
    exitCode: result.status,
    ms: Date.now() - started,
    output: output.split('\n').slice(-12).join('\n'),
  };
}

function ensureQmdVaultContext() {
  const started = Date.now();
  const existing = spawnSync('qmd', ['context', 'list'], {
    cwd: VAULT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH },
  });
  if (existing.status !== 0) {
    return {
      name: 'QMD: ensure Vault collection context',
      status: 'FAIL',
      exitCode: existing.status,
      ms: Date.now() - started,
      output: `${existing.stdout || ''}${existing.stderr || ''}`.trim(),
    };
  }
  const current = `${existing.stdout || ''}${existing.stderr || ''}`;
  if (/Configured Contexts[\s\S]*\bVault\b[\s\S]*\/ \(root\)/.test(current)) {
    return {
      name: 'QMD: ensure Vault collection context',
      status: 'PASS',
      exitCode: 0,
      ms: Date.now() - started,
      output: 'Vault root context already configured.',
    };
  }
  return runStep('QMD: ensure Vault collection context', 'qmd', [
    'context',
    'add',
    'qmd://Vault/',
    "Logan's Obsidian Vault for Sale Advisor, Cortex OS memory, transcripts, research papers, domain notes, decisions, rules, marketing, pricing, Sorzo, clients, and operating context.",
  ], { cwd: VAULT });
}

function ensureParaFolders() {
  const dirs = [
    'raw',
    'Projects',
    'Areas',
    'Resources',
    'Archive',
    path.join('Research', 'cortextos', 'transcripts'),
    path.join('Research', 'cortextos', 'chat-research'),
    path.join('Reports', 'lazy-obsidian'),
    path.join('Cortex', '_org', 'Inbox'),
  ];
  for (const dir of dirs) mkdirSync(path.join(VAULT, dir), { recursive: true });
}

function fileSummary(filePath) {
  if (!existsSync(filePath)) return 'missing';
  try {
    const firstLine = readFileSync(filePath, 'utf-8').split('\n').find(Boolean) || 'empty file';
    return firstLine.slice(0, 140);
  } catch {
    return 'present';
  }
}

ensureParaFolders();

const syncScript = path.join(SCRIPT_DIR, 'vault-sync-chat-transcripts.mjs');
const foldScript = path.join(SCRIPT_DIR, 'vault-synthesize-chat-research.mjs');
const routeScript = path.join(SCRIPT_DIR, 'vault-route-memory.mjs');
const wikilinkScript = path.join(CORTEX_ROOT, 'orgs', 'cortex', 'agents', 'boss', 'scripts', 'vault-graphify.mjs');

const steps = [];
steps.push(runStep('Daily ingest: capture raw chats, agent logs, task audit, and session sources', 'node', [syncScript], {
  env: {
    SINCE_DAYS: RUN_SYNC_ALL ? '3650' : '14',
    MAX_FILES: RUN_SYNC_ALL ? '0' : '200',
    SYNC_ALL: RUN_SYNC_ALL ? '1' : '0',
  },
}));
steps.push(runStep('Karpathy process: fold raw transcript archive into source-linked research', 'node', [foldScript]));
steps.push(runStep('Karpathy link: route useful claims to natural Obsidian domains', 'node', [routeScript]));
steps.push(runStep('Obsidian wikilinks: generate native link/orphan report separate from Graphify', 'node', [
  wikilinkScript,
  '--target',
  path.join(VAULT, 'Cortex'),
  '--vault-root',
  VAULT,
], { cwd: VAULT }));

if (SKIP_GRAPHIFY) {
  steps.push({ name: 'Graphify: skipped by --skip-graphify', status: 'SKIP', exitCode: 0, ms: 0, output: '' });
} else if (!commandExists('graphify')) {
  steps.push({ name: 'Graphify: safishamsi/graphify command available', status: 'FAIL', exitCode: 127, ms: 0, output: 'graphify is not on PATH' });
} else if (!existsSync(path.join(VAULT, 'graphify-out', 'graph.json'))) {
  steps.push({ name: 'Graphify: existing persistent Vault graph', status: 'FAIL', exitCode: 1, ms: 0, output: `missing ${path.join(VAULT, 'graphify-out', 'graph.json')}` });
} else {
  steps.push(runStep('Graphify: refresh communities, god nodes, graph.json, graph.html, GRAPH_REPORT.md', 'graphify', ['cluster-only', '.'], { cwd: VAULT }));
}

if (SKIP_QMD) {
  steps.push({ name: 'QMD: skipped by --skip-qmd', status: 'SKIP', exitCode: 0, ms: 0, output: '' });
} else if (!commandExists('qmd')) {
  steps.push({ name: 'QMD: command available for markdown retrieval', status: 'FAIL', exitCode: 127, ms: 0, output: 'qmd is not on PATH' });
} else {
  steps.push(ensureQmdVaultContext());
  steps.push(runStep('QMD: re-index Vault markdown collection', 'qmd', ['update'], { cwd: VAULT }));
  if (SKIP_QMD_EMBED) {
    steps.push({ name: 'QMD: skipped vector embedding refresh by --skip-qmd-embed', status: 'SKIP', exitCode: 0, ms: 0, output: '' });
  } else {
    steps.push(runStep('QMD: refresh vector embeddings for current Vault notes', 'qmd', ['embed', '--max-docs-per-batch', '100', '--max-batch-mb', '20'], { cwd: VAULT }));
  }
  steps.push(runStep('QMD: verify markdown retrieval engine status', 'qmd', ['status'], { cwd: VAULT }));
}

const reportPath = path.join(OUT_DIR, `${TODAY}.md`);
const failed = steps.filter((step) => step.status === 'FAIL');
const report = [
  '---',
  `date: ${TODAY}`,
  'type: lazy-obsidian-run-report',
  'source_agent: scribe',
  `status: ${failed.length ? 'failed' : 'passed'}`,
  'tags: [#lazy-obsidian, #memory, #cortex]',
  '---',
  '',
  `# Lazy Obsidian Method run - ${TODAY}`,
  '',
  '## Canonical Framework',
  '',
  `- Source note: [[Cortex/_org/Compound/lazy-obsidian-framework]] (${fileSummary(FRAMEWORK_NOTE)})`,
  '- Vault: Obsidian - local-first markdown notes.',
  '- Method: Karpathy LLM wiki - capture raw -> process -> link -> compound.',
  '- Structure: PARA - Projects, Areas, Resources, Archive.',
  '- Workflow: Obsidian Skills / Kepano - practical vault workflows.',
  '- Graph: Graphify - clusters, god nodes, graph.json, graph.html, GRAPH_REPORT.md.',
  '- Search: QMD - markdown retrieval as the vault grows.',
  '',
  '## Recurring Jobs',
  '',
  '- Daily ingest: web clips, notes, voice memos, chats, agent logs -> cleaned notes, wiki-ready pages, ingest summary.',
  '- Nightly review: daily notes, lessons, agent logs, memory -> refreshed dashboards, memory updates, backups.',
  '- Weekly vault: memory, dashboards, topic gaps -> weekly review, gaps list, next-step items.',
  '',
  '## This Run',
  '',
  ...steps.flatMap((step) => [
    `- ${step.status} ${step.name} (${step.ms}ms)`,
    step.output ? `  - ${step.output.replace(/\n/g, '\n  - ')}` : '',
  ]).filter(Boolean),
  '',
  '## Acceptance Checks',
  '',
  `- ${existsSync(path.join(VAULT, 'raw')) ? 'PASS' : 'FAIL'} Raw capture folder exists: \`raw/\``,
  `- ${existsSync(path.join(VAULT, 'Projects')) && existsSync(path.join(VAULT, 'Areas')) && existsSync(path.join(VAULT, 'Resources')) && existsSync(path.join(VAULT, 'Archive')) ? 'PASS' : 'FAIL'} PARA folders exist: \`Projects/\`, \`Areas/\`, \`Resources/\`, \`Archive/\``,
  `- ${existsSync(path.join(VAULT, 'Research', 'cortextos', 'transcripts', 'Index.md')) ? 'PASS' : 'FAIL'} Transcript archive index exists.`,
  `- ${existsSync(path.join(VAULT, 'Research', 'cortextos', 'chat-research', `${TODAY}.md`)) ? 'PASS' : 'FAIL'} Source-linked chat research paper exists.`,
  `- ${existsSync(path.join(VAULT, 'Reports', 'cortextos-routing', `${TODAY}.md`)) ? 'PASS' : 'FAIL'} Domain routing queue exists.`,
  `- ${existsSync(path.join(VAULT, 'Reports', 'cortextos-graph', `${TODAY}-vault.md`)) ? 'PASS' : 'FAIL'} Obsidian wikilink report exists.`,
  `- ${existsSync(path.join(VAULT, 'graphify-out', 'GRAPH_REPORT.md')) ? 'PASS' : 'FAIL'} Graphify report exists.`,
  `- ${commandExists('qmd') ? 'PASS' : 'FAIL'} QMD command is installed.`,
  `- ${steps.some((step) => step.name === 'QMD: ensure Vault collection context' && step.status === 'PASS') || SKIP_QMD ? 'PASS' : 'FAIL'} QMD Vault context is configured.`,
  `- ${existsSync(path.join(SKILL_ROOT, 'obsidian-markdown', 'SKILL.md')) ? 'PASS' : 'FAIL'} Kepano-style Obsidian markdown skill installed.`,
  '',
];

writeFileSync(reportPath, `${report.join('\n')}\n`, 'utf-8');

for (const step of steps) {
  console.log(`${step.status} ${step.name}`);
  if (step.output) console.log(step.output);
}
console.log(`Lazy Obsidian report: ${reportPath}`);

if (failed.length) process.exit(1);
