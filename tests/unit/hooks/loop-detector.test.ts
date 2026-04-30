import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  HISTORY_SIZE,
  REPETITION_BLOCK,
  PINGPONG_WINDOW,
  PINGPONG_BLOCK,
  hashArgs,
  countRepetitions,
  detectPingPong,
  loadState,
  type ToolCallRecord,
} from '../../../src/hooks/hook-loop-detector';

describe('hook-loop-detector hashArgs', () => {
  it('returns empty string for nullish input', () => {
    expect(hashArgs(null)).toBe('');
    expect(hashArgs(undefined)).toBe('');
  });

  it('is order-independent for object keys', () => {
    const a = hashArgs({ file_path: '/tmp/foo', old_string: 'x', new_string: 'y' });
    const b = hashArgs({ new_string: 'y', old_string: 'x', file_path: '/tmp/foo' });
    expect(a).toBe(b);
  });

  it('preserves array order', () => {
    expect(hashArgs({ items: [1, 2, 3] })).not.toBe(hashArgs({ items: [3, 2, 1] }));
  });
});

describe('hook-loop-detector repetition detection', () => {
  const makeRecord = (toolName: string, argsHash: string): ToolCallRecord => ({
    toolName,
    argsHash,
    ts: Date.now(),
  });

  it('counts exact tool plus args matches', () => {
    const history = [
      makeRecord('Read', 'abc'),
      makeRecord('Read', 'abc'),
      makeRecord('Edit', 'abc'),
      makeRecord('Read', 'def'),
    ];
    expect(countRepetitions(history, 'Read', 'abc')).toBe(2);
  });

  it('keeps threshold reachable within history size', () => {
    expect(HISTORY_SIZE).toBeGreaterThanOrEqual(REPETITION_BLOCK);
  });
});

describe('hook-loop-detector ping-pong detection', () => {
  const makeRecord = (toolName: string): ToolCallRecord => ({
    toolName,
    argsHash: hashArgs({ tool: toolName }),
    ts: Date.now(),
  });

  it('ignores histories shorter than the window', () => {
    const short = Array.from({ length: PINGPONG_WINDOW - 1 }, () => makeRecord('Read'));
    expect(detectPingPong(short).count).toBe(0);
  });

  it('detects a clean alternating pair', () => {
    const alternating = Array.from({ length: HISTORY_SIZE }, (_, i) =>
      makeRecord(i % 2 === 0 ? 'Read' : 'Edit'),
    );
    const result = detectPingPong(alternating);
    expect(result.count).toBeGreaterThanOrEqual(PINGPONG_BLOCK);
    expect(result.tools).toContain('Read');
    expect(result.tools).toContain('Edit');
  });

  it('does not flag monotone single-tool history as ping-pong', () => {
    const monotone = Array.from({ length: PINGPONG_WINDOW }, () => makeRecord('Read'));
    expect(detectPingPong(monotone).count).toBe(0);
  });
});

describe('hook-loop-detector state loading', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loop-detector-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty history when state file does not exist', () => {
    expect(loadState(tmpDir).history).toEqual([]);
  });

  it('filters corrupt records on load', () => {
    writeFileSync(join(tmpDir, 'loop-detector.json'), JSON.stringify({
      history: [
        { toolName: 'Read', argsHash: 'abc', ts: 1000 },
        { toolName: null, argsHash: 'def', ts: 2000 },
        { toolName: 'Edit', argsHash: 789, ts: 3000 },
        { toolName: 'Bash', argsHash: 'xyz', ts: 5000 },
      ],
    }), 'utf-8');
    const state = loadState(tmpDir);
    expect(state.history).toHaveLength(2);
    expect(state.history.map(r => r.toolName)).toEqual(['Read', 'Bash']);
  });
});
