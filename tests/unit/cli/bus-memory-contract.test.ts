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
    expect(busSource).toContain(".command('graphify')");
    expect(busSource).toContain(".command('promote')");
    expect(busSource).toContain('resolveInside');
    expect(busSource).toContain('vault_promote');
  });

  it('keeps the Obsidian wikilink graph pass available for Markdown vaults', () => {
    expect(busSource).toContain('vault-graphify.mjs');
    expect(busSource).toContain('vault_graphify');
    const graphScript = readFileSync(
      join(repoRoot, 'orgs', 'cortex', 'agents', 'boss', 'scripts', 'vault-graphify.mjs'),
      'utf-8',
    );
    expect(graphScript).toContain('WIKILINK');
    expect(graphScript).toContain('isSymbolicLink');
    expect(graphScript).toContain('cortextos-graph');
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
