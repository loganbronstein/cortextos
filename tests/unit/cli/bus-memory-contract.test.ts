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

