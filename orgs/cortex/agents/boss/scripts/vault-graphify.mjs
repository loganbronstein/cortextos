#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

function option(name, fallback = undefined) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

const vaultRoot = path.resolve(option('--vault-root', process.env.VAULT || path.join(process.env.HOME || '', 'Sale Advisor', 'Vault')));
const targetRoot = path.resolve(option('--target', vaultRoot));
const agent = option('--agent', 'vault');
const today = new Date().toISOString().slice(0, 10);
const reportDir = path.join(vaultRoot, 'Reports', 'cortextos-graph');
const dataDir = path.join(reportDir, 'data');

const EXCLUDE = new Set(['.obsidian', '.git', 'attachments', 'node_modules']);
const WIKILINK = /\[\[([^\]]+)\]\]/g;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const isSymlinkDir = entry.isSymbolicLink() && fs.existsSync(full) && fs.statSync(full).isDirectory();
    if (entry.isDirectory() || isSymlinkDir) {
      walk(full, out);
    } else if (entry.isFile() && full.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function relVault(file) {
  return path.relative(vaultRoot, file).split(path.sep).join('/');
}

function canonicalTarget(raw) {
  return raw.split('|')[0].split('#')[0].trim();
}

function nodeLabelFor(file) {
  const rel = relVault(file);
  return rel.endsWith('.md') ? rel.slice(0, -3) : rel;
}

const files = walk(targetRoot).sort();
const known = new Map();
for (const file of files) {
  known.set(path.basename(file, '.md').toLowerCase(), nodeLabelFor(file));
  known.set(nodeLabelFor(file).toLowerCase(), nodeLabelFor(file));
}

const nodes = new Map();
const edges = [];
const missing = new Map();

function ensureNode(label) {
  if (!nodes.has(label)) {
    nodes.set(label, { id: label, outgoing: 0, incoming: 0 });
  }
  return nodes.get(label);
}

for (const file of files) {
  const source = nodeLabelFor(file);
  ensureNode(source);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const match of text.matchAll(WIKILINK)) {
    const targetRaw = canonicalTarget(match[1]);
    if (!targetRaw) continue;
    const target = known.get(targetRaw.toLowerCase()) || known.get(path.basename(targetRaw).toLowerCase());
    if (!target) {
      missing.set(targetRaw, (missing.get(targetRaw) || 0) + 1);
      continue;
    }
    if (target === source) continue;
    edges.push({ source, target });
    ensureNode(source).outgoing += 1;
    ensureNode(target).incoming += 1;
  }
}

const adjacency = new Map();
for (const node of nodes.keys()) adjacency.set(node, new Set());
for (const edge of edges) {
  adjacency.get(edge.source)?.add(edge.target);
  adjacency.get(edge.target)?.add(edge.source);
}

const seen = new Set();
const components = [];
for (const node of nodes.keys()) {
  if (seen.has(node)) continue;
  const queue = [node];
  const members = [];
  seen.add(node);
  while (queue.length) {
    const current = queue.shift();
    members.push(current);
    for (const next of adjacency.get(current) || []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  components.push(members.sort());
}
components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));

const rankedNodes = [...nodes.values()]
  .map((node) => ({ ...node, degree: node.incoming + node.outgoing }))
  .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));

const missingRanked = [...missing.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

fs.mkdirSync(dataDir, { recursive: true });
const suffix = agent === 'vault' ? 'vault' : agent;
const reportPath = path.join(reportDir, `${today}-${suffix}.md`);
const dataPath = path.join(dataDir, `${today}-${suffix}.json`);

fs.writeFileSync(dataPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  vault_root: vaultRoot,
  target_root: targetRoot,
  agent,
  nodes: [...nodes.values()],
  edges,
  missing: Object.fromEntries(missingRanked),
  components,
}, null, 2));

const lines = [
  '---',
  `date: ${today}`,
  'type: graph-report',
  `agent: ${agent}`,
  'tool: vault-graphify',
  '---',
  '',
  `# Cortex Vault Graph Report - ${today} (${agent})`,
  '',
  '> Auto-generated from Obsidian wikilinks. This is the weekly Graphify-equivalent pass for Markdown vault memory.',
  '',
  '## Summary',
  `- Target: \`${path.relative(vaultRoot, targetRoot) || '.'}\``,
  `- Markdown files: ${files.length}`,
  `- Nodes with links: ${nodes.size}`,
  `- Resolved wikilink edges: ${edges.length}`,
  `- Missing wikilink targets: ${missingRanked.length}`,
  `- Connected components: ${components.length}`,
  `- Data: \`${path.relative(vaultRoot, dataPath).split(path.sep).join('/')}\``,
  '',
  '## Top Nodes',
  '',
];

if (!rankedNodes.length || rankedNodes[0].degree === 0) {
  lines.push('(no linked nodes yet)');
} else {
  for (const node of rankedNodes.filter((n) => n.degree > 0).slice(0, 25)) {
    lines.push(`- [[${node.id}]] - degree ${node.degree}, incoming ${node.incoming}, outgoing ${node.outgoing}`);
  }
}

lines.push('', '## Largest Components', '');
for (const component of components.slice(0, 10)) {
  lines.push(`- ${component.length} node(s): ${component.slice(0, 8).map((n) => `[[${n}]]`).join(', ')}${component.length > 8 ? ' ...' : ''}`);
}

lines.push('', '## Missing Targets', '');
if (!missingRanked.length) {
  lines.push('(none)');
} else {
  for (const [target, count] of missingRanked.slice(0, 50)) {
    lines.push(`- \`[[${target}]]\` referenced ${count} time(s)`);
  }
}

lines.push('', `Generated ${new Date().toISOString()} by vault-graphify.mjs`, '');
fs.writeFileSync(reportPath, lines.join('\n'));

console.log(`Vault graph report: ${reportPath}`);
