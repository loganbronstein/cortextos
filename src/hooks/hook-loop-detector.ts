/**
 * hook-loop-detector.ts — PreToolUse hook.
 *
 * Detects and blocks repeated tool loops:
 * 1. Same tool and same args too many times.
 * 2. Two tools ping-ponging repeatedly.
 *
 * State: {ctxRoot}/state/{agentName}/loop-detector.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { readStdin, parseHookInput } from './index.js';

export const HISTORY_SIZE = 30;
export const REPETITION_BLOCK = 15;
export const PINGPONG_WINDOW = 12;
export const PINGPONG_BLOCK = 14;
export const PINGPONG_DOMINANCE = 0.8;

export interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  ts: number;
}

export interface LoopDetectorState {
  history: ToolCallRecord[];
}

function sortObjectKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  const obj = value as Record<string, unknown>;
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = sortObjectKeys(obj[k]);
      return acc;
    }, {});
}

export function hashArgs(toolInput: unknown): string {
  if (toolInput === null || toolInput === undefined) return '';
  try {
    const normalized = JSON.stringify(sortObjectKeys(toolInput));
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

function statePath(stateDir: string): string {
  return join(stateDir, 'loop-detector.json');
}

export function loadState(stateDir: string): LoopDetectorState {
  const p = statePath(stateDir);
  if (!existsSync(p)) return { history: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<LoopDetectorState>;
    const rawHistory = Array.isArray(parsed.history) ? parsed.history : [];
    const history: ToolCallRecord[] = rawHistory.filter(
      (r): r is ToolCallRecord =>
        r !== null &&
        typeof r === 'object' &&
        typeof (r as ToolCallRecord).toolName === 'string' &&
        typeof (r as ToolCallRecord).argsHash === 'string' &&
        typeof (r as ToolCallRecord).ts === 'number',
    );
    return { history };
  } catch {
    return { history: [] };
  }
}

function saveState(stateDir: string, state: LoopDetectorState): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(statePath(stateDir), JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch {
    // Best-effort; never break a hook.
  }
}

export function countRepetitions(
  history: ToolCallRecord[],
  toolName: string,
  argsHash: string,
): number {
  return history.filter(r => r.toolName === toolName && r.argsHash === argsHash).length;
}

export function detectPingPong(history: ToolCallRecord[]): {
  count: number;
  tools: [string, string] | null;
} {
  if (history.length < PINGPONG_WINDOW) return { count: 0, tools: null };

  const window = history.slice(-PINGPONG_WINDOW);
  const freq: Record<string, number> = {};
  for (const r of window) {
    freq[r.toolName] = (freq[r.toolName] ?? 0) + 1;
  }

  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  if (sorted.length < 2) return { count: 0, tools: null };

  const [topTool, topCount] = sorted[0];
  const [secondTool, secondCount] = sorted[1];
  const combinedFraction = (topCount + secondCount) / PINGPONG_WINDOW;
  if (combinedFraction < PINGPONG_DOMINANCE) return { count: 0, tools: null };

  const pairSet = new Set([topTool, secondTool]);
  const pairCalls = history.filter(r => pairSet.has(r.toolName));
  let alternations = 0;
  for (let i = 1; i < pairCalls.length; i += 1) {
    if (pairCalls[i].toolName !== pairCalls[i - 1].toolName) {
      alternations += 1;
    }
  }

  return {
    count: alternations,
    tools: [topTool, secondTool],
  };
}

function blockCall(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_name, tool_input } = parseHookInput(input);

  const agentName = process.env.CTX_AGENT_NAME || '';
  const ctxRoot = process.env.CTX_ROOT || join(homedir(), '.cortextos', 'default');
  const stateDir = join(ctxRoot, 'state', agentName);

  const state = loadState(stateDir);
  const argsHash = hashArgs(tool_input);
  state.history.push({ toolName: tool_name, argsHash, ts: Date.now() });
  if (state.history.length > HISTORY_SIZE) {
    state.history = state.history.slice(-HISTORY_SIZE);
  }
  saveState(stateDir, state);

  const reps = countRepetitions(state.history, tool_name, argsHash);
  if (reps >= REPETITION_BLOCK) {
    blockCall(
      `Tool loop detected: "${tool_name}" called ${reps} times with identical arguments in the last ${HISTORY_SIZE} calls. Stop repeating this action and try a fundamentally different approach.`,
    );
    return;
  }

  const pp = detectPingPong(state.history);
  if (pp.count >= PINGPONG_BLOCK && pp.tools) {
    blockCall(
      `Tool loop detected: "${pp.tools[0]}" and "${pp.tools[1]}" are alternating repeatedly (${pp.count} alternations in the last ${state.history.length} calls). Stop this back-and-forth pattern and try a fundamentally different approach.`,
    );
    return;
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
