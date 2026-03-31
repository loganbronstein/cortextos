// Security (H11): In-memory rate limiter for auth endpoints.
interface Entry { count: number; resetAt: number; }
const store = new Map<string, Entry>();
const MAX = 5, WINDOW = 15 * 60 * 1000;

export function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const e = store.get(ip);
  if (!e || now > e.resetAt) {
    store.set(ip, { count: 1, resetAt: now + WINDOW });
    return { allowed: true };
  }
  if (e.count >= MAX) return { allowed: false, retryAfter: Math.ceil((e.resetAt - now) / 1000) };
  e.count++;
  return { allowed: true };
}

export function resetRateLimit(ip: string) { store.delete(ip); }
