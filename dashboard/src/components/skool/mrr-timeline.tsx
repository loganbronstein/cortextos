'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AreaChart } from '@/components/charts/area-chart';
import type { DailyAnalyticsRow } from '@/lib/data/skool';

interface Props {
  series: DailyAnalyticsRow[];
}

function fmtDate(s: string) {
  const d = new Date(s + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function MrrTimeline({ series }: Props) {
  const data = series.map((r) => ({
    date: fmtDate(r.date),
    MRR: r.mrr !== null ? Math.round(Number(r.mrr)) : null,
    'MRR at risk': r.cancelling_mrr_at_risk !== null ? Math.round(Number(r.cancelling_mrr_at_risk)) : null,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>MRR over time</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8" data-testid="mrr-empty">
            No daily analytics rows yet — the first cron run will populate this.
          </p>
        ) : data.length < 2 ? (
          <div className="py-8 text-sm text-muted-foreground space-y-1" data-testid="mrr-single-point">
            <p>Only one data point so far ({data[0].date}, ${data[0].MRR?.toLocaleString()}).</p>
            <p>Chart will fill in after the next scheduled scrape.</p>
          </div>
        ) : (
          <AreaChart data={data} xKey="date" yKeys={['MRR', 'MRR at risk']} height={250} showLegend />
        )}
      </CardContent>
    </Card>
  );
}
