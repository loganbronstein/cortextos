import { getSkoolSupabase } from '@/lib/supabase-client';

export interface FunnelMetric {
  platform: 'youtube' | 'instagram' | 'tiktok' | 'twitter' | 'email' | string;
  metric: 'followers' | 'subscribers' | 'views_30d' | 'engagement_rate' | 'email_list_size' | string;
  value: number | null;
  collected_at: string | null;
}

// Cards we want to render on the page. Data agent is wiring writes; values will
// be null until the first social_stats rows land. Page handles empty gracefully.
export const FUNNEL_CARDS: Array<{ platform: string; metric: string; label: string; unit?: string }> = [
  { platform: 'youtube',   metric: 'subscribers',         label: 'YouTube subscribers' },
  { platform: 'youtube',   metric: 'total_channel_views', label: 'YouTube total views' },
  { platform: 'youtube',   metric: 'avg_views_last10',    label: 'YouTube avg views (last 10)' },
  { platform: 'instagram', metric: 'followers',           label: 'Instagram followers' },
  { platform: 'instagram', metric: 'engagement_rate',     label: 'Instagram engagement %', unit: '%' },
  { platform: 'tiktok',    metric: 'followers',           label: 'TikTok followers' },
  { platform: 'twitter',   metric: 'followers',           label: 'Twitter followers' },
  { platform: 'email',     metric: 'email_list_size',     label: 'Email list size' },
];

export async function getLatestMetric(platform: string, metric: string): Promise<FunnelMetric> {
  const sb = getSkoolSupabase();
  const { data, error } = await sb
    .from('social_stats')
    .select('platform, metric, value, collected_at')
    .eq('platform', platform)
    .eq('metric', metric)
    .order('collected_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`funnel ${platform}/${metric}: ${error.message}`);
  const row = data && data[0];
  return {
    platform,
    metric,
    value: row ? Number(row.value) : null,
    collected_at: row ? row.collected_at : null,
  };
}

export async function getAllFunnelLatest(): Promise<FunnelMetric[]> {
  return Promise.all(FUNNEL_CARDS.map((c) => getLatestMetric(c.platform, c.metric)));
}

export async function getMetricHistory(platform: string, metric: string, days = 30): Promise<Array<{ date: string; value: number }>> {
  const sb = getSkoolSupabase();
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const { data, error } = await sb
    .from('social_stats')
    .select('collected_at, value')
    .eq('platform', platform)
    .eq('metric', metric)
    .gte('collected_at', since.toISOString())
    .order('collected_at', { ascending: true });
  if (error) throw new Error(`funnel history ${platform}/${metric}: ${error.message}`);
  return (data || []).map((r) => ({
    date: new Date(r.collected_at).toISOString().slice(0, 10),
    value: Number(r.value),
  }));
}
