import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { CurrentKpis, DataMaturity, WowDelta } from '@/lib/data/skool';

interface HeroKpisProps {
  kpis: CurrentKpis;
  maturity: DataMaturity;
  wow?: Record<string, WowDelta>;
}

function fmtUsd(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function DeltaBadge({ d, kind, invert }: { d?: WowDelta; kind: 'count' | 'money'; invert?: boolean }) {
  if (!d || d.delta_abs === null) {
    return <span className="text-[10px] text-muted-foreground" data-testid="wow-waiting">waiting for history</span>;
  }
  const positive = d.delta_abs > 0;
  const flat = d.delta_abs === 0;
  const good = flat ? null : invert ? !positive : positive;
  const color = flat ? 'text-muted-foreground' : good ? 'text-green-600' : 'text-red-600';
  const arrow = flat ? '•' : positive ? '▲' : '▼';
  const absLabel = kind === 'money' ? `${positive ? '+' : ''}${fmtUsd(d.delta_abs)}` : `${positive ? '+' : ''}${d.delta_abs}`;
  const pctLabel = d.delta_pct !== null ? ` (${d.delta_pct > 0 ? '+' : ''}${d.delta_pct}%)` : '';
  return (
    <span className={cn('text-[10px] tabular-nums', color)} data-testid="wow-delta">
      {arrow} {absLabel}{pctLabel} vs {d.prior_date ?? 'last wk'}
    </span>
  );
}

function Tile({ label, value, sub, delta }: { label: string; value: string; sub?: string; delta?: React.ReactNode }) {
  return (
    <Card className="bg-muted/30">
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
        {delta && <div className="mt-1.5">{delta}</div>}
      </CardContent>
    </Card>
  );
}

export function HeroKpis({ kpis, maturity, wow }: HeroKpisProps) {
  const asOfLabel = kpis.as_of
    ? new Date(kpis.as_of).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'no data yet';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">as of {asOfLabel} UTC</p>
        <p className="text-[11px] text-muted-foreground" data-testid="maturity-note">{maturity.note}</p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3" data-testid="hero-kpis">
        <Tile
          label="MRR"
          value={fmtUsd(kpis.mrr)}
          sub="current"
          delta={<DeltaBadge d={wow?.mrr} kind="money" />}
        />
        <Tile
          label="Active"
          value={kpis.active.toLocaleString()}
          sub="paying + cancelling"
          delta={<DeltaBadge d={wow?.active} kind="count" />}
        />
        <Tile
          label="Cancelling"
          value={kpis.cancelling.toLocaleString()}
          sub="hit cancel, still paid"
          delta={<DeltaBadge d={wow?.cancelling} kind="count" invert />}
        />
        <Tile
          label="Churned (all-time)"
          value={kpis.churned.toLocaleString()}
          sub="historical"
          delta={<DeltaBadge d={wow?.churned} kind="count" invert />}
        />
        <Tile
          label="MRR at risk"
          value={fmtUsd(kpis.cancelling_mrr_at_risk)}
          sub="from cancelling"
          delta={<DeltaBadge d={wow?.cancelling_mrr_at_risk} kind="money" invert />}
        />
        <Tile label="Imminent churn" value={kpis.imminent_churn_7d.toLocaleString()} sub="in ≤7 days" />
      </div>
    </div>
  );
}
