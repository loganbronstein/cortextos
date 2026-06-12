/**
 * tests/unit/daemon/forcecontextrestart-intent.test.ts — BUG-011 finding 4.
 *
 * FastChecker's Tier-3 forced context restart must request an explicit FRESH
 * session via sessionRefresh('fresh') — not the preserve default.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import type { BusPaths } from '../../../src/types';

describe('BUG-011 — FastChecker.forceContextRestart calls sessionRefresh("fresh")', () => {
  let tmp: string;
  let paths: BusPaths;
  let agent: { name: string; getAgentDir: () => string; sessionRefresh: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fcr-intent-'));
    mkdirSync(join(tmp, 'state'), { recursive: true });
    mkdirSync(join(tmp, 'logs'), { recursive: true });
    paths = { ctxRoot: tmp, stateDir: join(tmp, 'state'), logDir: join(tmp, 'logs'), analyticsDir: join(tmp, 'analytics') } as unknown as BusPaths;
    agent = { name: 'alice', getAgentDir: () => join(tmp, 'agentdir'), sessionRefresh: vi.fn().mockResolvedValue(undefined) };
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('forces a clean session with intent=fresh (not the preserve default)', () => {
    const checker = new FastChecker(agent as never, paths, join(tmp, 'framework'), { log: () => {} });
    (checker as unknown as { forceContextRestart: (r: string) => void }).forceContextRestart('context-limit test');
    expect(agent.sessionRefresh).toHaveBeenCalledWith('fresh');
  });
});
