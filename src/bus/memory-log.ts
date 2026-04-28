import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type Importance = 'low' | 'medium' | 'high' | 'critical';

export interface MemoryLogEnv {
  frameworkRoot: string;
  org: string;
  agentDir?: string;
}

interface MemoryProfile {
  agent_name?: string;
  allowed_episode_types?: string[];
  disallowed_episode_types?: string[];
  allowed_decision_types?: string[];
  disallowed_decision_types?: string[];
}

export interface LogEpisodeInput {
  agent: string;
  episodeType: string;
  importance: Importance;
  summary: string;
  payload?: string;
  linkedTaskId?: string;
  linkedApprovalId?: string;
  linkedAgent?: string;
}

export interface LogDecisionInput {
  agent: string;
  decisionType: string;
  importance: Importance;
  title: string;
  rationale: string;
  alternatives?: string;
  payload?: string;
  linkedTaskId?: string;
  linkedEntities?: string;
  lifecycleState?: 'proposed' | 'active' | 'superseded' | 'reverted';
  supersedesId?: string;
}

const IMPORTANCE_VALUES = new Set(['low', 'medium', 'high', 'critical']);
const LIFECYCLE_VALUES = new Set(['proposed', 'active', 'superseded', 'reverted']);

export function logEpisodeToNeon(env: MemoryLogEnv, input: LogEpisodeInput): { ok: true; agent: string; episode_type: string; importance: Importance } {
  validateImportance(input.importance);
  requireNonempty(input.agent, 'agent');
  requireNonempty(input.episodeType, 'episode_type');
  requireNonempty(input.summary, 'summary');
  enforceProfile(env, input.agent, 'episode', input.episodeType);

  const payload = parseJson(input.payload ?? '{}', 'payload');
  const sql = `
INSERT INTO agent_episodes (
  agent_name, episode_type, importance, summary, payload, linked_task_id, linked_approval_id, linked_agent
) VALUES (
  ${sqlLiteral(input.agent)},
  ${sqlLiteral(input.episodeType)},
  ${sqlLiteral(input.importance)},
  ${sqlLiteral(input.summary)},
  ${sqlLiteral(JSON.stringify(payload))}::jsonb,
  ${sqlNullable(input.linkedTaskId)},
  ${sqlNullable(input.linkedApprovalId)},
  ${sqlNullable(input.linkedAgent)}
);
`;
  runPsql(env, sql);
  return { ok: true, agent: input.agent, episode_type: input.episodeType, importance: input.importance };
}

export function logDecisionToNeon(env: MemoryLogEnv, input: LogDecisionInput): { ok: true; agent: string; decision_type: string; importance: Importance } {
  validateImportance(input.importance);
  requireNonempty(input.agent, 'agent');
  requireNonempty(input.decisionType, 'decision_type');
  requireNonempty(input.title, 'title');
  requireNonempty(input.rationale, 'rationale');
  enforceProfile(env, input.agent, 'decision', input.decisionType);

  const lifecycleState = input.lifecycleState ?? 'active';
  if (!LIFECYCLE_VALUES.has(lifecycleState)) {
    throw new Error(`Invalid lifecycle_state '${lifecycleState}'. Must be one of: ${[...LIFECYCLE_VALUES].join(', ')}`);
  }

  const payload = parseJson(input.payload ?? '{}', 'payload');
  const linkedEntities = parseJson(input.linkedEntities ?? '[]', 'linked_entities');
  if (!Array.isArray(linkedEntities)) {
    throw new Error('linked_entities must be a JSON array');
  }
  const supersedesId = input.supersedesId ? Number(input.supersedesId) : null;
  if (supersedesId !== null && (!Number.isInteger(supersedesId) || supersedesId <= 0)) {
    throw new Error('--supersedes must be a positive integer decision id');
  }

  const sql = `
INSERT INTO agent_decisions (
  agent_name, decision_type, importance, title, rationale, alternatives_considered,
  lifecycle_state, supersedes_id, payload, linked_task_id, linked_entities
) VALUES (
  ${sqlLiteral(input.agent)},
  ${sqlLiteral(input.decisionType)},
  ${sqlLiteral(input.importance)},
  ${sqlLiteral(input.title)},
  ${sqlLiteral(input.rationale)},
  ${sqlNullable(input.alternatives)},
  ${sqlLiteral(lifecycleState)},
  ${supersedesId ?? 'NULL'},
  ${sqlLiteral(JSON.stringify(payload))}::jsonb,
  ${sqlNullable(input.linkedTaskId)},
  ${sqlLiteral(JSON.stringify(linkedEntities))}::jsonb
);
`;
  runPsql(env, sql);
  return { ok: true, agent: input.agent, decision_type: input.decisionType, importance: input.importance };
}

function validateImportance(importance: string): asserts importance is Importance {
  if (!IMPORTANCE_VALUES.has(importance)) {
    throw new Error(`Invalid importance '${importance}'. Must be one of: ${[...IMPORTANCE_VALUES].join(', ')}`);
  }
}

function requireNonempty(value: string, label: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} must be valid JSON: ${(err as Error).message}`);
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlNullable(value?: string): string {
  return value && value.trim() ? sqlLiteral(value) : 'NULL';
}

function runPsql(env: MemoryLogEnv, sql: string): void {
  const neonUrl = loadCortexNeonUrl(env);
  const psql = resolvePsql();
  execFileSync(psql, [neonUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  });
}

function loadCortexNeonUrl(env: MemoryLogEnv): string {
  const secretsPath = join(env.frameworkRoot || process.cwd(), 'orgs', env.org || 'cortex', 'secrets.env');
  if (!existsSync(secretsPath)) {
    throw new Error(`Cortex secrets file not found at ${secretsPath}`);
  }
  const content = readFileSync(secretsPath, 'utf-8');
  const match = content.match(/^CORTEX_NEON_URL=(.*)$/m);
  if (!match) throw new Error('CORTEX_NEON_URL not found in secrets.env');
  const value = match[1].trim().replace(/^['"]|['"]$/g, '');
  if (!value) throw new Error('CORTEX_NEON_URL is empty in secrets.env');
  return value;
}

function resolvePsql(): string {
  const candidates = [
    process.env.PSQL_BIN,
    '/opt/homebrew/opt/postgresql@16/bin/psql',
    '/opt/homebrew/bin/psql',
    'psql',
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (candidate === 'psql' || existsSync(candidate)) return candidate;
  }
  throw new Error('psql not found; install PostgreSQL client or set PSQL_BIN');
}

function enforceProfile(env: MemoryLogEnv, agent: string, kind: 'episode' | 'decision', type: string): void {
  const profile = loadProfile(env, agent);
  if (!profile) return;

  const allowed = kind === 'episode' ? profile.allowed_episode_types : profile.allowed_decision_types;
  const disallowed = kind === 'episode' ? profile.disallowed_episode_types : profile.disallowed_decision_types;

  if (disallowed?.includes(type)) {
    throw new Error(`${agent} is not allowed to log ${kind} type '${type}' by memory profile`);
  }
  if (allowed && !allowed.includes('*') && !allowed.includes(type)) {
    throw new Error(`${agent} memory profile does not allow ${kind} type '${type}'`);
  }
}

function loadProfile(env: MemoryLogEnv, agent: string): MemoryProfile | null {
  const candidates = [
    env.agentDir && env.agentDir.endsWith(join('agents', agent)) ? join(env.agentDir, '.claude', 'memory-profile.json') : '',
    env.agentDir && env.agentDir.endsWith(join('agents', agent)) ? join(env.agentDir, 'memory-profile.json') : '',
    join(env.frameworkRoot || process.cwd(), 'orgs', env.org || 'cortex', 'agents', agent, '.claude', 'memory-profile.json'),
    join(env.frameworkRoot || process.cwd(), 'orgs', env.org || 'cortex', 'agents', agent, 'memory-profile.json'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, 'utf-8')) as MemoryProfile;
    } catch (err) {
      throw new Error(`Could not parse memory profile for ${agent}: ${(err as Error).message}`);
    }
  }
  return null;
}
