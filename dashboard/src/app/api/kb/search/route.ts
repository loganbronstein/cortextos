import { NextRequest } from 'next/server';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { getCTXRoot, getFrameworkRoot } from '@/lib/config';


export const dynamic = 'force-dynamic';

/**
 * Thrown when `hybrid_search` is enabled and the underlying mmrag query exits non-zero
 * (a real FTS/RRF failure). Phase-2 fail-loud: such an error must surface as an error
 * HTTP response, never be masked as a 200 with empty results that looks like "no matches".
 */
class KBHybridError extends Error {}

/**
 * GET /api/kb/search?q=<question>&org=<org>&agent=<agent>&scope=<scope>&limit=<n>&threshold=<f>
 *
 * Searches the cortextOS knowledge base via kb-query.sh → mmrag.py → ChromaDB.
 *
 * Response:
 * {
 *   results: Array<{
 *     content: string,
 *     source_file: string,
 *     agent_name?: string,
 *     org: string,
 *     score: number,
 *     doc_type: string
 *   }>,
 *   total: number,
 *   query: string,
 *   collection: string
 * }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const org = searchParams.get('org') ?? '';
  const agent = searchParams.get('agent') ?? '';
  const q = searchParams.get('q') ?? '';

  // Security (H12): Validate org/agent against allowlist before shell use.
  if (org && !/^[a-z0-9_-]+$/.test(org)) {
    return Response.json({ error: 'Invalid org' }, { status: 400 });
  }
  if (agent && !/^[a-z0-9_-]+$/.test(agent)) {
    return Response.json({ error: 'Invalid agent' }, { status: 400 });
  }
  if (q.length > 500) {
    return Response.json({ error: 'Query too long' }, { status: 400 });
  }

  const scope = searchParams.get('scope') || 'all';
  const limit = parseInt(searchParams.get('limit') || '10', 10);
  const threshold = parseFloat(searchParams.get('threshold') || '0.5');

  if (!q || q.trim().length === 0) {
    return Response.json({ error: 'q parameter required' }, { status: 400 });
  }

  if (!['shared', 'private', 'all'].includes(scope)) {
    return Response.json({ error: 'scope must be shared, private, or all' }, { status: 400 });
  }

  if (isNaN(limit) || limit < 1 || limit > 50) {
    return Response.json({ error: 'limit must be 1-50' }, { status: 400 });
  }

  if (isNaN(threshold) || threshold < 0 || threshold > 1) {
    return Response.json({ error: 'threshold must be 0.0-1.0' }, { status: 400 });
  }

  const frameworkRoot = getFrameworkRoot();
  const ctxRoot = getCTXRoot();

  // Derive instance ID from CTX_ROOT (e.g. ~/.cortextos/e2e-phase → "e2e-phase")
  const instanceId = path.basename(ctxRoot);

  const kbRoot = path.join(os.homedir(), '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const chromaDir = path.join(kbRoot, 'chromadb');
  const configPath = path.join(kbRoot, 'config.json');
  const isWin = process.platform === 'win32';
  const venvBin = isWin ? 'Scripts' : 'bin';
  const pythonExe = isWin ? 'python.exe' : 'python3';
  const pythonPath = path.join(frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);
  const mmragPath = path.join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  // Determine collection(s) from scope (matching kb-query.sh logic)
  let collection = '';
  if (scope === 'private') {
    collection = `agent-${agent}`;
  } else if (scope === 'shared') {
    collection = `shared-${org}`;
  }
  // scope === 'all' → collection stays empty, we query both below

  // Load org secrets for GEMINI_API_KEY
  const secretsPath = org
    ? path.join(frameworkRoot, 'orgs', org, 'secrets.env')
    : null;

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_INSTANCE_ID: instanceId,
    PATH: process.env.PATH ?? '',
    MMRAG_DIR: kbRoot,
    MMRAG_CHROMADB_DIR: chromaDir,
    MMRAG_CONFIG: configPath,
  };

  if (org) env.CTX_ORG = org;
  if (agent) env.CTX_AGENT_NAME = agent;

  // Load GEMINI_API_KEY from secrets if available
  if (secretsPath) {
    try {
      const secrets = readFileSync(secretsPath, 'utf-8');
      const match = secrets.match(/^GEMINI_API_KEY=(.+)$/m);
      if (match) env.GEMINI_API_KEY = match[1].trim();
    } catch {
      // No secrets file — GEMINI_API_KEY may be in process.env already
    }
  }
  if (!env.GEMINI_API_KEY && process.env.GEMINI_API_KEY) {
    env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  }

  if (!env.GEMINI_API_KEY) {
    return Response.json(
      { error: 'GEMINI_API_KEY not configured. Add it to orgs/{org}/secrets.env' },
      { status: 503 }
    );
  }

  // Pre-flight: check venv exists
  if (!existsSync(path.join(frameworkRoot, 'knowledge-base', 'venv'))) {
    return Response.json({ results: [], total: 0, query: q, collection: `shared-${org}` });
  }

  // Phase-2: read the hybrid_search flag the same way mmrag does, so fail-loud is scoped
  // to hybrid-enabled queries only. Default-off / missing / unreadable config => false (neutral).
  let hybridEnabled = false;
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as { hybrid_search?: unknown };
    hybridEnabled = cfg.hybrid_search === true;
  } catch {
    hybridEnabled = false;
  }

  // Phase-2: a missing FTS sidecar is a non-fatal degrade (mmrag falls back to vector-only,
  // exit 0, and reports it in the JSON `hybrid` block). Surface it so an operator who enabled
  // hybrid_search without building the sidecar isn't silently running vector-only. Mirrors the
  // bus wrapper warning (src/bus/knowledge-base.ts).
  let hybridDegraded: { reason: string } | null = null;

  /**
   * Run a single mmrag.py query against one collection.
   * Returns empty array for non-hybrid queries (callers handle missing/empty collections
   * gracefully). When hybrid_search is enabled, a real FTS/RRF failure (non-zero exit with
   * no recoverable output) THROWS a KBHybridError instead, so it surfaces as an error response.
   */
  function runQuery(col: string): Array<{
    content?: string; result?: string; similarity?: number; rank_score?: number;
    source?: string; type?: string; filename?: string;
    chunk_index?: number; total_chunks?: number; content_full_length?: number;
  }> {
    const pyArgs = [
      mmragPath, 'query', q,
      '--collection', col,
      '--top-k', String(limit),
      '--threshold', String(threshold),
      '--json',
    ];
    let stdout = '';
    try {
      stdout = execFileSync(pythonPath, pyArgs, {
        timeout: 30000,
        encoding: 'utf-8',
        env: env as NodeJS.ProcessEnv,
      });
    } catch (e: unknown) {
      // On non-zero exit, try to recover stdout (partial output)
      stdout = (e as { stdout?: string }).stdout || '';
      if (!stdout) {
        // Phase-2 fail-loud: a real FTS/RRF failure while hybrid_search is on must SURFACE
        // as an error response, not be masked as "0 results". Non-hybrid stays neutral.
        if (hybridEnabled) {
          const stderr = String((e as { stderr?: unknown }).stderr ?? '').trim();
          throw new KBHybridError(
            `hybrid_search query failed (collection=${col}): ${stderr || (e as Error).message}`,
          );
        }
        return [];
      }
    }
    const trimmed = stdout.trim();
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart === -1) return [];
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart));
      const hy = parsed.hybrid;
      if (hy && hy.enabled === true && hy.applied === false && hy.reason === 'sidecar-missing') {
        hybridDegraded = { reason: 'sidecar-missing' };
        console.warn(
          "[api/kb/search] hybrid_search enabled but FTS sidecar missing — vector-only results. " +
          "Run 'mmrag fts-build' to enable hybrid retrieval.",
        );
      }
      return parsed.results || [];
    } catch { return []; }
  }

  /**
   * List available collection names for the org by running mmrag.py collections.
   * Handles partial output (ChromaDB pickle corruption may crash mid-output).
   */
  function listCollections(): string[] {
    let stdout = '';
    try {
      stdout = execFileSync(pythonPath, [mmragPath, 'collections'], {
        timeout: 15000,
        encoding: 'utf-8',
        env: env as NodeJS.ProcessEnv,
      });
    } catch (e: unknown) {
      stdout = (e as { stdout?: string }).stdout || '';
      if (!stdout) return [];
    }
    const names: string[] = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line || line.startsWith('Collection') || line.startsWith('---')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const name = parts.slice(0, parts.length - 1).join(' ');
        if (name) names.push(name);
      }
    }
    return names;
  }

  try {
    let allResults: Array<{
      content?: string; result?: string; similarity?: number; rank_score?: number;
      source?: string; type?: string; filename?: string;
      chunk_index?: number; total_chunks?: number; content_full_length?: number;
    }> = [];

    if (collection) {
      // Explicit collection requested — query it directly
      allResults = runQuery(collection);
    } else {
      // scope=all: discover available collections and query each one.
      // Prefer this over hardcoded "shared-{org}" because many installs only
      // have agent-* collections (no shared collection ingested yet).
      const knownCollections = listCollections();

      if (knownCollections.length > 0) {
        for (const col of knownCollections) {
          // Filter by scope
          const isShared = col.startsWith('shared-');
          const isPrivate = col.startsWith('agent-');
          const matchesScope =
            scope === 'all' ||
            (scope === 'shared' && isShared) ||
            (scope === 'private' && isPrivate);
          // If agent is specified for private scope, only that agent's collection
          const matchesAgent =
            !agent || !isPrivate || col === `agent-${agent}`;

          if (matchesScope && matchesAgent) {
            const colResults = runQuery(col);
            // Tag each result with its collection name for display
            allResults.push(...colResults.map(r => ({ ...r, _collection: col })));
          }
        }
      } else {
        // Fallback: no collection list available, try conventional names
        allResults.push(...runQuery(`shared-${org}`));
        if (agent) allResults.push(...runQuery(`agent-${agent}`));
      }

      // Sort merged results by rank_score descending (Phase-2 hybrid ranking-key:
      // = RRF when hybrid_search is on, = similarity otherwise), deduplicate by content hash.
      allResults.sort((a, b) => (b.rank_score ?? b.similarity ?? 0) - (a.rank_score ?? a.similarity ?? 0));
      const seen = new Set<string>();
      allResults = allResults.filter(r => {
        const k = (r.source || '') + '::' + (r.content || r.result || '').slice(0, 100);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      // Apply limit after merge
      allResults = allResults.slice(0, limit);
    }

    if (allResults.length === 0) {
      return Response.json({
        results: [], total: 0, query: q, collection: `shared-${org}`,
        ...(hybridDegraded ? { hybridDegraded } : {}),
      });
    }

    const results = allResults.map((r) => ({
      content: r.content || r.result || '',
      source_file: r.source || '',
      agent_name: agent || undefined,
      org: org || '',
      score: r.rank_score ?? r.similarity ?? 0,
      doc_type: r.type || 'text',
      filename: r.filename || '',
      collection: (r as { _collection?: string })._collection || collection || `shared-${org}`,
      chunk_index: r.chunk_index ?? null,
      total_chunks: r.total_chunks ?? null,
      content_full_length: r.content_full_length ?? null,
    }));

    return Response.json({
      results,
      total: results.length,
      query: q,
      collection: collection || 'all',
      ...(hybridDegraded ? { hybridDegraded } : {}),
    });
  } catch (err: unknown) {
    // Phase-2 fail-loud: a hybrid_search failure must surface as an error response, never
    // be masked as a 200 with empty results.
    if (err instanceof KBHybridError) {
      console.error('[api/kb/search]', err.message);
      return Response.json({ error: err.message, hybrid: true }, { status: 500 });
    }
    const message = err instanceof Error ? err.message : String(err);
    // If knowledge base not set up, return empty rather than 500
    if (message.includes('not set up') || message.includes('No collections')) {
      return Response.json({ results: [], total: 0, query: q, collection: `shared-${org}` });
    }
    console.error('[api/kb/search] Error:', message);
    return Response.json({ error: 'Knowledge base query failed' }, { status: 500 });
  }
}
