import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { CohortRetentionRow } from '@/lib/data/skool';

interface Props {
  rows: CohortRetentionRow[];
}

function fmtMonth(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

function retentionColor(pct: number | null): string {
  if (pct == null) return 'bg-muted/20';
  if (pct >= 85) return 'bg-green-500/40';
  if (pct >= 70) return 'bg-green-500/25';
  if (pct >= 50) return 'bg-amber-500/30';
  if (pct >= 30) return 'bg-amber-500/15';
  return 'bg-red-500/25';
}

export function CohortRetentionHeatmap({ rows }: Props) {
  const ordered = [...rows].reverse();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cohort retention by join month</CardTitle>
      </CardHeader>
      <CardContent>
        {ordered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8" data-testid="cohort-empty">
            No cohort data yet.
          </p>
        ) : (
          <div className="overflow-x-auto" data-testid="cohort-heatmap">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 font-medium">Cohort</th>
                  <th className="text-right py-2 font-medium">Size</th>
                  <th className="text-right py-2 font-medium">Still paying</th>
                  <th className="text-right py-2 font-medium">Retention %</th>
                  <th className="text-right py-2 font-medium">Avg days to churn</th>
                  <th className="text-right py-2 font-medium">Median days</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((r) => (
                  <tr key={r.cohort_month} className="border-b last:border-0">
                    <td className="py-2 font-medium">{fmtMonth(r.cohort_month)}</td>
                    <td className="py-2 text-right tabular-nums">{r.cohort_size}</td>
                    <td className="py-2 text-right tabular-nums">{r.still_paying}</td>
                    <td className="py-2 text-right tabular-nums">
                      <span className={`inline-block px-2 py-0.5 rounded ${retentionColor(r.retention_pct)}`}>
                        {r.retention_pct != null ? `${Number(r.retention_pct).toFixed(1)}%` : '—'}
                      </span>
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {r.avg_days_to_churn != null ? Number(r.avg_days_to_churn).toFixed(0) : '—'}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {r.median_days_to_churn != null ? Number(r.median_days_to_churn).toFixed(0) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
