'use client';

import { Button } from '@/components/ui/button';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="p-6 max-w-[1400px] mx-auto" data-testid="repo-error">
      <div className="rounded-lg border bg-destructive/10 p-6 space-y-3">
        <h2 className="text-lg font-semibold">Repo view unavailable</h2>
        <p className="text-sm text-muted-foreground">{error.message || 'GitHub API unreachable.'}</p>
        <p className="text-xs text-muted-foreground">
          Confirm GITHUB_TOKEN is set in dashboard/.env.local and has repo read access.
        </p>
        <Button onClick={reset} variant="outline" size="sm">Retry</Button>
      </div>
    </div>
  );
}
