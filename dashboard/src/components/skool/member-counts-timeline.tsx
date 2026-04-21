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

export function MemberCountsTimeline({ series }: Props) {
  const data = series.map((r) => ({
    date: fmtDate(r.date),
    Active: r.active_count ?? 0,
    Cancelling: r.cancelling_count ?? 0,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Member counts over time</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length < 2 ? (
          <p className="text-sm text-muted-foreground py-8" data-testid="members-empty">
            Needs at least 2 days of history. Check back after the next scrape.
          </p>
        ) : (
          <AreaChart data={data} xKey="date" yKeys={['Active', 'Cancelling']} height={250} showLegend />
        )}
      </CardContent>
    </Card>
  );
}
