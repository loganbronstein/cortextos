'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart } from '@/components/charts/bar-chart';
import type { TierDistributionRow } from '@/lib/data/skool';

interface Props {
  rows: TierDistributionRow[];
}

export function TierDistribution({ rows }: Props) {
  const data = rows.map((r) => ({
    tier: r.period === 'lifetime'
      ? 'Free lifetime'
      : `$${r.price}/${r.period === 'year' ? 'yr' : r.period === 'month' ? 'mo' : r.period}`,
    Members: r.count,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Current pricing tier distribution</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8">No tier data.</p>
        ) : (
          <BarChart data={data} xKey="tier" yKeys={['Members']} height={220} />
        )}
      </CardContent>
    </Card>
  );
}
