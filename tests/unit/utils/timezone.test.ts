import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isValidTimezone, resolveOrgTimezone, applyDaemonTimezone, findAgentOrgs } from '../../../src/utils/timezone';
import { nextFireFromCron } from '../../../src/daemon/cron-scheduler';
import { parseDurationMs } from '../../../src/bus/cron-state';

function fixtureRoot(tzValueRaw: string | null, opts: { withField?: boolean; bom?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'tz-fixture-'));
  const orgDir = join(root, 'orgs', 'cortex');
  mkdirSync(join(orgDir, 'agents', 'coder'), { recursive: true });
  // tzValueRaw === null + withField:false => no context.json at all
  if (tzValueRaw !== null || opts.withField === false) {
    const body =
      opts.withField === false
        ? JSON.stringify({ orchestrator: 'boss' })
        : JSON.stringify({ timezone: tzValueRaw, orchestrator: 'boss' });
    const prefix = opts.bom ? '﻿' : '';
    writeFileSync(join(orgDir, 'context.json'), prefix + body, 'utf-8');
  }
  return root;
}

describe('timezone utils', () => {
  const origTz = process.env.TZ;
  const origCtxTz = process.env.CTX_TIMEZONE;

  afterEach(() => {
    // Restore env after any applyDaemonTimezone mutation so tests stay isolated.
    if (origTz === undefined) delete process.env.TZ; else process.env.TZ = origTz;
    if (origCtxTz === undefined) delete process.env.CTX_TIMEZONE; else process.env.CTX_TIMEZONE = origCtxTz;
  });

  describe('isValidTimezone', () => {
    it('accepts valid IANA zones', () => {
      expect(isValidTimezone('America/Chicago')).toBe(true);
      expect(isValidTimezone('UTC')).toBe(true);
      expect(isValidTimezone('Europe/London')).toBe(true);
    });
    it('rejects invalid / non-string values', () => {
      expect(isValidTimezone('Mars/Nowhere')).toBe(false);
      expect(isValidTimezone('')).toBe(false);
      expect(isValidTimezone(123 as unknown)).toBe(false);
      expect(isValidTimezone(undefined as unknown)).toBe(false);
    });
  });

  describe('resolveOrgTimezone', () => {
    it('reads + validates the org timezone regardless of ambient process TZ', () => {
      process.env.TZ = 'UTC';
      const root = fixtureRoot('America/Chicago');
      try {
        expect(resolveOrgTimezone(root, 'cortex')).toBe('America/Chicago');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    it('strips a leading BOM before parsing', () => {
      const root = fixtureRoot('America/Chicago', { bom: true });
      try {
        expect(resolveOrgTimezone(root, 'cortex')).toBe('America/Chicago');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    it('returns null when context.json is missing', () => {
      const root = mkdtempSync(join(tmpdir(), 'tz-empty-'));
      try {
        expect(resolveOrgTimezone(root, 'cortex')).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    it('returns null when the timezone field is absent', () => {
      const root = fixtureRoot(null, { withField: false });
      try {
        expect(resolveOrgTimezone(root, 'cortex')).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    it('returns null for an invalid timezone value', () => {
      const root = fixtureRoot('Mars/Nowhere');
      try {
        expect(resolveOrgTimezone(root, 'cortex')).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('applyDaemonTimezone (overrides a poisoned TZ before cron next-fire)', () => {
    it('sets process.env.TZ + CTX_TIMEZONE from the org zone, overriding inherited UTC', () => {
      process.env.TZ = 'UTC';
      process.env.CTX_TIMEZONE = 'UTC';
      const root = fixtureRoot('America/Chicago');
      const logs: string[] = [];
      try {
        const resolved = applyDaemonTimezone(root, 'cortex', (m) => logs.push(m));
        expect(resolved).toBe('America/Chicago');
        expect(process.env.TZ).toBe('America/Chicago');
        expect(process.env.CTX_TIMEZONE).toBe('America/Chicago');
        expect(logs.join('\n')).toContain('America/Chicago');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('FAILS CLOSED (throws, leaves TZ unmutated) when the org timezone is unresolvable', () => {
      process.env.TZ = 'UTC';
      const root = fixtureRoot('Mars/Nowhere');
      try {
        expect(() => applyDaemonTimezone(root, 'cortex', () => {})).toThrow(/timezone/i);
        // Must NOT have mutated the process timezone on the failure path.
        expect(process.env.TZ).toBe('UTC');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('error names the org context.json path + timezone requirement', () => {
      const root = fixtureRoot(null, { withField: false });
      try {
        expect(() => applyDaemonTimezone(root, 'cortex', () => {})).toThrow(/context\.json/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('changes fixed-hour cron next-fire to the org zone while leaving interval math unchanged', () => {
      // Reference: 2026-06-12T12:00:00Z = 07:00 America/Chicago (CDT, UTC-5).
      const ref = Date.UTC(2026, 5, 12, 12, 0, 0);

      // Under ambient UTC, "0 22 * * *" fires at 22:00 UTC.
      process.env.TZ = 'UTC';
      const underUtc = nextFireFromCron('0 22 * * *', ref);
      expect(new Date(underUtc).toISOString()).toBe('2026-06-12T22:00:00.000Z');

      // After the daemon bootstrap pins America/Chicago, the SAME expression
      // fires at 22:00 CDT = 03:00Z the next day.
      const root = fixtureRoot('America/Chicago');
      try {
        applyDaemonTimezone(root, 'cortex', () => {});
        const underChicago = nextFireFromCron('0 22 * * *', ref);
        expect(new Date(underChicago).toISOString()).toBe('2026-06-13T03:00:00.000Z');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }

      // Interval schedules are pure duration math — TZ-independent, unchanged.
      expect(parseDurationMs('6h')).toBe(6 * 60 * 60 * 1000);
      expect(parseDurationMs('30m')).toBe(30 * 60 * 1000);
    });
  });

  describe('findAgentOrgs (target-org resolution, ambiguity-rejecting)', () => {
    function orgsRoot(spec: Record<string, string[]>): string {
      // spec: { orgName: [agentNames...] }
      const root = mkdtempSync(join(tmpdir(), 'orgs-fixture-'));
      for (const [org, agents] of Object.entries(spec)) {
        for (const a of agents) {
          mkdirSync(join(root, 'orgs', org, 'agents', a), { recursive: true });
        }
      }
      return root;
    }

    it('returns the single org containing the agent', () => {
      const root = orgsRoot({ cortex: ['coder', 'boss'], other: ['someone'] });
      try {
        expect(findAgentOrgs(root, 'coder')).toEqual(['cortex']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('returns [] for an unknown agent', () => {
      const root = orgsRoot({ cortex: ['coder'] });
      try {
        expect(findAgentOrgs(root, 'ghost')).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('returns ALL orgs for a duplicate agent name (caller must reject ambiguity)', () => {
      const root = orgsRoot({ orgA: ['dup'], orgB: ['dup'] });
      try {
        expect(findAgentOrgs(root, 'dup').sort()).toEqual(['orgA', 'orgB']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
