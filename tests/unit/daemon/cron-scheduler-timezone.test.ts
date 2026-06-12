import { describe, it, expect, afterEach } from 'vitest';
import { nextFireInTimezone } from '../../../src/daemon/cron-scheduler';

describe('nextFireInTimezone — caller-TZ-independent fixed-expression next-fire', () => {
  const origTz = process.env.TZ;
  afterEach(() => {
    if (origTz === undefined) delete process.env.TZ; else process.env.TZ = origTz;
  });

  it('computes the org-zone next-fire even when the CALLER process is poisoned with TZ=UTC', () => {
    process.env.TZ = 'UTC';
    // 2026-06-12T12:00:00Z = 07:00 America/Chicago (CDT). "0 22 * * *" -> 22:00 CDT = 03:00Z next day.
    const ref = Date.UTC(2026, 5, 12, 12, 0, 0);
    const nf = nextFireInTimezone('0 22 * * *', ref, 'America/Chicago');
    expect(new Date(nf).toISOString()).toBe('2026-06-13T03:00:00.000Z');
    // And it must NOT leak the mutation — TZ restored to the caller's UTC.
    expect(process.env.TZ).toBe('UTC');
  });

  it('honours DST (local wall-clock, not a fixed offset): 8am Chicago is 14:00Z in winter, 13:00Z in summer', () => {
    process.env.TZ = 'UTC';
    // Winter (CST = UTC-6): ref 2026-01-15T12:00Z = 06:00 CST -> next "0 8" = 08:00 CST = 14:00Z.
    const winter = nextFireInTimezone('0 8 * * *', Date.UTC(2026, 0, 15, 12, 0, 0), 'America/Chicago');
    expect(new Date(winter).toISOString()).toBe('2026-01-15T14:00:00.000Z');
    // Summer (CDT = UTC-5): ref 2026-07-15T12:00Z = 07:00 CDT -> next "0 8" = 08:00 CDT = 13:00Z.
    const summer = nextFireInTimezone('0 8 * * *', Date.UTC(2026, 6, 15, 12, 0, 0), 'America/Chicago');
    expect(new Date(summer).toISOString()).toBe('2026-07-15T13:00:00.000Z');
    // Same local wall-clock hour, different UTC instant => proves DST-aware, not fixed offset.
    expect(winter).not.toBe(summer);
  });

  it('restores an UNSET TZ after the computation (delete, not empty string)', () => {
    delete process.env.TZ;
    nextFireInTimezone('0 8 * * *', Date.UTC(2026, 5, 12, 12, 0, 0), 'America/Chicago');
    expect('TZ' in process.env).toBe(false);
  });
});
