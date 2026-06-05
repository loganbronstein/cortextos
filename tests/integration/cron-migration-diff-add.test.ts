/**
 * tests/integration/cron-migration-diff-add.test.ts
 *
 * Regression tests for the one-shot-marker drop fix. Before the fix, once an agent's
 * `.crons-migrated` marker existed, migration returned early and never re-read
 * config.json — so a cron ADDED to config.json after the first migration (e.g. scribe's
 * rd-terminal-bridge-watch, 2026-06-04) was lost forever unless someone ran --force.
 *
 * The fix makes the already-migrated path run a convergent DIFF-ADD: add config crons
 * missing from crons.json (by name), add-only — never overwrite existing entries, never
 * delete live-added ones, and a true no-op (no rewrite) when already in sync.
 *
 * All tests use temp dirs only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition } from '../../src/types/index.js';

const CRONS_DIR = '.cortextOS/state/agents';
const CRONS_FILE = 'crons.json';
const MARKER_FILE = '.crons-migrated';

let tmpCtxRoot: string;
let tmpFrameworkRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

let migrateCronsForAgent: typeof import('../../src/daemon/cron-migration.js').migrateCronsForAgent;
let migrateAllAgents: typeof import('../../src/daemon/cron-migration.js').migrateAllAgents;
let readCrons: typeof import('../../src/bus/crons.js').readCrons;
let writeCrons: typeof import('../../src/bus/crons.js').writeCrons;

async function reloadModules() {
  vi.resetModules();
  const migModule = await import('../../src/daemon/cron-migration.js');
  migrateCronsForAgent = migModule.migrateCronsForAgent;
  migrateAllAgents = migModule.migrateAllAgents;
  const cronsModule = await import('../../src/bus/crons.js');
  readCrons = cronsModule.readCrons;
  writeCrons = cronsModule.writeCrons;
}

function writeConfigJson(agentDir: string, crons: unknown[]): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ agent_name: 'test', enabled: true, crons }),
    'utf-8',
  );
}

function cronsJsonPath(ctxRoot: string, agentName: string): string {
  return join(ctxRoot, CRONS_DIR, agentName, CRONS_FILE);
}

function markerExists(ctxRoot: string, agentName: string): boolean {
  return existsSync(join(ctxRoot, CRONS_DIR, agentName, MARKER_FILE));
}

beforeEach(async () => {
  tmpCtxRoot = mkdtempSync(join(tmpdir(), 'crons-diffadd-ctx-'));
  tmpFrameworkRoot = mkdtempSync(join(tmpdir(), 'crons-diffadd-fw-'));
  process.env.CTX_ROOT = tmpCtxRoot;
  await reloadModules();
});

afterEach(() => {
  vi.resetModules();
  if (originalCtxRoot !== undefined) process.env.CTX_ROOT = originalCtxRoot;
  else delete process.env.CTX_ROOT;
  try { rmSync(tmpCtxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(tmpFrameworkRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('cron migration — diff-add convergence (one-shot-marker drop fix)', () => {
  const agentDir = () => join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'scribe');
  const configPath = () => join(agentDir(), 'config.json');

  it('picks up a cron added to config.json AFTER the first migration, WITHOUT --force (the rd-watch scenario)', () => {
    // First migration with the original 5 crons (heartbeat + 3 dailies + one more).
    writeConfigJson(agentDir(), [
      { name: 'heartbeat', interval: '4h', prompt: 'Run heartbeat.' },
      { name: 'daily-memory-brief', cron: '35 7 * * *', prompt: 'Daily brief.' },
      { name: 'lazy-obsidian-daily-ingest', cron: '5 8 * * *', prompt: 'Ingest.' },
      { name: 'conflict-scan', cron: '10 15 * * *', prompt: 'Conflict scan.' },
    ]);
    const first = migrateCronsForAgent('scribe', configPath(), tmpCtxRoot);
    expect(first.status).toBe('migrated');
    expect(first.cronsMigrated).toBe(4);
    expect(markerExists(tmpCtxRoot, 'scribe')).toBe(true);

    // rd-terminal-bridge-watch is added to config.json LATER (the real failure).
    writeConfigJson(agentDir(), [
      { name: 'heartbeat', interval: '4h', prompt: 'Run heartbeat.' },
      { name: 'daily-memory-brief', cron: '35 7 * * *', prompt: 'Daily brief.' },
      { name: 'lazy-obsidian-daily-ingest', cron: '5 8 * * *', prompt: 'Ingest.' },
      { name: 'conflict-scan', cron: '10 15 * * *', prompt: 'Conflict scan.' },
      { name: 'rd-terminal-bridge-watch', interval: '8m', prompt: 'Run rd-bridge-watch.sh silently.' },
    ]);

    // Migration runs again on the next boot — NO --force. Pre-fix this was a no-op.
    const second = migrateCronsForAgent('scribe', configPath(), tmpCtxRoot);
    expect(second.status).toBe('migrated');
    expect(second.cronsMigrated).toBe(1);

    const crons = readCrons('scribe');
    expect(crons).toHaveLength(5);
    expect(crons.map((c) => c.name)).toContain('rd-terminal-bridge-watch');
    // No duplicates of the pre-existing crons.
    expect(new Set(crons.map((c) => c.name)).size).toBe(5);
  });

  it('is a true no-op (skipped-already-migrated, no rewrite) when crons.json is already in sync', () => {
    writeConfigJson(agentDir(), [
      { name: 'heartbeat', interval: '4h', prompt: 'Run heartbeat.' },
      { name: 'rd-terminal-bridge-watch', interval: '8m', prompt: 'Watch.' },
    ]);
    migrateCronsForAgent('scribe', configPath(), tmpCtxRoot);

    const before = require('fs').readFileSync(cronsJsonPath(tmpCtxRoot, 'scribe'), 'utf-8');
    const second = migrateCronsForAgent('scribe', configPath(), tmpCtxRoot);
    const after = require('fs').readFileSync(cronsJsonPath(tmpCtxRoot, 'scribe'), 'utf-8');

    expect(second.status).toBe('skipped-already-migrated');
    expect(second.cronsMigrated).toBeUndefined();
    // Add-only no-op must not rewrite the file (preserves updated_at / live state).
    expect(after).toBe(before);
    expect(readCrons('scribe')).toHaveLength(2);
  });

  it('is add-only: never overwrites an existing crons.json entry, never deletes a live-added one', () => {
    // First migration: just the heartbeat.
    writeConfigJson(agentDir(), [
      { name: 'heartbeat', interval: '4h', prompt: 'original prompt' },
    ]);
    migrateCronsForAgent('scribe', configPath(), tmpCtxRoot);

    // Simulate live state: a cron added directly to crons.json (not in config), and
    // a live-edited heartbeat prompt that diverges from config.
    const live = readCrons('scribe').map((c) =>
      c.name === 'heartbeat' ? { ...c, prompt: 'LIVE-EDITED prompt' } : c,
    );
    live.push({
      name: 'live-only',
      prompt: 'added live via add-cron, not in config',
      schedule: '30m',
      enabled: true,
      created_at: new Date().toISOString(),
    } as CronDefinition);
    writeCrons('scribe', live);

    // Config now edits heartbeat's prompt AND adds a new cron.
    writeConfigJson(agentDir(), [
      { name: 'heartbeat', interval: '4h', prompt: 'CONFIG-CHANGED prompt' },
      { name: 'rd-terminal-bridge-watch', interval: '8m', prompt: 'Watch.' },
    ]);
    const result = migrateCronsForAgent('scribe', configPath(), tmpCtxRoot);

    expect(result.status).toBe('migrated');
    expect(result.cronsMigrated).toBe(1); // only the new one

    const crons = readCrons('scribe');
    const byName = Object.fromEntries(crons.map((c) => [c.name, c]));
    // existing heartbeat NOT overwritten (edits don't propagate without --force)
    expect(byName['heartbeat'].prompt).toBe('LIVE-EDITED prompt');
    // live-only cron preserved (not deleted)
    expect(byName['live-only']).toBeDefined();
    // new config cron added
    expect(byName['rd-terminal-bridge-watch']).toBeDefined();
    expect(crons).toHaveLength(3);
  });

  it('self-heals: marker present but crons.json lost → re-adds all config crons', () => {
    writeConfigJson(agentDir(), [
      { name: 'heartbeat', interval: '4h', prompt: 'Run.' },
      { name: 'rd-terminal-bridge-watch', interval: '8m', prompt: 'Watch.' },
    ]);
    migrateCronsForAgent('scribe', configPath(), tmpCtxRoot);
    expect(readCrons('scribe')).toHaveLength(2);

    // crons.json is lost but the marker persists (the exact failure mode).
    unlinkSync(cronsJsonPath(tmpCtxRoot, 'scribe'));
    expect(markerExists(tmpCtxRoot, 'scribe')).toBe(true);

    const healed = migrateCronsForAgent('scribe', configPath(), tmpCtxRoot);
    expect(healed.status).toBe('migrated');
    expect(healed.cronsMigrated).toBe(2);
    expect(readCrons('scribe')).toHaveLength(2);
  });

  it('skips an invalid newly-added config cron but still adds the valid ones', () => {
    writeConfigJson(agentDir(), [
      { name: 'heartbeat', interval: '4h', prompt: 'Run.' },
    ]);
    migrateCronsForAgent('scribe', configPath(), tmpCtxRoot);

    writeConfigJson(agentDir(), [
      { name: 'heartbeat', interval: '4h', prompt: 'Run.' },
      { name: 'rd-terminal-bridge-watch', interval: '8m', prompt: 'Watch.' }, // valid
      { name: 'broken', interval: '8m' }, // no prompt → skipped
    ]);
    const result = migrateCronsForAgent('scribe', configPath(), tmpCtxRoot);

    expect(result.status).toBe('migrated');
    expect(result.cronsMigrated).toBe(1);
    expect(result.cronsSkipped).toContain('broken');

    const names = readCrons('scribe').map((c) => c.name);
    expect(names).toContain('rd-terminal-bridge-watch');
    expect(names).not.toContain('broken');
    expect(names).toHaveLength(2);
  });

  it('does not touch crons.json when already migrated and config.json is unreadable', () => {
    writeConfigJson(agentDir(), [
      { name: 'heartbeat', interval: '4h', prompt: 'Run.' },
    ]);
    migrateCronsForAgent('scribe', configPath(), tmpCtxRoot);
    const before = require('fs').readFileSync(cronsJsonPath(tmpCtxRoot, 'scribe'), 'utf-8');

    // Corrupt the config.json.
    writeFileSync(configPath(), '{ this is not valid json', 'utf-8');
    const result = migrateCronsForAgent('scribe', configPath(), tmpCtxRoot);

    expect(result.status).toBe('skipped-already-migrated');
    const after = require('fs').readFileSync(cronsJsonPath(tmpCtxRoot, 'scribe'), 'utf-8');
    expect(after).toBe(before); // crons.json untouched
    expect(readCrons('scribe')).toHaveLength(1);
  });

  it('surfaces a REAL addCron failure instead of masking it as a benign collision', async () => {
    // First migration (real modules) sets the marker + crons.json = [heartbeat].
    writeConfigJson(agentDir(), [{ name: 'heartbeat', interval: '4h', prompt: 'Run.' }]);
    migrateCronsForAgent('scribe', configPath(), tmpCtxRoot);

    // A new cron is added to config — but addCron will fail for a NON-collision reason
    // (simulating lock/FS/ENOSPC). readCrons stays real, so the re-verify sees the cron
    // still ABSENT and the failure must be surfaced (thrown), not swallowed.
    writeConfigJson(agentDir(), [
      { name: 'heartbeat', interval: '4h', prompt: 'Run.' },
      { name: 'rd-terminal-bridge-watch', interval: '8m', prompt: 'Watch.' },
    ]);

    vi.resetModules();
    vi.doMock('../../src/bus/crons.js', async (importOriginal) => {
      const actual = await (importOriginal as () => Promise<typeof import('../../src/bus/crons.js')>)();
      return { ...actual, addCron: () => { throw new Error('ENOSPC: no space left on device'); } };
    });
    const { migrateCronsForAgent: migMocked } = await import('../../src/daemon/cron-migration.js');

    expect(() => migMocked('scribe', configPath(), tmpCtxRoot, { log: () => {} }))
      .toThrow(/still missing|ENOSPC/i);

    vi.doUnmock('../../src/bus/crons.js');
  });

  it('migrateAllAgents reports a real addCron failure as status "failed", NOT "no-config"', async () => {
    // First migration (real) sets the marker + crons.json = [heartbeat].
    writeConfigJson(agentDir(), [{ name: 'heartbeat', interval: '4h', prompt: 'Run.' }]);
    migrateCronsForAgent('scribe', configPath(), tmpCtxRoot);

    // Add a new cron, then make addCron fail for a non-collision reason.
    writeConfigJson(agentDir(), [
      { name: 'heartbeat', interval: '4h', prompt: 'Run.' },
      { name: 'rd-terminal-bridge-watch', interval: '8m', prompt: 'Watch.' },
    ]);

    vi.resetModules();
    vi.doMock('../../src/bus/crons.js', async (importOriginal) => {
      const actual = await (importOriginal as () => Promise<typeof import('../../src/bus/crons.js')>)();
      return { ...actual, addCron: () => { throw new Error('ENOSPC: no space left on device'); } };
    });
    const { migrateAllAgents: migAll } = await import('../../src/daemon/cron-migration.js');

    const summary = migAll(tmpFrameworkRoot, tmpCtxRoot, { log: () => {} });
    const scribe = summary.results.find((r) => r.agentName === 'scribe');
    expect(scribe?.status).toBe('failed');          // must NOT be masked as 'no-config'
    expect(scribe?.status).not.toBe('no-config');
    expect(scribe?.error).toMatch(/still missing|ENOSPC/i);

    vi.doUnmock('../../src/bus/crons.js');
  });

  it('surfaces invalid new config crons even when nothing valid is added (not a silent in-sync)', () => {
    writeConfigJson(agentDir(), [{ name: 'heartbeat', interval: '4h', prompt: 'Run.' }]);
    migrateCronsForAgent('scribe', configPath(), tmpCtxRoot);

    // Add ONLY an invalid cron (no prompt) — toAdd is empty, but it must be reported.
    writeConfigJson(agentDir(), [
      { name: 'heartbeat', interval: '4h', prompt: 'Run.' },
      { name: 'broken', interval: '8m' }, // no prompt → unconvertible
    ]);
    const result = migrateCronsForAgent('scribe', configPath(), tmpCtxRoot);

    expect(result.status).toBe('skipped-already-migrated');
    expect(result.cronsSkipped).toContain('broken'); // surfaced, not hidden as "in sync"
    expect(readCrons('scribe')).toHaveLength(1);
  });
});
