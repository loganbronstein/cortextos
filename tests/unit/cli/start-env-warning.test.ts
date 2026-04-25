import { describe, it, expect } from 'vitest';
import { checkTelegramEnvCompleteness } from '../../../src/cli/start.js';

describe('checkTelegramEnvCompleteness', () => {
  it('does not warn when BOT_TOKEN is empty (Telegram intentionally off)', () => {
    const env = 'BOT_TOKEN=\nCHAT_ID=\nALLOWED_USER=\n';
    const r = checkTelegramEnvCompleteness(env);
    expect(r.warn).toBe(false);
    expect(r.missing).toEqual([]);
  });

  it('does not warn when BOT_TOKEN is absent entirely', () => {
    const env = '# notes\nCLAUDE_CODE_DISABLE_1M_CONTEXT=true\n';
    const r = checkTelegramEnvCompleteness(env);
    expect(r.warn).toBe(false);
  });

  it('does not warn when BOT_TOKEN + ALLOWED_USER + CHAT_ID are all set', () => {
    const env = 'BOT_TOKEN=123:abc\nCHAT_ID=456\nALLOWED_USER=789\n';
    expect(checkTelegramEnvCompleteness(env).warn).toBe(false);
  });

  it('warns when BOT_TOKEN set but ALLOWED_USER missing', () => {
    const env = 'BOT_TOKEN=123:abc\nCHAT_ID=456\n';
    const r = checkTelegramEnvCompleteness(env);
    expect(r.warn).toBe(true);
    expect(r.missing).toContain('ALLOWED_USER');
  });

  it('warns when BOT_TOKEN set but ALLOWED_USER empty', () => {
    const env = 'BOT_TOKEN=123:abc\nCHAT_ID=456\nALLOWED_USER=\n';
    const r = checkTelegramEnvCompleteness(env);
    expect(r.warn).toBe(true);
    expect(r.missing).toContain('ALLOWED_USER');
  });

  it('warns when BOT_TOKEN set but CHAT_ID missing', () => {
    const env = 'BOT_TOKEN=123:abc\nALLOWED_USER=789\n';
    const r = checkTelegramEnvCompleteness(env);
    expect(r.warn).toBe(true);
    expect(r.missing).toContain('CHAT_ID');
  });

  it('reports both fields missing when both are', () => {
    const env = 'BOT_TOKEN=123:abc\n';
    const r = checkTelegramEnvCompleteness(env);
    expect(r.warn).toBe(true);
    expect(r.missing).toContain('ALLOWED_USER');
    expect(r.missing).toContain('CHAT_ID');
  });

  it('treats whitespace-only values as empty', () => {
    const env = 'BOT_TOKEN=123:abc\nCHAT_ID=456\nALLOWED_USER=   \n';
    const r = checkTelegramEnvCompleteness(env);
    expect(r.warn).toBe(true);
    expect(r.missing).toContain('ALLOWED_USER');
  });
});
