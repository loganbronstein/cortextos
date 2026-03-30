import { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '@/lib/db';
import type { User } from '@/lib/types';

export const dynamic = 'force-dynamic';

const JWT_SECRET = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || 'cortextos-mobile-jwt-secret';

/**
 * POST /api/auth/mobile - Mobile-friendly auth that returns JWT in response body
 *
 * Body: { username: string, password: string }
 * Returns: { token: string, user: { id: string, name: string } }
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { username, password } = body as { username?: string; password?: string };

  if (!username || !password) {
    return Response.json({ error: 'Username and password required' }, { status: 400 });
  }

  try {
    const user = db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username) as User | undefined;

    if (!user) {
      return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Generate JWT
    const token = jwt.sign(
      { sub: String(user.id), name: user.username },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    return Response.json({
      token,
      user: { id: String(user.id), name: user.username },
    });
  } catch (err) {
    console.error('[api/auth/mobile] Error:', err);
    return Response.json({ error: 'Authentication failed' }, { status: 500 });
  }
}
