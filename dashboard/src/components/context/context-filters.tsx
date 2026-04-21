'use client';

import Link from 'next/link';
import { useSearchParams, usePathname } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { useState, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';

interface Props {
  authors: string[];
  agents: string[];
  tags: string[];
}

function Selector({ label, current, options, paramKey }: {
  label: string; current: string; options: string[]; paramKey: string;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const all = ['all', ...options];
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-xs text-muted-foreground mr-1">{label}:</span>
      {all.map((o) => {
        const sp = new URLSearchParams(params.toString());
        if (o === 'all') sp.delete(paramKey);
        else sp.set(paramKey, o);
        const active = (current === o) || (current === '' && o === 'all');
        return (
          <Link
            key={o}
            href={`${pathname}?${sp.toString()}`}
            data-testid={`ctx-filter-${paramKey}-${o}`}
            data-active={active ? 'true' : 'false'}
            className={cn(
              'text-xs px-2 py-0.5 rounded-sm border',
              active ? 'bg-primary text-primary-foreground border-primary' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o}
          </Link>
        );
      })}
    </div>
  );
}

export function ContextFilters({ authors, agents, tags }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  const [q, setQ] = useState(params.get('q') || '');
  useEffect(() => setQ(params.get('q') || ''), [params]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const sp = new URLSearchParams(params.toString());
    if (q.trim()) sp.set('q', q.trim()); else sp.delete('q');
    start(() => router.push(`${pathname}?${sp.toString()}`));
  }

  return (
    <div className="space-y-2" data-testid="context-filters">
      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <Input
          data-testid="ctx-search"
          className="max-w-sm"
          placeholder="Search title + body…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          type="submit"
          data-testid="ctx-search-submit"
          className="text-xs px-3 py-1 rounded border bg-primary text-primary-foreground disabled:opacity-50"
          disabled={pending}
        >
          {pending ? 'Searching…' : 'Search'}
        </button>
      </form>
      <Selector label="Author" current={params.get('author') || ''} options={authors} paramKey="author" />
      <Selector label="Agent" current={params.get('agent') || ''} options={agents} paramKey="agent" />
      {tags.length > 0 && (
        <Selector label="Tag" current={params.get('tag') || ''} options={tags} paramKey="tag" />
      )}
    </div>
  );
}
