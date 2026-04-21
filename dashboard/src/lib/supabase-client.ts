// Server-side Supabase client for the skoolio "agent architects" project.
// Uses the secret service-role key (bypasses RLS) — NEVER import this from a
// client component. Always behind a Next.js server component or route handler.

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function getSkoolSupabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SECRET_KEY must be set in dashboard .env.local for the Skool analytics page to work',
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
