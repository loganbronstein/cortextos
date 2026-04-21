import {
  listOpenPrs,
  listOpenIssues,
  listRecentMerges,
  listCheckRunsForRef,
  checkSummary,
  repoSlug,
  type GhPr,
  type GhIssue,
  type GhCheckRun,
} from '../github-client';

export interface PrWithChecks extends GhPr {
  checks: { passing: number; failing: number; pending: number; total: number };
}

export async function getOpenPrs(): Promise<PrWithChecks[]> {
  const prs = await listOpenPrs();
  const withChecks = await Promise.all(
    prs.map(async (p) => {
      const runs = await listCheckRunsForRef(p.head.sha);
      const sum = checkSummary(runs);
      return { ...p, checks: { ...sum, total: runs.length } } as PrWithChecks;
    }),
  );
  return withChecks;
}

export async function getOpenIssues(): Promise<GhIssue[]> {
  return listOpenIssues();
}

export async function getRecentMerges(): Promise<GhPr[]> {
  // Filter for actually-merged PRs (closed but not merged happens too).
  const raw = await listRecentMerges(20);
  return raw.filter((p) => (p as unknown as { merged_at?: string | null }).merged_at).slice(0, 10);
}

export function getRepoSlug(): string {
  return repoSlug();
}

export type { GhPr, GhIssue, GhCheckRun };
