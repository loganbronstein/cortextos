import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';

export interface ContextEntry {
  id: string;
  created_at: string;
  author: string;
  agent: string | null;
  topic_tags: string | null;
  title: string;
  body: string;
  references_json: string | null;
}

export interface ContextFilters {
  author?: string;
  agent?: string;
  tag?: string;
  search?: string;
  limit?: number;
}

export function listContextEntries(filters: ContextFilters = {}): ContextEntry[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.author && filters.author !== 'all') {
    where.push('author = @author');
    params.author = filters.author;
  }
  if (filters.agent && filters.agent !== 'all') {
    where.push('agent = @agent');
    params.agent = filters.agent;
  }
  if (filters.tag && filters.tag !== 'all') {
    where.push("(',' || topic_tags || ',') LIKE @tag");
    params.tag = `%,${filters.tag},%`;
  }
  if (filters.search) {
    where.push('(title LIKE @q OR body LIKE @q)');
    params.q = `%${filters.search}%`;
  }

  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  const sql = `SELECT * FROM context_entries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ${limit}`;
  return db.prepare(sql).all(params) as ContextEntry[];
}

export function getDistinctAuthors(): string[] {
  return (db.prepare('SELECT DISTINCT author FROM context_entries WHERE author IS NOT NULL ORDER BY author').all() as Array<{ author: string }>)
    .map((r) => r.author);
}

export function getDistinctAgents(): string[] {
  return (db.prepare("SELECT DISTINCT agent FROM context_entries WHERE agent IS NOT NULL AND agent != '' ORDER BY agent").all() as Array<{ agent: string }>)
    .map((r) => r.agent);
}

export function getDistinctTags(): string[] {
  const rows = db.prepare('SELECT topic_tags FROM context_entries WHERE topic_tags IS NOT NULL').all() as Array<{ topic_tags: string }>;
  const set = new Set<string>();
  for (const r of rows) {
    for (const t of (r.topic_tags || '').split(',').map((s) => s.trim()).filter(Boolean)) set.add(t);
  }
  return Array.from(set).sort();
}

export function createContextEntry(input: {
  author: string;
  agent?: string | null;
  topic_tags?: string | null;
  title: string;
  body: string;
  references_json?: unknown;
}): ContextEntry {
  const id = randomUUID();
  const tags = (input.topic_tags || '').split(',').map((s) => s.trim()).filter(Boolean).join(',');
  const refs = input.references_json ? JSON.stringify(input.references_json) : null;
  db.prepare(`
    INSERT INTO context_entries (id, author, agent, topic_tags, title, body, references_json)
    VALUES (@id, @author, @agent, @topic_tags, @title, @body, @references_json)
  `).run({
    id,
    author: input.author,
    agent: input.agent ?? null,
    topic_tags: tags || null,
    title: input.title,
    body: input.body,
    references_json: refs,
  });
  return db.prepare('SELECT * FROM context_entries WHERE id = ?').get(id) as ContextEntry;
}
