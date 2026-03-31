// cortextOS Dashboard - Auth middleware
// Checks for next-auth session cookie; redirects to /login if missing.
// Cannot import auth.ts directly because it chains to better-sqlite3,
// which is not available in the Edge Runtime.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // Allow public paths
  // Security (H7): SSE endpoints require ?token=<jwt> auth — removed from public whitelist
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico'
  ) {
    const response = NextResponse.next();
    response.headers.set('Access-Control-Allow-Origin', '*');
    return response;
  }

  // Check for next-auth session token cookie (web dashboard)
  const hasSession =
    request.cookies.has('authjs.session-token') ||
    request.cookies.has('__Secure-authjs.session-token');

  // Check for Bearer token (mobile app)
  const authHeader = request.headers.get('Authorization');
  let hasBearerToken = false;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token.length > 0) {
      try {
        // Security (H6): Verify JWT signature — presence-only check bypassed by any string.
        const authSecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
        if (authSecret) {
          const secret = new TextEncoder().encode(authSecret);
          await jwtVerify(token, secret);
          hasBearerToken = true;
        }
      } catch {
        hasBearerToken = false;
      }
    }
  }

  if (!hasSession && !hasBearerToken) {
    // For API routes, return 401 instead of redirect
    if (pathname.startsWith('/api/')) {
      const res = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      res.headers.set('Access-Control-Allow-Origin', '*');
      return res;
    }
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  const response = NextResponse.next();
  response.headers.set('Access-Control-Allow-Origin', '*');
  return response;
}

export const config = {
  matcher: [
    // Match all routes except static files
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
