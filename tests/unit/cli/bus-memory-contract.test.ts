import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(__dirname, '..', '..', '..');

describe('bus memory command contract', () => {
  const busSource = readFileSync(join(repoRoot, 'src', 'cli', 'bus.ts'), 'utf-8');

  it('keeps first-class Vault memory commands wired into cortextos bus', () => {
    expect(busSource).toContain(".command('vault')");
    expect(busSource).toContain(".command('search')");
    expect(busSource).toContain(".command('ingest')");
    expect(busSource).toContain(".command('lint')");
    expect(busSource).toContain(".command('fold')");
    expect(busSource).toContain(".command('route')");
    expect(busSource).toContain(".command('lazy')");
    expect(busSource).toContain(".command('graphify')");
    expect(busSource).toContain(".command('wikilinks')");
    expect(busSource).toContain(".command('promote')");
    expect(busSource).toContain('resolveInside');
    expect(busSource).toContain('vault_promote');
  });

  it('keeps Graphify and Obsidian wikilinks as separate memory layers', () => {
    expect(busSource).toContain('safishamsi/graphify');
    expect(busSource).toContain('graphify-out');
    expect(busSource).toContain('vault_graphify');
    expect(busSource).toContain('vault-graphify.mjs');
    expect(busSource).toContain('vault_wikilinks');
    const graphScript = readFileSync(
      join(repoRoot, 'orgs', 'cortex', 'agents', 'boss', 'scripts', 'vault-graphify.mjs'),
      'utf-8',
    );
    expect(graphScript).toContain('WIKILINK');
    expect(graphScript).toContain('isSymbolicLink');
    expect(graphScript).toContain('cortextos-graph');
  });

  it('keeps the memory domain router available so Cortex is not the catch-all destination', () => {
    expect(busSource).toContain('vault-route-memory.mjs');
    expect(busSource).toContain('vault_route');
    const routeScript = readFileSync(
      join(repoRoot, 'orgs', 'cortex', 'agents', 'scribe', 'scripts', 'vault-route-memory.mjs'),
      'utf-8',
    );
    expect(routeScript).toContain('Pricing and Valuation');
    expect(routeScript).toContain('Business Strategy and Ideas');
    expect(routeScript).toContain('Do not dump all knowledge into Cortex');
  });

  it('keeps the canonical Lazy Obsidian Method wired as an end-to-end runner', () => {
    expect(busSource).toContain('vault-lazy-obsidian.mjs');
    expect(busSource).toContain('vault_lazy_obsidian');
    const lazyScript = readFileSync(
      join(repoRoot, 'orgs', 'cortex', 'agents', 'scribe', 'scripts', 'vault-lazy-obsidian.mjs'),
      'utf-8',
    );
    expect(lazyScript).toContain('Capture raw -> process -> link -> compound');
    expect(lazyScript).toContain('PARA - Projects, Areas, Resources, Archive');
    expect(lazyScript).toContain('Graphify - clusters, god nodes, graph.json, graph.html, GRAPH_REPORT.md');
    expect(lazyScript).toContain('QMD - markdown retrieval as the vault grows');
    expect(lazyScript).toContain("['update']");
    expect(lazyScript).toContain("['embed', '--max-docs-per-batch', '100', '--max-batch-mb', '20']");
    expect(lazyScript).toContain('QMD Vault context is configured');
  });

  it('keeps first-class Neon operational memory commands wired into cortextos bus', () => {
    expect(busSource).toContain(".command('log-episode')");
    expect(busSource).toContain(".command('log-decision')");
    expect(busSource).toContain('logEpisodeToNeon');
    expect(busSource).toContain('logDecisionToNeon');
  });

  it('keeps Telegram substantive replies gated on a current Vault lookup', () => {
    expect(busSource).toContain('last-vault-search.json');
    expect(busSource).toContain('Memory gate blocked this Telegram reply.');
    expect(busSource).toContain('--skip-memory-check');
    expect(busSource).toContain('telegram_memory_gate_blocked');
  });
});
