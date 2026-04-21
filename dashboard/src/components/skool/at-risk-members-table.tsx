import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import type { CancellingMember, InterventionAction } from '@/lib/data/skool';

interface Props {
  members: CancellingMember[];
}

function fmtDate(s: string | null) {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function urgency(days: number | null): 'destructive' | 'secondary' | 'default' {
  if (days == null) return 'secondary';
  if (days <= 3) return 'destructive';
  if (days <= 14) return 'default';
  return 'secondary';
}

function ActionCell({ action }: { action: InterventionAction }) {
  const pill =
    action.priority === 'high' ? 'bg-red-500/15 text-red-700 dark:text-red-300' :
    action.priority === 'medium' ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300' :
    'bg-muted text-muted-foreground';
  return (
    <div
      className="flex flex-col gap-1"
      data-testid="intervention-cell"
      data-priority={action.priority}
    >
      <span className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded ${pill} w-fit`}>
        {action.label}
      </span>
      <span className="text-[11px] text-muted-foreground line-clamp-2" title={action.rationale}>
        {action.rationale}
      </span>
    </div>
  );
}

export function AtRiskMembersTable({ members }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>At-risk members ({members.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">No cancelling members — clean slate.</p>
        ) : (
          <div className="overflow-x-auto" data-testid="at-risk-table">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Days left</TableHead>
                  <TableHead className="text-right">$/mo</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead>Last active</TableHead>
                  <TableHead className="min-w-[260px]">Suggested action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => (
                  <TableRow key={m.handle}>
                    <TableCell>
                      <div className="font-medium">{m.name ?? '—'}</div>
                      <div className="text-[11px] text-muted-foreground">@{m.handle}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <Badge variant={urgency(m.cancelled_churns_in_days)}>
                        {m.cancelled_churns_in_days ?? '—'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {m.subscription_price != null ? `$${m.subscription_price}` : '—'}
                    </TableCell>
                    <TableCell className="text-xs">{m.acquisition_source ?? '—'}</TableCell>
                    <TableCell className="text-xs">{fmtDate(m.join_date)}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{m.activity_status ?? '—'}</TableCell>
                    <TableCell>
                      {m.suggested_action && <ActionCell action={m.suggested_action} />}
                    </TableCell>
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
