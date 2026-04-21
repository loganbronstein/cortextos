'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { OutreachRow } from '@/lib/data/skool';

function fmtWhen(iso: string) {
  const d = new Date(iso);
  const absolute = d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const ms = d.getTime() - Date.now();
  const abs = Math.abs(ms);
  const min = Math.floor(abs / 60000);
  let rel = '';
  if (min < 60) rel = `${min}m`;
  else if (min < 1440) rel = `${Math.floor(min / 60)}h`;
  else rel = `${Math.floor(min / 1440)}d`;
  rel = ms < 0 ? `${rel} ago` : `in ${rel}`;
  return { absolute, rel };
}

function statusBadge(s: OutreachRow['status']) {
  const map: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
    scheduled: { label: 'scheduled', variant: 'secondary' },
    ready: { label: 'ready to send', variant: 'default' },
    sent: { label: 'sent', variant: 'outline' },
    skipped: { label: 'skipped', variant: 'outline' },
    failed: { label: 'failed', variant: 'destructive' },
    responded: { label: 'responded', variant: 'default' },
  };
  const meta = map[s] || { label: s, variant: 'secondary' as const };
  return <Badge variant={meta.variant} className="text-[11px]">{meta.label}</Badge>;
}

export function OutreachQueue({ rows }: { rows: OutreachRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function execute(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const r = await fetch(`/api/crm/outreach/${id}/ready`, { method: 'POST' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `status ${r.status}`);
      }
      start(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to execute');
    } finally {
      setBusyId(null);
    }
  }

  const counts = rows.reduce(
    (acc, r) => {
      if (r.status === 'scheduled') acc.scheduled++;
      else if (r.status === 'ready') acc.ready++;
      return acc;
    },
    { scheduled: 0, ready: 0 },
  );

  return (
    <Card data-testid="outreach-queue">
      <CardHeader>
        <CardTitle>
          CRM outreach queue
          {' '}
          <span className="text-sm font-normal text-muted-foreground">
            ({counts.scheduled} scheduled, {counts.ready} ready)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-destructive mb-3" data-testid="outreach-error">{error}</p>}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4" data-testid="outreach-empty">
            No outreach in queue. Either nothing triggered yet, or everything has been sent/responded.
          </p>
        ) : (
          <div className="overflow-x-auto" data-testid="outreach-table">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Sequence</TableHead>
                  <TableHead>Step</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Scheduled</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const when = fmtWhen(r.scheduled_for);
                  const canExecute = r.status === 'scheduled' && !pending && busyId !== r.id;
                  return (
                    <TableRow key={r.id} data-testid="outreach-row" data-row-status={r.status}>
                      <TableCell>
                        <div className="font-medium">{r.member_name ?? '—'}</div>
                        <div className="text-[11px] text-muted-foreground">@{r.member_handle}</div>
                      </TableCell>
                      <TableCell className="text-xs">{r.sequence_slug}</TableCell>
                      <TableCell className="tabular-nums">{r.step}</TableCell>
                      <TableCell className="text-xs">{r.channel}</TableCell>
                      <TableCell className="text-xs">
                        <div>{when.absolute}</div>
                        <div className="text-muted-foreground">{when.rel}</div>
                      </TableCell>
                      <TableCell>{statusBadge(r.status)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!canExecute}
                          onClick={() => execute(r.id)}
                          data-testid="outreach-execute"
                        >
                          {busyId === r.id ? '…' : r.status === 'scheduled' ? 'Execute' : 'Done'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
