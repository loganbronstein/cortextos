import { NextRequest, NextResponse } from 'next/server';
import { listContextEntries, createContextEntry } from '@/lib/data/context-entries';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const entries = listContextEntries({
    author: url.searchParams.get('author') || undefined,
    agent: url.searchParams.get('agent') || undefined,
    tag: url.searchParams.get('tag') || undefined,
    search: url.searchParams.get('q') || undefined,
    limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
  });
  return NextResponse.json({ entries });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const author = typeof body.author === 'string' ? body.author.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const bodyText = typeof body.body === 'string' ? body.body.trim() : '';
  if (!author || !title || !bodyText) {
    return NextResponse.json({ error: 'author, title, and body are required' }, { status: 400 });
  }

  const entry = createContextEntry({
    author,
    agent: typeof body.agent === 'string' ? body.agent.trim() || null : null,
    topic_tags: typeof body.topic_tags === 'string' ? body.topic_tags : null,
    title,
    body: bodyText,
    references_json: body.references_json,
  });

  return NextResponse.json({ entry }, { status: 201 });
}
