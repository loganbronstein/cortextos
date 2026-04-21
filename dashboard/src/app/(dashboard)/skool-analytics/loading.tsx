export default function Loading() {
  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-6" data-testid="skool-analytics-loading">
      <div className="h-8 w-64 bg-muted animate-pulse rounded" />
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 bg-muted/40 animate-pulse rounded-lg" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="h-72 bg-muted/40 animate-pulse rounded-lg" />
        <div className="h-72 bg-muted/40 animate-pulse rounded-lg" />
      </div>
      <div className="h-96 bg-muted/40 animate-pulse rounded-lg" />
    </div>
  );
}
