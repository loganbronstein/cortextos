'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AreaChart } from '@/components/charts/area-chart';
import { BarChart } from '@/components/charts/bar-chart';
import { CHART_GOLD, MODEL_COLORS } from '@/components/charts/chart-theme';

interface PlanUsageData {
  session: { used_pct: number; resets: string };
  week_all_models: { used_pct: number; resets: string };
  week_sonnet: { used_pct: number };
  timestamp: string;
}

interface UsageHistoryPoint {
  timestamp: string;
  session_pct: number;
  week_pct: number;
  sonnet_pct: number;
}

interface CostTrackingProps {
  dailyCosts: Array<{ date: string; cost: number }>;
  dailyCostByModel: Array<Record<string, unknown>>;
  currentMonthCost: number;
  projectedMonthly: number;
  planUsage?: PlanUsageData | null;
  usageHistory?: UsageHistoryPoint[];
}

function UsageBar({ pct, label, sublabel }: { pct: number; label: string; sublabel?: string }) {
  const color = pct < 50 ? 'bg-green-500' : pct < 80 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div className="h-2.5 w-full rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      {sublabel && <p className="text-[10px] text-muted-foreground">{sublabel}</p>}
    </div>
  );
}

export function CostTracking({
  dailyCosts,
  dailyCostByModel,
  currentMonthCost,
  projectedMonthly,
  planUsage,
  usageHistory,
}: CostTrackingProps) {
  const modelKeys = Object.keys(MODEL_COLORS); // opus, sonnet, haiku
  const modelColorValues = modelKeys.map((k) => MODEL_COLORS[k]);

  return (
    <div className="space-y-6">
      {/* Plan Usage */}
      {planUsage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Plan Usage
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <UsageBar
              pct={planUsage.session.used_pct}
              label="Current Session"
              sublabel={planUsage.session.resets ? `Resets ${planUsage.session.resets}` : undefined}
            />
            <UsageBar
              pct={planUsage.week_all_models.used_pct}
              label="Weekly (All Models)"
              sublabel={planUsage.week_all_models.resets ? `Resets ${planUsage.week_all_models.resets}` : undefined}
            />
            <UsageBar
              pct={planUsage.week_sonnet.used_pct}
              label="Weekly (Sonnet Only)"
            />
            <p className="text-[10px] text-muted-foreground">
              Last scraped: {new Date(planUsage.timestamp).toLocaleString()}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Usage History Chart (for Max plan users) */}
      {usageHistory && usageHistory.length >= 2 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Usage Over Time
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              Plan usage percentage over time. Weekly limit resets every Sunday.
            </p>
            <AreaChart
              data={usageHistory.map(p => {
                const d = new Date(p.timestamp);
                return {
                  date: `${d.getMonth()+1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
                  'Weekly %': p.week_pct,
                  'Session %': p.session_pct,
                };
              })}
              xKey="date"
              yKeys={['Weekly %', 'Session %']}
              colors={[CHART_GOLD, '#2563EB']}
              height={200}
              showLegend
            />
          </CardContent>
        </Card>
      ) : usageHistory && usageHistory.length === 1 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Usage Right Now
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-6 py-4">
              <div className="text-center">
                <p className="text-4xl font-bold tabular-nums" style={{ color: CHART_GOLD }}>{usageHistory[0].week_pct}%</p>
                <p className="text-xs text-muted-foreground mt-1">Weekly (All Models)</p>
              </div>
              <div className="text-center">
                <p className="text-4xl font-bold tabular-nums text-muted-foreground">{usageHistory[0].session_pct}%</p>
                <p className="text-xs text-muted-foreground mt-1">Current Session</p>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground text-center">Chart will appear after next scrape</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Month-to-date cost summary */}
          {currentMonthCost > 0 && (
            <div className="grid grid-cols-2 gap-3">
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Month to Date</p>
                  <p className="text-2xl font-semibold mt-1">${currentMonthCost.toFixed(2)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Projected Monthly</p>
                  <p className="text-2xl font-semibold mt-1">${projectedMonthly.toFixed(2)}</p>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Fallback: Daily cost chart (for API users) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                Daily Cost
              </CardTitle>
            </CardHeader>
            <CardContent>
              {dailyCosts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No cost data available yet.
                </p>
              ) : (
                <AreaChart
                  data={dailyCosts}
                  xKey="date"
                  yKeys={['cost']}
                  colors={[CHART_GOLD]}
                  height={200}
                />
              )}
            </CardContent>
          </Card>

          {/* By model stacked bar */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                Cost by Model
              </CardTitle>
            </CardHeader>
            <CardContent>
              {dailyCostByModel.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No model-level cost data yet.
                </p>
              ) : (
                <BarChart
                  data={dailyCostByModel}
                  xKey="date"
                  yKeys={modelKeys}
                  colors={modelColorValues}
                  stacked
                  showLegend
                  height={200}
                />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
