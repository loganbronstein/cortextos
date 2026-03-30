import { NextRequest } from 'next/server';
import { execSync } from 'child_process';
import path from 'path';
import { getCTXRoot, getFrameworkRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * GET /api/kb/collections?org=<org>
 *
 * Lists knowledge base collections and document counts for an org.
 *
 * Response:
 * {
 *   collections: Array<{ name: string, count: number }>,
 *   org: string
 * }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') || '';

  if (!org) {
    return Response.json({ error: 'org parameter required' }, { status: 400 });
  }

  const frameworkRoot = getFrameworkRoot();
  const ctxRoot = getCTXRoot();
  const instanceId = path.basename(ctxRoot);

  const scriptPath = path.join(frameworkRoot, 'bus', 'kb-collections.sh');

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_INSTANCE_ID: instanceId,
    CTX_ORG: org,
    PATH: process.env.PATH ?? '',
  };

  // Load GEMINI_API_KEY from secrets if available
  const secretsPath = path.join(frameworkRoot, 'orgs', org, 'secrets.env');
  try {
    const { readFileSync } = await import('fs');
    const secrets = readFileSync(secretsPath, 'utf-8');
    const match = secrets.match(/^GEMINI_API_KEY=(.+)$/m);
    if (match) env.GEMINI_API_KEY = match[1].trim();
  } catch {
    // No secrets file — GEMINI_API_KEY may be in process.env already
  }

  try {
    const cmd = `bash '${scriptPath.replace(/'/g, "'\\''")}' --org '${org.replace(/'/g, "'\\''")}' --instance '${instanceId.replace(/'/g, "'\\''")}' 2>/dev/null`;
    const rawOut = execSync(cmd, { timeout: 15000, env: env as NodeJS.ProcessEnv });
    const stdout = Buffer.isBuffer(rawOut) ? rawOut.toString('utf8') : String(rawOut);

    // Parse tabular output: "collection_name  N"
    const collections: Array<{ name: string; count: number }> = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line || line.startsWith('Collection') || line.startsWith('---')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const count = parseInt(parts[parts.length - 1], 10);
        const name = parts.slice(0, parts.length - 1).join(' ');
        if (name && !isNaN(count)) {
          collections.push({ name, count });
        }
      }
    }

    return Response.json({ collections, org });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes('not set up') ||
      message.includes('No collections') ||
      message.includes('not found')
    ) {
      return Response.json({ collections: [], org });
    }
    console.error('[api/kb/collections] Error:', message);
    return Response.json({ error: 'Failed to list collections', details: message }, { status: 500 });
  }
}
