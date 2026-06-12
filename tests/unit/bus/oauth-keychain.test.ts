import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock fetch (checkUsageApi calls the usage API) + child_process.execFileSync
// (the default Keychain reader). Other child_process exports are preserved.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  execFileSync: vi.fn(),
}));

const { execFileSync } = await import('child_process');
const mockExec = vi.mocked(execFileSync);
const { readKeychainOAuthToken, checkUsageApi } = await import('../../../src/bus/oauth.js');

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const KC_BLOB = (token: string) =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'r', expiresAt: Date.now() + FOUR_HOURS_MS } });

function authHeader(): string {
  return (mockFetch.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization;
}

// ---------------------------------------------------------------------------
// Unit: readKeychainOAuthToken (injectable platform + reader, fully deterministic)
// ---------------------------------------------------------------------------
describe('readKeychainOAuthToken', () => {
  it('extracts claudeAiOauth.accessToken from the Keychain blob on macOS', () => {
    expect(readKeychainOAuthToken('darwin', () => KC_BLOB('kc_tok_123'))).toBe('kc_tok_123');
  });

  it('returns undefined on non-macOS without invoking the reader', () => {
    const reader = vi.fn(() => KC_BLOB('kc_tok_123'));
    expect(readKeychainOAuthToken('linux', reader)).toBeUndefined();
    expect(reader).not.toHaveBeenCalled();
  });

  it('returns undefined when the security command fails (missing entry / error / timeout)', () => {
    expect(readKeychainOAuthToken('darwin', () => { throw new Error('not found'); })).toBeUndefined();
  });

  it('returns undefined for a malformed (non-JSON) blob', () => {
    expect(readKeychainOAuthToken('darwin', () => 'not json at all')).toBeUndefined();
  });

  it('returns undefined when claudeAiOauth.accessToken is absent / empty / non-string', () => {
    expect(readKeychainOAuthToken('darwin', () => JSON.stringify({ claudeAiOauth: {} }))).toBeUndefined();
    expect(readKeychainOAuthToken('darwin', () => JSON.stringify({ claudeAiOauth: { accessToken: '' } }))).toBeUndefined();
    expect(readKeychainOAuthToken('darwin', () => JSON.stringify({ claudeAiOauth: { accessToken: 42 } }))).toBeUndefined();
    expect(readKeychainOAuthToken('darwin', () => JSON.stringify({ somethingElse: true }))).toBeUndefined();
  });

  it('NEVER logs the token or the raw blob (secret redaction)', () => {
    const secret = 'kc_super_secret_token_value';
    const blob = KC_BLOB(secret);
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];
    try {
      // success path
      readKeychainOAuthToken('darwin', () => blob);
      // failure path
      readKeychainOAuthToken('darwin', () => { throw new Error(blob); });
      for (const s of spies) {
        for (const call of s.mock.calls) {
          const line = call.map(String).join(' ');
          expect(line).not.toContain(secret);
          expect(line).not.toContain(blob);
        }
      }
    } finally {
      spies.forEach(s => s.mockRestore());
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: checkUsageApi token precedence (accounts > env > keychain)
// ---------------------------------------------------------------------------
describe('checkUsageApi — Keychain fallback precedence', () => {
  let tmpDir: string;
  let savedEnv: string | undefined;
  let savedPlatform: PropertyDescriptor | undefined;

  function writeStore() {
    const dir = join(tmpDir, 'state', 'oauth');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'accounts.json'), JSON.stringify({
      active: 'primary',
      accounts: { primary: {
        label: 'P', access_token: 'tok_accounts', refresh_token: 'r',
        expires_at: Date.now() + FOUR_HOURS_MS, last_refreshed: '2026-01-01T00:00:00Z',
        five_hour_utilization: 0.1, seven_day_utilization: 0.1,
      } },
      rotation_log: [],
    }));
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'oauth-kc-'));
    mockFetch.mockReset();
    mockExec.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ five_hour_utilization: 0.5, seven_day_utilization: 0.2 }) });
    savedEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    // Force darwin so the Keychain branch is exercised deterministically on any host.
    savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
    if (savedEnv === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedEnv;
    if (savedPlatform) Object.defineProperty(process, 'platform', savedPlatform);
  });

  it('accounts.json wins over BOTH env and Keychain (precedence unchanged)', async () => {
    writeStore();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok_env';
    mockExec.mockReturnValue(KC_BLOB('tok_keychain'));
    await checkUsageApi(tmpDir, { force: true });
    expect(authHeader()).toBe('Bearer tok_accounts');
    expect(mockExec).not.toHaveBeenCalled(); // never reached the Keychain
  });

  it('env wins over Keychain when accounts.json is absent (precedence unchanged)', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok_env';
    mockExec.mockReturnValue(KC_BLOB('tok_keychain'));
    await checkUsageApi(tmpDir, { force: true });
    expect(authHeader()).toBe('Bearer tok_env');
    expect(mockExec).not.toHaveBeenCalled(); // env short-circuits before Keychain
  });

  it('falls back to the Keychain when accounts.json AND env are absent', async () => {
    mockExec.mockReturnValue(KC_BLOB('tok_keychain'));
    await checkUsageApi(tmpDir, { force: true });
    expect(authHeader()).toBe('Bearer tok_keychain');
    expect(mockExec).toHaveBeenCalledOnce();
  });

  it('throws the existing clear no-token error when the Keychain entry is missing', async () => {
    mockExec.mockImplementation(() => { throw new Error('security: SecKeychainSearchCopyNext: not found'); });
    await expect(checkUsageApi(tmpDir, { force: true }))
      .rejects.toThrow('No OAuth token available (no accounts.json and CLAUDE_CODE_OAUTH_TOKEN not set)');
  });

  it('throws the existing clear no-token error when the Keychain blob is malformed', async () => {
    mockExec.mockReturnValue('not a json blob');
    await expect(checkUsageApi(tmpDir, { force: true }))
      .rejects.toThrow('No OAuth token available (no accounts.json and CLAUDE_CODE_OAUTH_TOKEN not set)');
  });
});
