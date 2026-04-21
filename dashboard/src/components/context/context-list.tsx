import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { ContextEntry } from '@/lib/data/context-entries';

function fmtWhen(iso: string) {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function ContextList({ entries }: { entries: ContextEntry[] }) {
  if (entries.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground" data-testid="ctx-empty">
          No context entries yet. Use the form above to add the first one.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid="context-list">
      {entries.map((e) => {
        const tags = (e.topic_tags || '').split(',').map((t) => t.trim()).filter(Boolean);
        return (
          <Card key={e.id} data-testid="ctx-entry">
            <CardContent className="p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">{e.title}</h3>
                <span className="text-xs text-muted-foreground tabular-nums">{fmtWhen(e.created_at)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <Badge variant="secondary">by {e.author}</Badge>
                {e.agent && <Badge variant="outline">about: {e.agent}</Badge>}
                {tags.map((t) => (
                  <Badge key={t} variant="outline" className="text-[11px]">{t}</Badge>
                ))}
              </div>
              <p className="text-sm whitespace-pre-wrap leading-relaxed">{e.body}</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
