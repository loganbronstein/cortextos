import { Card, CardContent } from '@/components/ui/card';
import type { FunnelMetric } from '@/lib/data/funnel';

function fmtNumber(n: number | null, unit?: string): string {
  if (n === null || Number.isNaN(n)) return '—';
  if (unit === '%') return `${n.toFixed(2)}%`;
  return n.toLocaleString('en-US');
}

function fmtWhen(iso: string | null): string {
  if (!iso) return 'awaiting data';
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60000);
  let rel: string;
  if (min < 1) rel = 'just now';
  else if (min < 60) rel = `${min}m ago`;
  else if (min < 1440) rel = `${Math.floor(min / 60)}h ago`;
  else rel = `${Math.floor(min / 1440)}d ago`;
  const abs = d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `as of ${rel} (${abs})`;
}

interface Props {
  label: string;
  metric: FunnelMetric;
  unit?: string;
}

export function FunnelCard({ label, metric, unit }: Props) {
  const empty = metric.value === null;
  return (
    <Card className={empty ? 'bg-muted/20' : 'bg-muted/30'} data-testid={`funnel-card-${metric.platform}-${metric.metric}`}>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid="funnel-value">
          {fmtNumber(metric.value, unit)}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{fmtWhen(metric.collected_at)}</p>
      </CardContent>
    </Card>
  );
}
