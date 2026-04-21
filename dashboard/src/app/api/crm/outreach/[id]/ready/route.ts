import { NextRequest, NextResponse } from 'next/server';
import { markOutreachReady } from '@/lib/data/skool';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'missing id' }, { status: 400 });
  }
  try {
    const flipped = await markOutreachReady(id);
    if (!flipped) {
      return NextResponse.json(
        { error: 'row not found or not in scheduled state (already ready / sent / etc.)' },
        { status: 409 },
      );
    }
    return NextResponse.json({ id, status: 'ready' });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
