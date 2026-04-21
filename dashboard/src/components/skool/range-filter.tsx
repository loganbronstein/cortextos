'use client';

import Link from 'next/link';
import { useSearchParams, usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const RANGES: Array<{ value: '7d' | '30d' | '90d' | 'all'; label: string }> = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
];

export function RangeFilter() {
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get('range') || '30d';

  return (
    <div className="inline-flex rounded-md border bg-card p-0.5 text-sm" data-testid="range-filter">
      {RANGES.map((r) => {
        const sp = new URLSearchParams(params.toString());
        sp.set('range', r.value);
        const href = `${pathname}?${sp.toString()}`;
        const active = current === r.value;
        return (
          <Link
            key={r.value}
            href={href}
            data-testid={`range-${r.value}`}
            data-active={active ? 'true' : 'false'}
            className={cn(
              'px-3 py-1 rounded-sm transition-colors',
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {r.label}
          </Link>
        );
      })}
    </div>
  );
}
