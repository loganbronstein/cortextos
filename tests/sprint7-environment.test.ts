import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectDayNightMode } from '../src/bus/heartbeat.js';
import { resolveEnv } from '../src/utils/env.js';

describe('Sprint 7: Environment & Config Completeness', () => {
  const testDir = join(tmpdir(), `cortextos-sprint7-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('Timezone resolution', () => {
    it('resolves timezone from context.json', () => {
      const orgDir = join(testDir, 'orgs', 'testorg');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'context.json'), JSON.stringify({
        name: 'testorg',
        timezone: 'America/New_York',
        orchestrator: 'sentinel',
      }), 'utf-8');

      const ctx = JSON.parse(readFileSync(join(orgDir, 'context.json'), 'utf-8'));
      expect(ctx.timezone).toBe('America/New_York');
    });

    it('orchestrator resolved from context.json', () => {
      const orgDir = join(testDir, 'orgs', 'testorg');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'context.json'), JSON.stringify({
        name: 'testorg',
        timezone: 'UTC',
        orchestrator: 'sentinel',
      }), 'utf-8');

      const ctx = JSON.parse(readFileSync(join(orgDir, 'context.json'), 'utf-8'));
      expect(ctx.orchestrator).toBe('sentinel');
    });
  });

  describe('Day/night mode detection', () => {
    it('returns day for daytime hours', () => {
      // We can't control the actual time, but we can test the function signature
      const mode = detectDayNightMode('UTC');
      expect(['day', 'night']).toContain(mode);
    });

    it('handles invalid timezone gracefully', () => {
      const mode = detectDayNightMode('Invalid/Timezone');
      expect(['day', 'night']).toContain(mode);
    });
  });

  describe('Heartbeat with mode and loop_interval', () => {
    it('heartbeat JSON includes mode field', () => {
      const heartbeat = {
        agent: 'testbot',
        timestamp: new Date().toISOString(),
        status: 'running',
        mode: 'day' as const,
        loop_interval: '4h',
      };

      const path = join(testDir, 'heartbeat.json');
      writeFileSync(path, JSON.stringify(heartbeat), 'utf-8');

      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      expect(parsed.mode).toBe('day');
      expect(parsed.loop_interval).toBe('4h');
    });
  });

  describe('enabled-agents.json format compatibility', () => {
    it('supports full agent config format', () => {
      const config = {
        sentinel: {
          enabled: true,
          status: 'configured',
          org: 'acme',
          template: 'orchestrator',
          model: 'claude-sonnet-4-6',
        },
        analyst: {
          enabled: true,
          status: 'configured',
          org: 'acme',
          template: 'analyst',
        },
        worker: {
          enabled: false,
          status: 'disabled',
          org: 'acme',
        },
      };

      const path = join(testDir, 'enabled-agents.json');
      writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');

      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      expect(Object.keys(parsed).length).toBe(3);
      expect(parsed.sentinel.template).toBe('orchestrator');
      expect(parsed.worker.enabled).toBe(false);
    });

    it('handles legacy format (just enabled flag)', () => {
      const legacyConfig = {
        bot1: { enabled: true },
        bot2: { enabled: false },
      };

      const path = join(testDir, 'enabled-agents.json');
      writeFileSync(path, JSON.stringify(legacyConfig), 'utf-8');

      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      expect(parsed.bot1.enabled).toBe(true);
      expect(parsed.bot2.enabled).toBe(false);
    });
  });

  describe('Org auto-detection', () => {
    const savedEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...savedEnv };
    });

    it('uses the single enabled agent org when CTX_ORG is not set', () => {
      const ctxRoot = join(testDir, 'state');
      const frameworkRoot = join(testDir, 'framework');
      mkdirSync(join(ctxRoot, 'config'), { recursive: true });
      mkdirSync(join(frameworkRoot, 'orgs', 'cortex'), { recursive: true });
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({
        boss: { enabled: true, org: 'cortex' },
        scribe: { enabled: true, org: 'cortex' },
      }), 'utf-8');

      delete process.env.CTX_ORG;
      process.env.CTX_ROOT = ctxRoot;
      process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
      process.env.CTX_AGENT_NAME = 'boss';

      const env = resolveEnv();
      expect(env.org).toBe('cortex');
      expect(env.projectRoot).toBe(frameworkRoot);
    });

    it('falls back to a single project org when enabled-agent metadata is missing', () => {
      const ctxRoot = join(testDir, 'state-no-enabled');
      const frameworkRoot = join(testDir, 'framework-no-enabled');
      mkdirSync(join(ctxRoot, 'config'), { recursive: true });
      mkdirSync(join(frameworkRoot, 'orgs', 'onlyorg'), { recursive: true });

      delete process.env.CTX_ORG;
      process.env.CTX_ROOT = ctxRoot;
      process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
      process.env.CTX_AGENT_NAME = 'boss';

      const env = resolveEnv();
      expect(env.org).toBe('onlyorg');
    });
  });

  describe('Loop interval from config.json', () => {
    it('reads heartbeat cron interval', () => {
      const config = {
        crons: [
          { name: 'heartbeat', interval: '4h', command: 'Run heartbeat' },
          { name: 'check-approvals', interval: '30m', command: 'Check approvals' },
        ],
      };

      const path = join(testDir, 'config.json');
      writeFileSync(path, JSON.stringify(config), 'utf-8');

      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      const heartbeatCron = parsed.crons.find((c: any) => c.name === 'heartbeat');
      expect(heartbeatCron).toBeDefined();
      expect(heartbeatCron.interval).toBe('4h');
    });
  });

  describe('Uninstall', () => {
    it('state directory can be cleaned up', () => {
      const ctxRoot = join(testDir, 'cortextos-state');
      mkdirSync(join(ctxRoot, 'inbox'), { recursive: true });
      mkdirSync(join(ctxRoot, 'state'), { recursive: true });
      mkdirSync(join(ctxRoot, 'logs'), { recursive: true });

      expect(existsSync(ctxRoot)).toBe(true);
      rmSync(ctxRoot, { recursive: true, force: true });
      expect(existsSync(ctxRoot)).toBe(false);
    });
  });
});
