/**
 * dashboard/src/app/api/kb/search/__tests__/route.test.ts
 *
 * API route tests for GET /api/kb/search — Phase-2 hybrid contract:
 *   - rank_score is the ordering key (RRF when hybrid on, similarity otherwise)
 *   - FAIL-LOUD: when hybrid_search is enabled, a real FTS/RRF failure (non-zero mmrag
 *     exit) surfaces as a 500 error, NOT a 200 with empty results
 *   - NEUTRAL: when hybrid is off, a non-zero mmrag exit stays swallowed to 200-empty
 *     (today's behavior, unchanged)
 *
 * Mocks child_process.execFileSync, fs, and @/lib/config so no python/KB is needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const execFileSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFileSync: (...a: unknown[]) => execFileSyncMock(...a) };
});

const fsMocks = { existsSync: vi.fn(), readFileSync: vi.fn() };
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (...a: unknown[]) => fsMocks.existsSync(...a),
    readFileSync: (...a: unknown[]) => fsMocks.readFileSync(...a),
  };
});

vi.mock('@/lib/config', () => ({
  getFrameworkRoot: () => '/home/test/cortextOS',
  getCTXRoot: () => '/home/test/.cortextos/test',
}));

type RouteModule = typeof import('../route');
let route: RouteModule;

beforeEach(async () => {
  execFileSyncMock.mockReset();
  // existsSync true everywhere (venv present, configured KB).
  fsMocks.existsSync.mockReset().mockReturnValue(true);
  fsMocks.readFileSync.mockReset().mockReturnValue('');
  // GEMINI key resolved from process.env (secrets.env mock returns '').
  process.env.GEMINI_API_KEY = 'test-key';
  route = await import('../route');
});

/** readFileSync: return the given config JSON for config.json, '' for secrets.env. */
function mockConfig(content: string): void {
  fsMocks.readFileSync.mockImplementation((p: unknown) => {
    const path = String(p);
    if (path.endsWith('/knowledge-base/config.json')) return content;
    return '';
  });
}

/** Simulate a non-zero mmrag exit carrying stderr (a real FTS/RRF failure). */
function mockMmragNonZeroExit(stderr: string): void {
  execFileSyncMock.mockImplementation(() => {
    const e = new Error('Command failed') as Error & { stderr?: string; status?: number };
    e.stderr = stderr;
    e.status = 1;
    throw e;
  });
}

function callGet(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const req = new NextRequest(`http://localhost/api/kb/search?${qs}`);
  return route.GET(req);
}

describe('GET /api/kb/search — Phase-2 fail-loud (hybrid FTS errors surface)', () => {
  it('hybrid ON + non-zero mmrag exit: surfaces as a 500 error (NOT 200-empty), carries stderr', async () => {
    mockConfig('{"hybrid_search": true}');
    mockMmragNonZeroExit('sqlite3.OperationalError: no such table: chunks');

    const res = await callGet({ q: 'aleric heck', org: 'testorg', scope: 'shared' });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.hybrid).toBe(true);
    expect(body.error).toMatch(/hybrid_search query failed/);
    // The underlying mmrag stderr is propagated, not discarded.
    expect(body.error).toContain('no such table');
    // Must NOT masquerade as a successful empty result set.
    expect(body.results).toBeUndefined();
  });

  it('hybrid OFF + non-zero mmrag exit: NEUTRAL — 200 with empty results (today\'s behavior)', async () => {
    mockConfig('{"hybrid_search": false}');
    mockMmragNonZeroExit('some unrelated failure');

    const res = await callGet({ q: 'q', org: 'testorg', scope: 'shared' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('flag key ABSENT + non-zero mmrag exit: NEUTRAL (default-off swallow to 200-empty)', async () => {
    mockConfig('{"similarity_threshold": 0.5}');
    mockMmragNonZeroExit('boom');

    const res = await callGet({ q: 'q', org: 'testorg', scope: 'shared' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([]);
  });
});

describe('GET /api/kb/search — Phase-2 sidecar-missing degrade is visible', () => {
  it('hybrid ON + sidecar missing (exit 0, applied:false): surfaces hybridDegraded + warns, still returns results', async () => {
    mockConfig('{"hybrid_search": true}');
    // mmrag degraded to vector-only and reported it in the JSON (exit 0, results present).
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        hybrid: { enabled: true, applied: false, reason: 'sidecar-missing' },
        results: [{ content: 'vec', similarity: 0.8, rank_score: 0.8, source: 'v.md', type: 'markdown' }],
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await callGet({ q: 'q', org: 'testorg', scope: 'shared' });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Vector-only results still returned (degrade, not failure)...
    expect(body.results.map((r: { source_file: string }) => r.source_file)).toEqual(['v.md']);
    // ...and the degrade is surfaced as a nonfatal response field + a console warning.
    expect(body.hybridDegraded).toEqual({ reason: 'sidecar-missing' });
    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/sidecar missing/i);
    warnSpy.mockRestore();
  });

  it('hybrid applied (sidecar present): no hybridDegraded field', async () => {
    mockConfig('{"hybrid_search": true}');
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        hybrid: { enabled: true, applied: true, reason: null },
        results: [{ content: 'h', similarity: 0.7, rank_score: 0.05, source: 'h.md', type: 'markdown' }],
      }),
    );
    const res = await callGet({ q: 'q', org: 'testorg', scope: 'shared' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hybridDegraded).toBeUndefined();
  });
});

describe('GET /api/kb/search — Phase-2 ranking-key (orders by rank_score)', () => {
  it('scope=all sorts merged results by rank_score desc (NOT similarity)', async () => {
    mockConfig('{"hybrid_search": false}');
    execFileSyncMock.mockImplementation((_py: unknown, argv: unknown) => {
      const args = argv as string[];
      if (args.includes('collections')) {
        return 'Collection        Count\n-------\nshared-testorg   2\n';
      }
      // query: returned OUT of rank_score order on purpose. high similarity / low
      // rank_score must end up BELOW low similarity / high rank_score.
      return JSON.stringify({
        results: [
          { content: 'a', similarity: 0.9, rank_score: 0.01, source: 'low-rank.md', type: 'markdown' },
          { content: 'b', similarity: 0.2, rank_score: 0.05, source: 'high-rank.md', type: 'markdown' },
        ],
      });
    });

    const res = await callGet({ q: 'q', org: 'testorg', scope: 'all' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: { source_file: string }) => r.source_file)).toEqual([
      'high-rank.md',
      'low-rank.md',
    ]);
    // score field is sourced from rank_score, not similarity.
    expect(body.results[0].score).toBe(0.05);
  });
});
