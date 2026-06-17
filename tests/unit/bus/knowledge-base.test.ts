import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Path-aware fs mocks. existsSync is the one we actually drive per-test:
// it returns true for any path EXCEPT the MMRAG_CONFIG one (when the test
// wants to simulate a missing config) so loadSecretsEnv and other path
// lookups still work normally inside the module under test.
const fsMocks = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof fsMocks.existsSync>) => fsMocks.existsSync(...args),
    readFileSync: (...args: Parameters<typeof fsMocks.readFileSync>) => fsMocks.readFileSync(...args),
    mkdirSync: (...args: Parameters<typeof fsMocks.mkdirSync>) => fsMocks.mkdirSync(...args),
  };
});

// Mock execFileSync so we can assert whether it was called (and optionally
// simulate a successful python response).
const execFileSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

// Mock normalizeOrgName to a passthrough identity — we are not testing org
// normalization here, that has its own dedicated test file.
vi.mock('../../../src/utils/org.js', () => ({
  normalizeOrgName: (_root: string, org: string) => org,
}));

import type { KBQueryResult } from '../../../src/bus/knowledge-base.js';

const { queryKnowledgeBase, ingestKnowledgeBase, mergeByScore, shouldMergeCollectionsByScore } =
  await import('../../../src/bus/knowledge-base.js');

// Minimal BusPaths stub — knowledge-base.ts doesn't actually USE the paths
// object at call time, just the options/env it constructs.
const dummyPaths = {
  stateDir: '/tmp/agent/state',
  logDir: '/tmp/agent/logs',
  ctxRoot: '/tmp/agent',
  instanceId: 'test',
  agentName: 'tester',
  org: 'TestOrg',
  inboxDir: '/tmp/agent/inbox',
  inflightDir: '/tmp/agent/inflight',
  processedDir: '/tmp/agent/processed',
  outboxDir: '/tmp/agent/outbox',
} as any;

const baseOptions = {
  org: 'TestOrg',
  agent: 'tester',
  frameworkRoot: '/home/test/cortextOS',
  instanceId: 'test',
};

let warnLog: string[] = [];
let originalWarn: typeof console.warn;
let logLog: string[] = [];
let originalLog: typeof console.log;

beforeEach(() => {
  fsMocks.existsSync.mockReset();
  fsMocks.readFileSync.mockReset().mockReturnValue('');
  fsMocks.mkdirSync.mockReset();
  execFileSyncMock.mockReset();

  warnLog = [];
  logLog = [];
  originalWarn = console.warn;
  originalLog = console.log;
  console.warn = (...args: unknown[]) => {
    warnLog.push(args.map((a) => String(a)).join(' '));
  };
  console.log = (...args: unknown[]) => {
    logLog.push(args.map((a) => String(a)).join(' '));
  };
});

afterEach(() => {
  console.warn = originalWarn;
  console.log = originalLog;
});

/**
 * Helper: make existsSync return false ONLY for paths that end with
 * knowledge-base/config.json (i.e. the MMRAG_CONFIG file), true for everything
 * else. Simulates a freshly-created agent with no KB configured yet.
 */
function mockMissingKbConfig(): void {
  fsMocks.existsSync.mockImplementation((p: any) => {
    const path = String(p);
    if (path.endsWith('/knowledge-base/config.json')) return false;
    return true;
  });
}

/**
 * Helper: make existsSync return true for everything, simulating a fully
 * configured KB with config.json present on disk.
 */
function mockConfiguredKb(): void {
  fsMocks.existsSync.mockImplementation(() => true);
}

describe('ingestKnowledgeBase — graceful missing-config', () => {
  it('missing config: warn + return cleanly, execFileSync NEVER called', () => {
    mockMissingKbConfig();

    // Must NOT throw. Previously this path threw an unhandled execFileSync
    // error that dumped a Node stack trace on top of the python stderr.
    expect(() =>
      ingestKnowledgeBase(['/some/file.md'], baseOptions),
    ).not.toThrow();

    expect(execFileSyncMock).not.toHaveBeenCalled();
    // Warn must include the org name AND an actionable hint ("run setup").
    expect(warnLog.some((m) => m.includes('TestOrg') && /run setup/i.test(m))).toBe(true);
    // Warn must carry the [kb] prefix so operators can filter log lines.
    expect(warnLog.some((m) => m.includes('[kb]'))).toBe(true);
  });

  it('config present: execFileSync IS called with the mmrag ingest args', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');

    ingestKnowledgeBase(['/some/file.md'], baseOptions);

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    // First positional arg is the python path, second is the argv array.
    const [pythonPath, argv] = execFileSyncMock.mock.calls[0] as [string, string[], object];
    expect(String(pythonPath)).toMatch(/python/);
    expect(argv).toEqual(expect.arrayContaining(['ingest', '/some/file.md']));
    // Happy path emits no [kb] warning.
    expect(warnLog.filter((m) => m.includes('[kb]'))).toHaveLength(0);
  });
});

describe('queryKnowledgeBase — graceful missing-config', () => {
  it('missing config: warn + return empty KBQueryResponse, execFileSync NEVER called', () => {
    mockMissingKbConfig();

    const result = queryKnowledgeBase(dummyPaths, 'what is cortextos?', baseOptions);

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [],
      total: 0,
      query: 'what is cortextos?',
      collection: 'shared-TestOrg',
    });
    expect(warnLog.some((m) => m.includes('TestOrg') && /run setup/i.test(m))).toBe(true);
    expect(warnLog.some((m) => m.includes('[kb]'))).toBe(true);
  });

  it('config present: execFileSync IS called, happy-path query returns results', () => {
    mockConfiguredKb();
    // Mock mmrag.py --json output: a JSON blob with one result.
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        results: [
          { content: 'hit', similarity: 0.9, source: 'foo.md', type: 'markdown' },
        ],
      }),
    );

    const result = queryKnowledgeBase(dummyPaths, 'test query', baseOptions);

    expect(execFileSyncMock).toHaveBeenCalled();
    expect(result.total).toBeGreaterThan(0);
    expect(result.results[0].content).toBe('hit');
    // Happy path emits no [kb] warning.
    expect(warnLog.filter((m) => m.includes('[kb]'))).toHaveLength(0);
  });
});

describe('kb warn messages — UX invariants', () => {
  it('both warn messages name the org and suggest "run setup"', () => {
    // Drive ingest path
    mockMissingKbConfig();
    ingestKnowledgeBase(['/f.md'], { ...baseOptions, org: 'SpecificOrg' });
    // Drive query path
    mockMissingKbConfig();
    queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, org: 'SpecificOrg' });

    // At least one warn per call site, each containing the org name + hint
    const specificOrgWarns = warnLog.filter((m) => m.includes('SpecificOrg'));
    expect(specificOrgWarns.length).toBeGreaterThanOrEqual(2);
    expect(specificOrgWarns.every((m) => /run setup/i.test(m))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase-1 "Fix A": query-layer merge of shared + agent-private by similarity.
// ---------------------------------------------------------------------------

const mkResult = (source: string, score: number): KBQueryResult => ({
  content: `content:${source}`,
  source_file: source,
  org: 'TestOrg',
  score,
  doc_type: 'markdown',
});

describe('mergeByScore — pure cross-collection ranking', () => {
  it('sorts rows by score descending', () => {
    const out = mergeByScore([mkResult('a', 0.3), mkResult('b', 0.9), mkResult('c', 0.6)]);
    expect(out.map((r) => r.source_file)).toEqual(['b', 'c', 'a']);
  });

  it('preserves original (shared-first) order on ties via index decoration', () => {
    const inp = [mkResult('shared1', 0.5), mkResult('agent1', 0.5), mkResult('shared2', 0.5)];
    expect(mergeByScore(inp).map((r) => r.source_file)).toEqual(['shared1', 'agent1', 'shared2']);
  });

  it('does NOT dedup — a doc\'s duplicate chunks are preserved', () => {
    const out = mergeByScore([mkResult('dup', 0.4), mkResult('x', 0.9), mkResult('dup', 0.8)]);
    expect(out.map((r) => r.source_file)).toEqual(['x', 'dup', 'dup']);
    expect(out).toHaveLength(3);
  });

  it('does NOT change the result count and returns a new array', () => {
    const inp = [mkResult('a', 0.1), mkResult('b', 0.2)];
    const out = mergeByScore(inp);
    expect(out).toHaveLength(2);
    expect(out).not.toBe(inp);
  });

  it('handles empty input', () => {
    expect(mergeByScore([])).toEqual([]);
  });
});

describe('shouldMergeCollectionsByScore — fail-safe flag read', () => {
  const env = { MMRAG_CONFIG: '/x/knowledge-base/config.json' } as Record<string, string>;

  it('true ONLY when the key is the boolean true', () => {
    fsMocks.readFileSync.mockReturnValue('{"merge_collections_by_score": true}');
    expect(shouldMergeCollectionsByScore(env)).toBe(true);
  });

  it('false when the key is false', () => {
    fsMocks.readFileSync.mockReturnValue('{"merge_collections_by_score": false}');
    expect(shouldMergeCollectionsByScore(env)).toBe(false);
  });

  it('false when the key is absent (normal default config)', () => {
    fsMocks.readFileSync.mockReturnValue('{"similarity_threshold": 0.5}');
    expect(shouldMergeCollectionsByScore(env)).toBe(false);
  });

  it('false on a non-boolean truthy value (e.g. the string "true")', () => {
    fsMocks.readFileSync.mockReturnValue('{"merge_collections_by_score": "true"}');
    expect(shouldMergeCollectionsByScore(env)).toBe(false);
  });

  it('false on malformed JSON, never throws', () => {
    fsMocks.readFileSync.mockReturnValue('not json {');
    expect(() => shouldMergeCollectionsByScore(env)).not.toThrow();
    expect(shouldMergeCollectionsByScore(env)).toBe(false);
  });

  it('false when the file is unreadable (readFileSync throws)', () => {
    fsMocks.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(shouldMergeCollectionsByScore(env)).toBe(false);
  });
});

describe('queryKnowledgeBase — Fix A wiring (flag gates the merge)', () => {
  // existsSync true everywhere (configured KB); readFileSync returns the given
  // config JSON for the config.json path, '' for .env/secrets.env.
  function mockKbWithConfigContent(configContent: string): void {
    fsMocks.existsSync.mockImplementation(() => true);
    fsMocks.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.endsWith('/knowledge-base/config.json')) return configContent;
      return '';
    });
  }

  // Return distinct mmrag --json output per collection by inspecting argv.
  function mockCollectionResults(
    byCollection: Record<string, Array<{ source: string; similarity: number }>>,
  ): void {
    execFileSyncMock.mockImplementation((_py: unknown, argv: unknown) => {
      const args = argv as string[];
      const ci = args.indexOf('--collection');
      const col = ci >= 0 ? args[ci + 1] : '';
      const results = (byCollection[col] || []).map((r) => ({
        content: `content:${r.source}`,
        similarity: r.similarity,
        source: r.source,
        type: 'markdown',
      }));
      return JSON.stringify({ results });
    });
  }

  // shared returns lower-scored hits, agent returns the single highest-scored.
  const SHARED_AND_AGENT = {
    'shared-TestOrg': [
      { source: 'shared-a.md', similarity: 0.6 },
      { source: 'shared-b.md', similarity: 0.55 },
    ],
    'agent-tester': [{ source: 'agent-hi.md', similarity: 0.9 }],
  };

  it('flag TRUE: scope=all ranks shared+agent by score — agent hit surfaces above shared', () => {
    mockKbWithConfigContent('{"merge_collections_by_score": true}');
    mockCollectionResults(SHARED_AND_AGENT);

    const result = queryKnowledgeBase(dummyPaths, 'q', baseOptions);

    expect(result.results.map((r) => r.source_file)).toEqual(['agent-hi.md', 'shared-a.md', 'shared-b.md']);
    expect(result.total).toBe(3); // count unchanged
  });

  it('flag FALSE: scope=all keeps the shared-first concat order (today\'s behavior)', () => {
    mockKbWithConfigContent('{"merge_collections_by_score": false}');
    mockCollectionResults(SHARED_AND_AGENT);

    const result = queryKnowledgeBase(dummyPaths, 'q', baseOptions);

    expect(result.results.map((r) => r.source_file)).toEqual(['shared-a.md', 'shared-b.md', 'agent-hi.md']);
    expect(result.total).toBe(3);
  });

  it('flag key ABSENT: defaults to concat order (no merge)', () => {
    mockKbWithConfigContent('{"similarity_threshold": 0.5}');
    mockCollectionResults(SHARED_AND_AGENT);

    const result = queryKnowledgeBase(dummyPaths, 'q', baseOptions);

    expect(result.results.map((r) => r.source_file)).toEqual(['shared-a.md', 'shared-b.md', 'agent-hi.md']);
  });

  it('MALFORMED config: fail-safe to concat order, never throws', () => {
    mockKbWithConfigContent('not json {');
    mockCollectionResults(SHARED_AND_AGENT);

    let result!: ReturnType<typeof queryKnowledgeBase>;
    expect(() => {
      result = queryKnowledgeBase(dummyPaths, 'q', baseOptions);
    }).not.toThrow();
    expect(result.results.map((r) => r.source_file)).toEqual(['shared-a.md', 'shared-b.md', 'agent-hi.md']);
  });

  it('scope=shared (single collection): flag TRUE has no effect — order untouched', () => {
    mockKbWithConfigContent('{"merge_collections_by_score": true}');
    // Returned out of score order on purpose; a merge WOULD re-sort to [hi, lo].
    mockCollectionResults({
      'shared-TestOrg': [
        { source: 'lo.md', similarity: 0.5 },
        { source: 'hi.md', similarity: 0.9 },
      ],
    });

    const result = queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, scope: 'shared' });

    expect(result.results.map((r) => r.source_file)).toEqual(['lo.md', 'hi.md']);
  });
});
