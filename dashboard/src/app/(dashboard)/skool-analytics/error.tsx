'use client';

import { Button } from '@/components/ui/button';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="p-6 max-w-[1400px] mx-auto" data-testid="skool-analytics-error">
      <div className="rounded-lg border bg-destructive/10 p-6">
        <h2 className="text-lg font-semibold">Skool analytics unavailable</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {error.message || 'Could not reach Supabase. Confirm dashboard/.env.local has SUPABASE_URL and SUPABASE_SECRET_KEY set.'}
        </p>
        <Button className="mt-4" onClick={reset} variant="outline">
          Retry
        </Button>
      </div>
    </div>
  );
}
