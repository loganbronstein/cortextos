import { getAllFunnelLatest, FUNNEL_CARDS } from '@/lib/data/funnel';
import { FunnelCard } from '@/components/funnel/funnel-card';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function FunnelAnalyticsPage() {
  const metrics = await getAllFunnelLatest();
  const allEmpty = metrics.every((m) => m.value === null);

  return (
    <div className="space-y-5 p-6 max-w-[1400px] mx-auto" data-testid="funnel-page">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Funnel analytics</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Top-of-funnel metrics across platforms. Data agent owns the daily collector — cards will populate as soon as the first write lands.
        </p>
      </div>

      {allEmpty && (
        <div
          data-testid="funnel-waiting-banner"
          className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground"
        >
          Waiting for data agent to ship the first social_stats write. Schema is applied (table social_stats with platform/metric/value/collected_at). Placeholder cards below show the fields this page will display.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3" data-testid="funnel-cards">
        {FUNNEL_CARDS.map((card, i) => (
          <FunnelCard
            key={`${card.platform}-${card.metric}`}
            label={card.label}
            metric={metrics[i]}
            unit={card.unit}
          />
        ))}
      </div>
    </div>
  );
}
