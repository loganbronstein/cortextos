import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ecosystemCommand } from '../../../src/cli/ecosystem';

/**
 * Build a fixture framework root with one org/agent and a context.json whose
 * timezone is `tz` (omit the field entirely when tz === undefined).
 */
function fixtureFrameworkRoot(tz: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'eco-fixture-'));
  const orgDir = join(root, 'orgs', 'cortex');
  mkdirSync(join(orgDir, 'agents', 'coder'), { recursive: true });
  writeFileSync(join(orgDir, 'agents', 'coder', 'config.json'), JSON.stringify({ name: 'coder' }), 'utf-8');
  const ctx: Record<string, unknown> = { orchestrator: 'boss' };
  if (tz !== undefined) ctx.timezone = tz;
  writeFileSync(join(orgDir, 'context.json'), JSON.stringify(ctx), 'utf-8');
  return root;
}

async function runGenerator(outPath: string): Promise<void> {
  await ecosystemCommand.parseAsync(
    ['--output', outPath, '--instance', 'test', '--org', 'cortex'],
    { from: 'user' },
  );
}

describe('cortextos ecosystem — timezone pinning', () => {
  const origFwRoot = process.env.CTX_FRAMEWORK_ROOT;
  const origTz = process.env.TZ;
  const origExit = process.exitCode;

  afterEach(() => {
    if (origFwRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT; else process.env.CTX_FRAMEWORK_ROOT = origFwRoot;
    if (origTz === undefined) delete process.env.TZ; else process.env.TZ = origTz;
    process.exitCode = origExit;
  });

  it('emits LITERAL TZ + CTX_TIMEZONE from the org zone even under ambient TZ=UTC', async () => {
    process.env.TZ = 'UTC';
    const root = fixtureFrameworkRoot('America/Chicago');
    process.env.CTX_FRAMEWORK_ROOT = root;
    const out = join(root, 'ecosystem.config.js');
    try {
      await runGenerator(out);
      const generated = readFileSync(out, 'utf-8');
      expect(generated).toContain('TZ: "America/Chicago"');
      expect(generated).toContain('CTX_TIMEZONE: "America/Chicago"');
      // Must be a literal, not process.env-derived (a poisoned shell can't win).
      expect(generated).not.toContain('process.env.TZ');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing config when the org timezone is invalid (non-destructive)', async () => {
    process.env.TZ = 'UTC';
    const root = fixtureFrameworkRoot('Mars/Nowhere');
    process.env.CTX_FRAMEWORK_ROOT = root;
    const out = join(root, 'ecosystem.config.js');
    const SENTINEL = '// SENTINEL — must not be overwritten\n';
    writeFileSync(out, SENTINEL, 'utf-8');
    process.exitCode = 0;
    try {
      await runGenerator(out);
      expect(readFileSync(out, 'utf-8')).toBe(SENTINEL); // untouched
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses (non-destructive) when the org timezone field is missing entirely', async () => {
    const root = fixtureFrameworkRoot(undefined);
    process.env.CTX_FRAMEWORK_ROOT = root;
    const out = join(root, 'ecosystem.config.js');
    const SENTINEL = '// SENTINEL 2\n';
    writeFileSync(out, SENTINEL, 'utf-8');
    process.exitCode = 0;
    try {
      await runGenerator(out);
      expect(readFileSync(out, 'utf-8')).toBe(SENTINEL);
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
