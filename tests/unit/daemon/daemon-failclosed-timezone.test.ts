import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Daemon } from '../../../src/daemon/index';

/**
 * Proves the daemon FAILS CLOSED: when the org timezone cannot be resolved,
 * start() throws before any AgentManager / IPC server / cron scheduler is
 * constructed, so the daemon never silently schedules fixed-hour crons in the
 * wrong (inherited) timezone.
 */
function fixtureFramework(tz: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'daemon-fc-'));
  const orgDir = join(root, 'orgs', 'cortex');
  mkdirSync(join(orgDir, 'agents', 'coder'), { recursive: true });
  const ctx: Record<string, unknown> = { orchestrator: 'boss' };
  if (tz !== null) ctx.timezone = tz;
  writeFileSync(join(orgDir, 'context.json'), JSON.stringify(ctx), 'utf-8');
  return root;
}

describe('daemon start() — fail-closed on unresolvable org timezone', () => {
  const saved = {
    fw: process.env.CTX_FRAMEWORK_ROOT,
    org: process.env.CTX_ORG,
    inst: process.env.CTX_INSTANCE_ID,
    tz: process.env.TZ,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries({
      CTX_FRAMEWORK_ROOT: saved.fw, CTX_ORG: saved.org, CTX_INSTANCE_ID: saved.inst, TZ: saved.tz,
    })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  async function expectFailClosed(root: string): Promise<void> {
    process.env.CTX_FRAMEWORK_ROOT = root;
    process.env.CTX_ORG = 'cortex';
    process.env.CTX_INSTANCE_ID = 'failclosed-test';
    process.env.TZ = 'UTC';
    const d = new Daemon();
    await expect(d.start()).rejects.toThrow(/timezone/i);
    // The construction guard: nothing past the tz check ran.
    expect((d as unknown as { agentManager: unknown }).agentManager).toBeNull();
    expect((d as unknown as { ipcServer: unknown }).ipcServer).toBeNull();
  }

  it('throws and never constructs AgentManager/IPC when timezone is INVALID', async () => {
    const root = fixtureFramework('Mars/Nowhere');
    try {
      await expectFailClosed(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws and never constructs AgentManager/IPC when timezone is MISSING', async () => {
    const root = fixtureFramework(null);
    try {
      await expectFailClosed(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
