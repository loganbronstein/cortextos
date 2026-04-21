// Thin GitHub REST client using the PAT from env. Server-side only.
// Caches results for 60s to avoid hammering the API on every page load.

interface CacheEntry<T> { t: number; v: T }
const cache = new Map<string, CacheEntry<unknown>>();
const TTL_MS = 60_000;

function token(): string {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error('GITHUB_TOKEN missing in dashboard .env.local');
  return t;
}

export function repoSlug(): string {
  const o = process.env.GITHUB_REPO_OWNER || 'grandamenium';
  const r = process.env.GITHUB_REPO_NAME || 'cortextos';
  return `${o}/${r}`;
}

async function gh<T>(pathAndQuery: string): Promise<T> {
  const cached = cache.get(pathAndQuery);
  if (cached && Date.now() - cached.t < TTL_MS) return cached.v as T;

  const res = await fetch(`https://api.github.com${pathAndQuery}`, {
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${pathAndQuery} -> ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as T;
  cache.set(pathAndQuery, { t: Date.now(), v: data });
  return data;
}

export interface GhUser { login: string; avatar_url: string; html_url: string }
export interface GhLabel { name: string; color: string }

export interface GhPr {
  number: number;
  title: string;
  html_url: string;
  user: GhUser | null;
  draft: boolean;
  created_at: string;
  updated_at: string;
  head: { sha: string; ref: string };
  labels: GhLabel[];
  body: string | null;
}

export interface GhIssue {
  number: number;
  title: string;
  html_url: string;
  user: GhUser | null;
  labels: GhLabel[];
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
  state: string;
  assignee: GhUser | null;
}

export interface GhCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name: string; date: string } };
  author: GhUser | null;
}

export interface GhCheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  html_url: string;
}

export async function listOpenPrs(): Promise<GhPr[]> {
  return gh<GhPr[]>(`/repos/${repoSlug()}/pulls?state=open&per_page=30&sort=updated&direction=desc`);
}

export async function listOpenIssues(): Promise<GhIssue[]> {
  // GitHub lists PRs as issues too; filter them out
  const all = await gh<GhIssue[]>(`/repos/${repoSlug()}/issues?state=open&per_page=50&sort=updated&direction=desc`);
  return all.filter((i) => !i.pull_request);
}

export async function listRecentMerges(limit = 10): Promise<GhPr[]> {
  return gh<GhPr[]>(`/repos/${repoSlug()}/pulls?state=closed&per_page=${limit}&sort=updated&direction=desc`);
}

export async function listCheckRunsForRef(ref: string): Promise<GhCheckRun[]> {
  try {
    const res = await gh<{ check_runs: GhCheckRun[] }>(`/repos/${repoSlug()}/commits/${ref}/check-runs?per_page=20`);
    return res.check_runs || [];
  } catch {
    return [];
  }
}

export function checkSummary(runs: GhCheckRun[]): { passing: number; failing: number; pending: number } {
  let passing = 0, failing = 0, pending = 0;
  for (const r of runs) {
    if (r.status !== 'completed') pending++;
    else if (r.conclusion === 'success' || r.conclusion === 'neutral' || r.conclusion === 'skipped') passing++;
    else if (r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'cancelled') failing++;
    else pending++;
  }
  return { passing, failing, pending };
}
