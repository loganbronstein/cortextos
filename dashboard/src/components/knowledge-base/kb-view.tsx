'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface KnowledgeBaseViewProps {
  content: string;
  org: string;
  filePath: string;
}

function parseMarkdownSections(content: string): Array<{ title: string; body: string }> {
  const sections: Array<{ title: string; body: string }> = [];
  const lines = content.split('\n');
  let currentTitle = '';
  let currentBody: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentTitle || currentBody.length > 0) {
        sections.push({ title: currentTitle, body: currentBody.join('\n').trim() });
      }
      currentTitle = line.replace('## ', '');
      currentBody = [];
    } else if (!line.startsWith('# ') && line !== '---') {
      currentBody.push(line);
    }
  }

  if (currentTitle || currentBody.length > 0) {
    sections.push({ title: currentTitle, body: currentBody.join('\n').trim() });
  }

  return sections.filter((s) => s.title);
}

function renderMarkdownTable(text: string): React.ReactElement | null {
  const lines = text.split('\n').filter((l) => l.includes('|'));
  if (lines.length < 2) return null;

  const parseRow = (line: string) =>
    line.split('|').map((c) => c.trim()).filter(Boolean);

  const headers = parseRow(lines[0]);
  const dataRows = lines.slice(2).map(parseRow); // skip separator line

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} className="text-left p-2 border-b font-medium text-muted-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataRows.map((row, i) => (
            <tr key={i} className="border-b border-muted/50">
              {row.map((cell, j) => (
                <td key={j} className="p-2 text-sm">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionCard({ title, body }: { title: string; body: string }) {
  const hasTable = body.includes('|') && body.split('\n').filter((l) => l.includes('|')).length >= 3;
  const isFrequentlyWrong = title.toLowerCase().includes('frequently wrong');

  return (
    <Card className={isFrequentlyWrong ? 'border-amber-500/30' : ''}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          {isFrequentlyWrong && <span className="mr-2">!</span>}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {hasTable ? (
          renderMarkdownTable(body)
        ) : (
          <pre className="text-sm whitespace-pre-wrap font-sans text-muted-foreground leading-relaxed">
            {body}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

export function KnowledgeBaseView({ content, org, filePath }: KnowledgeBaseViewProps) {
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(content);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  if (!content) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-sm text-muted-foreground">
            No knowledge base found. Create{' '}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
              orgs/{org}/knowledge.md
            </code>{' '}
            to get started.
          </p>
        </CardContent>
      </Card>
    );
  }

  const sections = parseMarkdownSections(content);

  async function handleSave() {
    setSaving(true);
    setSaveError('');
    try {
      const res = await fetch('/api/knowledge', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org, content: editContent }),
      });
      if (!res.ok) {
        const data = await res.json();
        setSaveError(data.error || 'Failed to save');
      } else {
        setEditing(false);
        window.location.reload();
      }
    } catch (err) {
      setSaveError(String(err));
    }
    setSaving(false);
  }

  if (editing) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Edit Knowledge Base</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {saveError && (
            <p className="text-sm text-destructive mb-3">{saveError}</p>
          )}
          <textarea
            className="w-full h-[600px] p-4 rounded-md border bg-background font-mono text-sm resize-y"
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-xs text-muted-foreground">
          {filePath}
        </p>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          Edit
        </Button>
      </div>
      {sections.map((section, i) => (
        <SectionCard key={i} title={section.title} body={section.body} />
      ))}
    </div>
  );
}
