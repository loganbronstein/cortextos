import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logEpisodeToNeon, logDecisionToNeon } from '../../../src/bus/memory-log';

describe('Neon memory logging', () => {
  let root: string;
  let oldPsqlBin: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-memory-log-'));
    oldPsqlBin = process.env.PSQL_BIN;
    mkdirSync(join(root, 'orgs', 'cortex', 'agents', 'boss', '.claude'), { recursive: true });
    writeFileSync(join(root, 'orgs', 'cortex', 'secrets.env'), 'CORTEX_NEON_URL=postgres://example.invalid/db\n', 'utf-8');
    const fakePsql = join(root, 'fake-psql.sh');
    writeFileSync(fakePsql, '#!/usr/bin/env bash\nexit 0\n', 'utf-8');
    chmodSync(fakePsql, 0o700);
    process.env.PSQL_BIN = fakePsql;
  });

  afterEach(() => {
    if (oldPsqlBin === undefined) delete process.env.PSQL_BIN;
    else process.env.PSQL_BIN = oldPsqlBin;
    rmSync(root, { recursive: true, force: true });
  });

  it('logs an episode when the profile allows the type', () => {
    writeFileSync(join(root, 'orgs', 'cortex', 'agents', 'boss', '.claude', 'memory-profile.json'), JSON.stringify({
      allowed_episode_types: ['task_dispatched'],
    }), 'utf-8');

    const result = logEpisodeToNeon({ frameworkRoot: root, org: 'cortex' }, {
      agent: 'boss',
      episodeType: 'task_dispatched',
      importance: 'medium',
      summary: 'Dispatched a task',
      payload: '{"task_id":"task_1"}',
    });

    expect(result).toEqual({ ok: true, agent: 'boss', episode_type: 'task_dispatched', importance: 'medium' });
  });

  it('rejects an episode type blocked by the profile', () => {
    writeFileSync(join(root, 'orgs', 'cortex', 'agents', 'boss', '.claude', 'memory-profile.json'), JSON.stringify({
      allowed_episode_types: ['task_dispatched'],
    }), 'utf-8');

    expect(() => logEpisodeToNeon({ frameworkRoot: root, org: 'cortex' }, {
      agent: 'boss',
      episodeType: 'code_pushed',
      importance: 'medium',
      summary: 'Pushed code',
    })).toThrow(/does not allow episode type 'code_pushed'/);
  });

  it('rejects malformed decision payload JSON before calling psql', () => {
    expect(() => logDecisionToNeon({ frameworkRoot: root, org: 'cortex' }, {
      agent: 'boss',
      decisionType: 'architecture',
      importance: 'high',
      title: 'Adopt memory layer',
      rationale: 'Needed for durable recovery',
      payload: '{bad json',
    })).toThrow(/payload must be valid JSON/);
  });
});
