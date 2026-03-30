import { execFileSync, execFile } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';

/**
 * Knowledge base integration — wraps the kb-*.sh scripts (which call mmrag.py)
 * as TypeScript functions for agent use.
 */

// __dirname is dist/ in compiled bundle (tsup bundles to single cli.js)
// So ../bus points to <project-root>/bus/
const SCRIPT_DIR = join(__dirname, '../bus');

export interface KBQueryResult {
  content: string;
  source_file: string;
  agent_name?: string;
  org: string;
  score: number;
  doc_type: string;
}

export interface KBQueryResponse {
  results: KBQueryResult[];
  total: number;
  query: string;
  collection: string;
}

/**
 * Query the knowledge base.
 * Returns parsed JSON results when --json is used internally.
 */
export function queryKnowledgeBase(
  paths: BusPaths,
  question: string,
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private' | 'all';
    topK?: number;
    threshold?: number;
    frameworkRoot: string;
    instanceId: string;
  },
): KBQueryResponse {
  const { org, agent, scope = 'all', topK = 5, threshold = 0.5, frameworkRoot, instanceId } = options;

  const kbRoot = join(process.env.HOME || '', '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    CTX_ORG: org,
    CTX_AGENT_NAME: agent || '',
    CTX_INSTANCE_ID: instanceId,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    MMRAG_DIR: kbRoot,
    MMRAG_CHROMADB_DIR: join(kbRoot, 'chromadb'),
    MMRAG_CONFIG: join(kbRoot, 'config.json'),
  };

  const args = [
    join(SCRIPT_DIR, 'kb-query.sh'),
    question,
    '--org', org,
    '--scope', scope,
    '--top-k', String(topK),
    '--threshold', String(threshold),
    '--json',
    '--instance', instanceId,
  ];

  if (agent) {
    args.push('--agent', agent);
  }

  try {
    const output = execFileSync('bash', args, {
      encoding: 'utf-8',
      timeout: 30000,
      env,
    });

    // mmrag.py --json outputs pretty-printed JSON; find and parse the JSON block
    const trimmed = output.trim();
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart !== -1) {
      const raw = JSON.parse(trimmed.slice(jsonStart)) as {
        results?: Array<{ content?: string; result?: string; similarity?: number; source?: string; type?: string }>;
        result_count?: number;
        query?: string;
        collection?: string;
      };
      const results: KBQueryResult[] = (raw.results || []).map((r) => ({
        content: r.content || r.result || '',
        source_file: r.source || '',
        org,
        agent_name: agent,
        score: r.similarity ?? 0,
        doc_type: r.type || 'markdown',
      }));
      return {
        results,
        total: raw.result_count ?? results.length,
        query: question,
        collection: raw.collection || `shared-${org}`,
      };
    }
  } catch {
    // Script failed or not set up — return empty
  }

  return { results: [], total: 0, query: question, collection: `shared-${org}` };
}

/**
 * Ingest files into the knowledge base.
 */
export function ingestKnowledgeBase(
  paths: string[],
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private';
    force?: boolean;
    frameworkRoot: string;
    instanceId: string;
  },
): void {
  const { org, agent, scope = 'shared', force, frameworkRoot, instanceId } = options;

  const kbRoot = join(process.env.HOME || '', '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    CTX_ORG: org,
    CTX_AGENT_NAME: agent || '',
    CTX_INSTANCE_ID: instanceId,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    MMRAG_DIR: kbRoot,
    MMRAG_CHROMADB_DIR: join(kbRoot, 'chromadb'),
    MMRAG_CONFIG: join(kbRoot, 'config.json'),
  };

  const args = [
    join(SCRIPT_DIR, 'kb-ingest.sh'),
    ...paths,
    '--org', org,
    '--scope', scope,
    '--instance', instanceId,
  ];

  if (agent) args.push('--agent', agent);
  if (force) args.push('--force');

  execFileSync('bash', args, {
    encoding: 'utf-8',
    timeout: 120000,
    env,
    stdio: 'inherit',
  });
}

/**
 * Ensure the knowledge base directories exist for an org.
 */
export function ensureKBDirs(instanceId: string, org: string): void {
  const kbRoot = join(process.env.HOME || '', '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }
}
