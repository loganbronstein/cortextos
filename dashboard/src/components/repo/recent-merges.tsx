import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { GhPr } from '@/lib/data/repo';

function fmtWhen(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function RecentMerges({ merges }: { merges: GhPr[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent merges ({merges.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {merges.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4" data-testid="repo-merges-empty">No recent merges.</p>
        ) : (
          <ul className="space-y-2" data-testid="repo-merges-list">
            {merges.map((p) => {
              const mergedAt = (p as unknown as { merged_at?: string | null }).merged_at;
              return (
                <li key={p.number} className="flex items-start justify-between gap-3 border-b last:border-0 pb-2 last:pb-0">
                  <div className="min-w-0">
                    <a href={p.html_url} target="_blank" rel="noreferrer" className="font-medium text-sm hover:underline block truncate">
                      #{p.number} — {p.title}
                    </a>
                    <p className="text-xs text-muted-foreground">by {p.user?.login ?? 'unknown'}</p>
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums shrink-0">{mergedAt ? fmtWhen(mergedAt) : '—'}</span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
