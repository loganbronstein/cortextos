import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { GhIssue } from '@/lib/data/repo';

function fmtRelative(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function IssuesTable({ issues }: { issues: GhIssue[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Open issues ({issues.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {issues.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4" data-testid="repo-issues-empty">
            No open issues.
          </p>
        ) : (
          <div className="overflow-x-auto" data-testid="repo-issues-table">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Author</TableHead>
                  <TableHead>Labels</TableHead>
                  <TableHead>Assignee</TableHead>
                  <TableHead className="text-right">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {issues.map((i) => (
                  <TableRow key={i.number}>
                    <TableCell className="font-mono text-xs">
                      <a href={i.html_url} target="_blank" rel="noreferrer" className="hover:underline">#{i.number}</a>
                    </TableCell>
                    <TableCell className="max-w-md">
                      <a href={i.html_url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                        {i.title}
                      </a>
                    </TableCell>
                    <TableCell className="text-xs">{i.user?.login ?? '—'}</TableCell>
                    <TableCell className="space-x-1">
                      {i.labels.slice(0, 4).map((l) => (
                        <Badge key={l.name} variant="outline" className="text-[10px]">{l.name}</Badge>
                      ))}
                    </TableCell>
                    <TableCell className="text-xs">{i.assignee?.login ?? '—'}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground tabular-nums">{fmtRelative(i.updated_at)}</TableCell>
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
