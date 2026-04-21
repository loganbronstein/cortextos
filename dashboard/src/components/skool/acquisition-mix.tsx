'use client';

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
import type { AcquisitionLtvRow } from '@/lib/data/skool';

interface Props {
  rows: AcquisitionLtvRow[];
}

function fmtUsd(n: number | null | undefined) {
  if (n == null) return '—';
  return `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number | null) {
  if (n == null) return '—';
  return `${Number(n).toFixed(1)}%`;
}

export function AcquisitionMix({ rows }: Props) {
  const filtered = rows.filter((r) => r.total_members >= 3);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Acquisition sources — LTV + churn</CardTitle>
      </CardHeader>
      <CardContent>
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8" data-testid="acq-empty">
            Acquisition mart view is empty.
          </p>
        ) : (
          <Table data-testid="acquisition-table">
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Churned</TableHead>
                <TableHead className="text-right">Churn %</TableHead>
                <TableHead className="text-right">ARPU</TableHead>
                <TableHead className="text-right">Avg days to churn</TableHead>
                <TableHead className="text-right">Est. LTV</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => {
                const churnBad = (r.churn_pct ?? 0) >= 40;
                const churnGood = (r.churn_pct ?? 100) < 15;
                return (
                  <TableRow key={r.source}>
                    <TableCell className="font-medium">{r.source}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.total_members}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.active}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.churned}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      <Badge variant={churnGood ? 'default' : churnBad ? 'destructive' : 'secondary'}>
                        {fmtPct(r.churn_pct)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtUsd(r.active_arpu)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.avg_days_to_churn != null ? `${Number(r.avg_days_to_churn).toFixed(1)}` : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtUsd(r.estimated_ltv_usd)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
