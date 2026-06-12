/**
 * tests/unit/cli/fix-agent-settings.test.ts
 *
 * Regression tests for `cortextos bus fix-agent-settings`.
 *
 * Root cause being fixed: the command previously wrote
 *   settings.permissions.allow = [...current, ...missing]
 * which PRESERVED an invalid bare "*" wildcard already present in `current`
 * (["*"] -> ["*", <14 required>]). The bare "*" is not a valid Claude Code
 * permission rule and raises a "Settings Warning" dialog that can wedge a
 * headless agent restart. The fix filters ONLY the bare "*" from `current`,
 * preserves every other (incl. unknown) rule, adds missing required tools, and
 * reports the removal in both dry-run and live output.
 *
 * Harness: `busCommand` is a module-level singleton, so we drive it via
 * parseAsync against a per-test fixture framework root pointed at by
 * CTX_FRAMEWORK_ROOT (mirrors bus-crons.test.ts / ecosystem-timezone.test.ts).
 * The single --dry-run test runs LAST so commander's option state cannot leak
 * a stale dryRun=true into a live mutation test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { busCommand } from '../../../src/cli/bus';

const REQUIRED_ALLOW = [
  'Bash', 'Read', 'Edit', 'Write',
  'Glob', 'Grep',
  'WebFetch', 'WebSearch',
  'ToolSearch', 'CronCreate', 'CronList', 'CronDelete',
  'Skill', 'Agent',
];

const STATUS_LINE = {
  type: 'command',
  command: 'cortextos bus hook-context-status',
  refreshInterval: 5,
  timeout: 2,
};

/** Build a fixture framework root with one org/agent and the given settings.json. */
function fixture(settings: Record<string, unknown>): { root: string; settingsPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'fix-allow-'));
  const claudeDir = join(root, 'orgs', 'cortex', 'agents', 'coder', '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return { root, settingsPath };
}

function readAllow(settingsPath: string): string[] {
  return JSON.parse(readFileSync(settingsPath, 'utf-8')).permissions.allow;
}

describe('cortextos bus fix-agent-settings — invalid bare "*" removal', () => {
  const origFwRoot = process.env.CTX_FRAMEWORK_ROOT;
  const origAgentDir = process.env.CTX_AGENT_DIR;
  const origProjectRoot = process.env.CTX_PROJECT_ROOT;
  const origExit = process.exitCode;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const created: string[] = [];

  function run(args: string[] = []): Promise<void> {
    return busCommand.parseAsync(['node', 'bus', 'fix-agent-settings', ...args]);
  }
  function output(): string {
    return logSpy.mock.calls.map(c => c.join(' ')).join('\n');
  }

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // This suite runs inside a live agent shell whose CTX_AGENT_DIR / CTX_PROJECT_ROOT
    // point at the real install. resolveEnv (issue #313 guard) throws if those diverge
    // from an overridden CTX_FRAMEWORK_ROOT. Clear them so the fixture root is honored.
    delete process.env.CTX_AGENT_DIR;
    delete process.env.CTX_PROJECT_ROOT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origFwRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = origFwRoot;
    if (origAgentDir === undefined) delete process.env.CTX_AGENT_DIR;
    else process.env.CTX_AGENT_DIR = origAgentDir;
    if (origProjectRoot === undefined) delete process.env.CTX_PROJECT_ROOT;
    else process.env.CTX_PROJECT_ROOT = origProjectRoot;
    process.exitCode = origExit;
    for (const r of created.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it('case 1: wildcard + missing rules -> removes "*", adds the missing 14, reports both', async () => {
    const { root, settingsPath } = fixture({
      permissions: { allow: ['*'], defaultMode: 'bypassPermissions' },
      statusLine: STATUS_LINE,
    });
    created.push(root);
    process.env.CTX_FRAMEWORK_ROOT = root;

    await run();

    const allow = readAllow(settingsPath);
    expect(allow).not.toContain('*');
    expect(allow).toEqual(REQUIRED_ALLOW);
    expect(output()).toContain('-["*"]');
    expect(output()).toContain('allow: +[');
  });

  it('case 2: wildcard + all 14 required already present -> removes "*", no additions, NOT "up to date"', async () => {
    const { root, settingsPath } = fixture({
      permissions: { allow: ['*', ...REQUIRED_ALLOW], defaultMode: 'bypassPermissions' },
      statusLine: STATUS_LINE,
    });
    created.push(root);
    process.env.CTX_FRAMEWORK_ROOT = root;

    await run();

    const allow = readAllow(settingsPath);
    expect(allow).not.toContain('*');
    expect(allow).toEqual(REQUIRED_ALLOW);
    expect(output()).toContain('-["*"]');
    expect(output()).toContain('FIX'); // applied (wildcard removed), NOT skipped as up-to-date
  });

  it('case 3: no wildcard, all required present -> idempotent "already up to date", file unchanged', async () => {
    const { root, settingsPath } = fixture({
      permissions: { allow: [...REQUIRED_ALLOW], defaultMode: 'bypassPermissions' },
      statusLine: STATUS_LINE,
    });
    created.push(root);
    process.env.CTX_FRAMEWORK_ROOT = root;
    const before = readFileSync(settingsPath, 'utf-8');

    await run();

    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
    expect(readAllow(settingsPath)).toEqual(REQUIRED_ALLOW);
    expect(output()).toContain('already up to date');
  });

  it('case 4: non-allow settings (hooks, effortLevel, mcp servers) preserved through the fix', async () => {
    const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'cortextos bus hook-idle-flag', timeout: 5 }] }] };
    const { root, settingsPath } = fixture({
      effortLevel: 'xhigh',
      permissions: { allow: ['*'], defaultMode: 'bypassPermissions' },
      statusLine: STATUS_LINE,
      hooks,
      enabledMcpjsonServers: ['meta-ads'],
    });
    created.push(root);
    process.env.CTX_FRAMEWORK_ROOT = root;

    await run();

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.permissions.allow).toEqual(REQUIRED_ALLOW);
    expect(after.permissions.allow).not.toContain('*');
    expect(after.effortLevel).toBe('xhigh');
    expect(after.permissions.defaultMode).toBe('bypassPermissions');
    expect(after.hooks).toEqual(hooks);
    expect(after.enabledMcpjsonServers).toEqual(['meta-ads']);
  });

  it('case 5: unknown / non-required rules preserved alongside "*" removal and required additions', async () => {
    const { root, settingsPath } = fixture({
      permissions: { allow: ['*', 'Bash', 'CustomTool', 'mcp__foo__bar'], defaultMode: 'bypassPermissions' },
      statusLine: STATUS_LINE,
    });
    created.push(root);
    process.env.CTX_FRAMEWORK_ROOT = root;

    await run();

    const allow = readAllow(settingsPath);
    expect(allow).not.toContain('*');
    // unknown rules survive
    expect(allow).toContain('CustomTool');
    expect(allow).toContain('mcp__foo__bar');
    // all required tools end up present
    for (const t of REQUIRED_ALLOW) expect(allow).toContain(t);
    // the pre-existing valid rule keeps its leading position (cleaned-first ordering)
    expect(allow.slice(0, 3)).toEqual(['Bash', 'CustomTool', 'mcp__foo__bar']);
  });

  it('case 6: wildcard + all required + a CUSTOM statusLine -> "*" removed, custom statusLine preserved, no statusLine-add claim', async () => {
    const customStatusLine = { type: 'command', command: 'my-custom-statusline --foo', refreshInterval: 99, timeout: 7 };
    const { root, settingsPath } = fixture({
      permissions: { allow: ['*', ...REQUIRED_ALLOW], defaultMode: 'bypassPermissions' },
      statusLine: customStatusLine,
    });
    created.push(root);
    process.env.CTX_FRAMEWORK_ROOT = root;

    await run();

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.permissions.allow).toEqual(REQUIRED_ALLOW); // "*" removed, only the 14
    expect(after.permissions.allow).not.toContain('*');
    expect(after.statusLine).toEqual(customStatusLine);      // existing custom statusLine NOT overwritten
    expect(output()).toContain('-["*"]');                    // removal still reported
    expect(output()).not.toContain('statusLine');            // and it did NOT claim a statusLine addition
  });

  // MUST stay last: exercises --dry-run; placing it last prevents commander's
  // option state from leaking dryRun=true into the live mutation tests above.
  it('case 7 (dry-run): reports the "*" removal but does NOT modify the file', async () => {
    const { root, settingsPath } = fixture({
      permissions: { allow: ['*'], defaultMode: 'bypassPermissions' },
      statusLine: STATUS_LINE,
    });
    created.push(root);
    process.env.CTX_FRAMEWORK_ROOT = root;
    const before = readFileSync(settingsPath, 'utf-8');

    await run(['--dry-run']);

    expect(readFileSync(settingsPath, 'utf-8')).toBe(before); // untouched
    expect(readAllow(settingsPath)).toEqual(['*']);           // still the original
    expect(output()).toContain('DRY');
    expect(output()).toContain('-["*"]');
  });
});
