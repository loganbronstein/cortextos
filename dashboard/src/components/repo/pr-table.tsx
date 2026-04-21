import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { PrWithChecks } from '@/lib/data/repo';

function fmtRelative(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function ChecksBadge({ c }: { c: PrWithChecks['checks'] }) {
  if (c.total === 0) return <Badge variant="outline" className="text-[11px]">no checks</Badge>;
  if (c.failing > 0) return <Badge variant="destructive" className="text-[11px]">{c.failing} failing</Badge>;
  if (c.pending > 0) return <Badge variant="secondary" className="text-[11px]">{c.pending} pending</Badge>;
  return <Badge className="bg-green-600 text-white text-[11px]">{c.passing} passing</Badge>;
}

export function PrTable({ prs }: { prs: PrWithChecks[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Open pull requests ({prs.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {prs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4" data-testid="repo-prs-empty">
            No open PRs.
          </p>
        ) : (
          <div className="overflow-x-auto" data-testid="repo-prs-table">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Author</TableHead>
                  <TableHead>CI</TableHead>
                  <TableHead>Labels</TableHead>
                  <TableHead className="text-right">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prs.map((p) => (
                  <TableRow key={p.number}>
                    <TableCell className="font-mono text-xs">
                      <a href={p.html_url} target="_blank" rel="noreferrer" className="hover:underline">#{p.number}</a>
                    </TableCell>
                    <TableCell className="max-w-md">
                      <div className="flex flex-col gap-0.5">
                        <a href={p.html_url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                          {p.title}
                        </a>
                        {p.draft && <span className="text-[10px] text-muted-foreground uppercase">draft</span>}
                        {p.body && <p className="text-[11px] text-muted-foreground line-clamp-2">{p.body.slice(0, 200)}</p>}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">{p.user?.login ?? '—'}</TableCell>
                    <TableCell><ChecksBadge c={p.checks} /></TableCell>
                    <TableCell className="space-x-1">
                      {p.labels.slice(0, 3).map((l) => (
                        <Badge key={l.name} variant="outline" className="text-[10px]">{l.name}</Badge>
                      ))}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground tabular-nums">{fmtRelative(p.updated_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
