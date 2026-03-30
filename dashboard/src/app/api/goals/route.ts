import { NextRequest } from 'next/server';
import { getGoals } from '@/lib/data/goals';

export const dynamic = 'force-dynamic';

/**
 * GET /api/goals?org=<org>
 * Returns { bottleneck: string, goals: Goal[] } for the given org.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') || 'default';

  if (!/^[a-z0-9_-]+$/.test(org)) {
    return Response.json({ error: 'Invalid org' }, { status: 400 });
  }

  const data = getGoals(org);
  return Response.json(data);
}
