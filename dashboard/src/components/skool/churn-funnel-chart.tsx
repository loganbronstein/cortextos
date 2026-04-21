'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart } from '@/components/charts/bar-chart';
import type { ChurnFunnelRow } from '@/lib/data/skool';

interface Props {
  rows: ChurnFunnelRow[];
}

export function ChurnFunnelChart({ rows }: Props) {
  const data = rows.map((r) => ({
    stage: r.funnel_stage,
    Members: r.members,
    'MRR contribution': Math.round(Number(r.mrr_contribution_usd)),
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Member funnel — counts + MRR contribution</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8">No funnel data.</p>
        ) : (
          <BarChart data={data} xKey="stage" yKeys={['Members', 'MRR contribution']} height={220} showLegend />
        )}
      </CardContent>
    </Card>
  );
}
