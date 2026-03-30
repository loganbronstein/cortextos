import { describe, it, expect } from 'vitest';
import {
  validateAgentName,
  validatePriority,
  validateEventCategory,
  validateEventSeverity,
  validateApprovalCategory,
  validateModel,
  isValidJson,
} from '../../../src/utils/validate';

describe('validateAgentName', () => {
  it('accepts valid names', () => {
    expect(() => validateAgentName('paul')).not.toThrow();
    expect(() => validateAgentName('boris-dev')).not.toThrow();
    expect(() => validateAgentName('agent_1')).not.toThrow();
    expect(() => validateAgentName('m2c1-worker')).not.toThrow();
  });

  it('rejects invalid names', () => {
    expect(() => validateAgentName('')).toThrow();
    expect(() => validateAgentName('Agent')).toThrow(); // uppercase
    expect(() => validateAgentName('agent name')).toThrow(); // space
    expect(() => validateAgentName('../traversal')).toThrow(); // path traversal
    expect(() => validateAgentName('agent/path')).toThrow(); // slash
  });
});

describe('validatePriority', () => {
  it('accepts valid priorities', () => {
    expect(() => validatePriority('urgent')).not.toThrow();
    expect(() => validatePriority('high')).not.toThrow();
    expect(() => validatePriority('normal')).not.toThrow();
    expect(() => validatePriority('low')).not.toThrow();
  });

  it('rejects invalid priorities', () => {
    expect(() => validatePriority('medium')).toThrow();
    expect(() => validatePriority('')).toThrow();
  });
});

describe('validateEventCategory', () => {
  it('accepts valid categories', () => {
    const valid = ['action', 'error', 'metric', 'milestone', 'heartbeat', 'message', 'task', 'approval'];
    for (const cat of valid) {
      expect(() => validateEventCategory(cat)).not.toThrow();
    }
  });

  it('rejects invalid categories', () => {
    expect(() => validateEventCategory('invalid')).toThrow();
  });
});

describe('validateEventSeverity', () => {
  it('accepts valid severities', () => {
    for (const sev of ['info', 'warning', 'error', 'critical']) {
      expect(() => validateEventSeverity(sev)).not.toThrow();
    }
  });
});

describe('validateApprovalCategory', () => {
  it('accepts valid categories', () => {
    for (const cat of ['external-comms', 'financial', 'deployment', 'data-deletion', 'other']) {
      expect(() => validateApprovalCategory(cat)).not.toThrow();
    }
  });
});

describe('validateModel', () => {
  it('accepts valid models', () => {
    expect(() => validateModel('claude-opus-4-5-20250514')).not.toThrow();
    expect(() => validateModel('claude-haiku-4-5-20251001')).not.toThrow();
  });

  it('rejects invalid models', () => {
    expect(() => validateModel('model; rm -rf /')).toThrow();
  });
});

describe('isValidJson', () => {
  it('detects valid JSON', () => {
    expect(isValidJson('{}')).toBe(true);
    expect(isValidJson('{"key":"value"}')).toBe(true);
    expect(isValidJson('[]')).toBe(true);
  });

  it('detects invalid JSON', () => {
    expect(isValidJson('')).toBe(false);
    expect(isValidJson('not json')).toBe(false);
    expect(isValidJson('{invalid}')).toBe(false);
  });
});
