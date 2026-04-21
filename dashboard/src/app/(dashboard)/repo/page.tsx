import { getOpenPrs, getOpenIssues, getRecentMerges, getRepoSlug } from '@/lib/data/repo';
import { PrTable } from '@/components/repo/pr-table';
import { IssuesTable } from '@/components/repo/issues-table';
import { RecentMerges } from '@/components/repo/recent-merges';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function RepoPage() {
  const [prs, issues, merges] = await Promise.all([
    getOpenPrs(),
    getOpenIssues(),
    getRecentMerges(),
  ]);

  return (
    <div className="space-y-5 p-6 max-w-[1400px] mx-auto" data-testid="repo-page">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Repo</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Live view of{' '}
          <a className="underline" href={`https://github.com/${getRepoSlug()}`} target="_blank" rel="noreferrer">
            {getRepoSlug()}
          </a>
          . Open PRs with CI status, open issues, and the last merges — so you stop bouncing to GitHub for these.
        </p>
      </div>

      <PrTable prs={prs} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <IssuesTable issues={issues} />
        <RecentMerges merges={merges} />
      </div>
    </div>
  );
}
