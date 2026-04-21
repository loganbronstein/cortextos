'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function ContextForm({ defaultAuthor }: { defaultAuthor?: string }) {
  const router = useRouter();
  const [author, setAuthor] = useState(defaultAuthor || 'james');
  const [agent, setAgent] = useState('');
  const [tags, setTags] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch('/api/context', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          author: author.trim(),
          agent: agent.trim() || null,
          topic_tags: tags.trim() || null,
          title: title.trim(),
          body: body.trim(),
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || `status ${r.status}`);
      }
      setTitle('');
      setBody('');
      setTags('');
      setAgent('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to save');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card data-testid="context-form">
      <CardHeader>
        <CardTitle>New context entry</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Author</label>
              <Input data-testid="ctx-author" value={author} onChange={(e) => setAuthor(e.target.value)} required />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Agent (optional)</label>
              <Input data-testid="ctx-agent" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="paul, nick, skoolio..." />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Topic tags (comma separated)</label>
              <Input data-testid="ctx-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="pricing, skool, churn" />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Title</label>
            <Input data-testid="ctx-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Body</label>
            <textarea
              data-testid="ctx-body"
              className="flex min-h-[140px] w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              required
            />
          </div>

          <div className="flex items-center gap-3">
            <Button type="submit" data-testid="ctx-submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save entry'}
            </Button>
            {error && <span className="text-sm text-destructive" data-testid="ctx-error">{error}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
