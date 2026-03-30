import { NextRequest } from 'next/server';
import { execSync } from 'child_process';
import path from 'path';
import { getCTXRoot, getFrameworkRoot } from '@/lib/config';


export const dynamic = 'force-dynamic';

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

  const q = searchParams.get('q');
  const org = searchParams.get('org') || '';
  const agent = searchParams.get('agent') || '';
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

  const scriptPath = path.join(frameworkRoot, 'bus', 'kb-query.sh');

  const args: string[] = [
    q,
    '--scope', scope,
    '--top-k', String(limit),
    '--threshold', String(threshold),
    '--json',
    '--instance', instanceId,
  ];

  if (org) args.push('--org', org);
  if (agent) args.push('--agent', agent);

  // Load org secrets for GEMINI_API_KEY
  const secretsPath = org
    ? path.join(frameworkRoot, 'orgs', org, 'secrets.env')
    : null;

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_INSTANCE_ID: instanceId,
    PATH: process.env.PATH ?? '',
  };

  if (org) env.CTX_ORG = org;
  if (agent) env.CTX_AGENT_NAME = agent;

  // Load GEMINI_API_KEY from secrets if available
  if (secretsPath) {
    try {
      const { readFileSync } = await import('fs');
      const secrets = readFileSync(secretsPath, 'utf-8');
      const match = secrets.match(/^GEMINI_API_KEY=(.+)$/m);
      if (match) env.GEMINI_API_KEY = match[1].trim();
    } catch {
      // No secrets file — GEMINI_API_KEY may be in process.env already
    }
  }

  if (!env.GEMINI_API_KEY) {
    return Response.json(
      { error: 'GEMINI_API_KEY not configured. Add it to orgs/{org}/secrets.env' },
      { status: 503 }
    );
  }

  try {
    // Build the command string safely (args are controlled by our own code)
    // Redirect stderr to /dev/null to suppress Python FutureWarnings from output capture
    const quotedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    const cmd = `bash '${scriptPath.replace(/'/g, "'\\''")}' ${quotedArgs} 2>/dev/null`;
    const rawOut = execSync(cmd, { timeout: 30000, env: env as NodeJS.ProcessEnv });
    const stdout = Buffer.isBuffer(rawOut) ? rawOut.toString('utf8') : String(rawOut);

    // mmrag.py --json outputs JSON (pretty-printed, multi-line).
    // Extract the JSON block by finding the first { and parsing the full blob.
    const trimmed = stdout.trim();
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart === -1) {
      return Response.json({ results: [], total: 0, query: q, collection: `shared-${org}` });
    }

    const raw = JSON.parse(trimmed.slice(jsonStart)) as {
      results?: Array<{
        content?: string;
        result?: string;
        similarity?: number;
        source?: string;
        type?: string;
        filename?: string;
        chunk_index?: number;
        total_chunks?: number;
        content_full_length?: number;
      }>;
      result_count?: number;
      query?: string;
      collection?: string;
      agent_name?: string;
      org?: string;
    };

    const results = (raw.results || []).map((r) => ({
      content: r.content || r.result || '',
      source_file: r.source || '',
      agent_name: raw.agent_name || agent || undefined,
      org: raw.org || org || '',
      score: r.similarity ?? 0,
      doc_type: r.type || 'text',
      filename: r.filename || '',
      chunk_index: r.chunk_index ?? null,
      total_chunks: r.total_chunks ?? null,
      content_full_length: r.content_full_length ?? null,
    }));

    return Response.json({
      results,
      total: raw.result_count ?? results.length,
      query: q,
      collection: raw.collection || `shared-${org}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // If knowledge base not set up, return empty rather than 500
    if (message.includes('not set up') || message.includes('No collections')) {
      return Response.json({ results: [], total: 0, query: q, collection: `shared-${org}` });
    }
    console.error('[api/kb/search] Error:', message);
    return Response.json({ error: 'Knowledge base query failed', details: message }, { status: 500 });
  }
}
