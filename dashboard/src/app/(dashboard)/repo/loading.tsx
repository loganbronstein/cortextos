export default function Loading() {
  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-5" data-testid="repo-loading">
      <div className="h-8 w-48 bg-muted animate-pulse rounded" />
      <div className="h-72 bg-muted/40 animate-pulse rounded-lg" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="h-72 bg-muted/40 animate-pulse rounded-lg" />
        <div className="h-72 bg-muted/40 animate-pulse rounded-lg" />
      </div>
    </div>
  );
}
