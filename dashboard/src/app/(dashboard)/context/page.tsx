import {
  listContextEntries,
  getDistinctAuthors,
  getDistinctAgents,
  getDistinctTags,
} from '@/lib/data/context-entries';
import { ContextForm } from '@/components/context/context-form';
import { ContextList } from '@/components/context/context-list';
import { ContextFilters } from '@/components/context/context-filters';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function asStr(v: string | string[] | undefined): string | undefined {
  if (!v) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function ContextPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;

  const [entries, authors, agents, tags] = await Promise.all([
    Promise.resolve(listContextEntries({
      author: asStr(params.author),
      agent: asStr(params.agent),
      tag: asStr(params.tag),
      search: asStr(params.q),
    })),
    Promise.resolve(getDistinctAuthors()),
    Promise.resolve(getDistinctAgents()),
    Promise.resolve(getDistinctTags()),
  ]);

  return (
    <div className="space-y-5 p-6 max-w-[1000px] mx-auto" data-testid="context-page">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Context</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Decisions, notes, and insights worth keeping across sessions. Searchable, taggable, and filterable by agent or author.
        </p>
      </div>

      <ContextForm />

      <ContextFilters authors={authors} agents={agents} tags={tags} />

      <p className="text-xs text-muted-foreground" data-testid="ctx-count">
        {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
      </p>

      <ContextList entries={entries} />
    </div>
  );
}
