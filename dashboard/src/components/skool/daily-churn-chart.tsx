'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart } from '@/components/charts/bar-chart';
import type { DailyAnalyticsRow } from '@/lib/data/skool';

interface Props {
  series: DailyAnalyticsRow[];
}

function fmtDate(s: string) {
  const d = new Date(s + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function DailyChurnChart({ series }: Props) {
  const data = series.map((r) => ({
    date: fmtDate(r.date),
    'New churns': r.new_churns_observed ?? 0,
    'New cancellations': r.new_cancellations ?? 0,
    'New joins': r.new_joins ?? 0,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily churn + growth</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8" data-testid="churn-empty">
            No daily rows yet.
          </p>
        ) : (
          <BarChart
            data={data}
            xKey="date"
            yKeys={['New churns', 'New cancellations', 'New joins']}
            height={250}
            showLegend
          />
        )}
      </CardContent>
    </Card>
  );
}
