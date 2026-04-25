import { join } from 'path';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import type { CtxEnv, WorkerStatus, WorkerStatusValue } from '../types/index.js';
import { AgentPTY } from '../pty/agent-pty.js';
import { injectMessage } from '../pty/inject.js';

/**
 * WorkerProcess — ephemeral Claude Code session for parallelized tasks.
 *
 * Differences from AgentProcess:
 * - No crash recovery (exit = done, success or failure)
 * - No session timer (workers run until task is complete)
 * - No Telegram integration
 * - No fast-checker or inbox polling
 * - Working directory is the project dir, not the agent dir
 * - Status is exposed for IPC list-workers queries
 *
 * State machine:
 *   starting → running → completed (clean exit)
 *                      → failed     (non-zero exit)
 *                      → suspending → suspended (graceful pause via suspend())
 *
 * `suspended` is a deliberate-pause state: the PTY has exited but the
 * worker entry survives in the registry until `resume` re-spawns it. The
 * snapshot file at `snapshotPath` carries the handoff content the resumed
 * session reads first.
 */
export class WorkerProcess {
  readonly name: string;
  readonly dir: string;
  readonly parent: string | undefined;

  private pty: AgentPTY | null = null;
  private status: WorkerStatusValue = 'starting';
  private spawnedAt: string;
  private exitCode: number | undefined;
  private onDoneCallback: ((name: string, exitCode: number) => void) | null = null;
  private log: (msg: string) => void;
  private originalPrompt: string | undefined;
  private suspendedAt: string | undefined;
  private snapshotPath: string | undefined;
  private env: CtxEnv | null = null;

  constructor(
    name: string,
    dir: string,
    parent: string | undefined,
    log?: (msg: string) => void,
  ) {
    this.name = name;
    this.dir = dir;
    this.parent = parent;
    this.spawnedAt = new Date().toISOString();
    this.log = log || ((msg) => console.log(`[worker:${name}] ${msg}`));
  }

  /**
   * Spawn the worker Claude Code session with the given task prompt.
   */
  async spawn(env: CtxEnv, prompt: string): Promise<void> {
    // Ensure bus dirs exist so the worker can use cortextos bus commands
    try {
      mkdirSync(join(env.ctxRoot, 'inbox', this.name), { recursive: true });
      mkdirSync(join(env.ctxRoot, 'state', this.name), { recursive: true });
      mkdirSync(join(env.ctxRoot, 'logs', this.name), { recursive: true });
    } catch { /* ignore */ }

    const logPath = join(env.ctxRoot, 'logs', this.name, 'stdout.log');
    this.pty = new AgentPTY(env, {}, logPath);
    this.env = env;
    this.originalPrompt = prompt;

    this.pty.onExit((code) => {
      this.exitCode = code;
      // If we are mid-suspend (or already marked suspended), the exit IS
      // the suspend completing — keep the suspended status, do NOT fire
      // the onDone callback that would auto-cleanup the registry entry.
      if (this.status === 'suspending' || this.status === 'suspended') {
        this.status = 'suspended';
        this.log(`Exited with code ${code} (suspend complete)`);
        this.pty = null;
        return;
      }
      this.status = code === 0 ? 'completed' : 'failed';
      this.log(`Exited with code ${code} → ${this.status}`);
      if (this.onDoneCallback) {
        this.onDoneCallback(this.name, code);
      }
      this.pty = null;
    });

    await this.pty.spawn('fresh', prompt);
    this.status = 'running';
    this.log(`Running (pid: ${this.pty.getPid()}, dir: ${this.dir})`);
  }

  /**
   * Terminate the worker session.
   */
  async terminate(): Promise<void> {
    if (!this.pty) return;
    this.log('Terminating...');
    try {
      this.pty.write('\x03'); // Ctrl-C
      await sleep(500);
      this.pty.kill();
    } catch { /* ignore */ }
    this.status = 'completed';
    this.pty = null;
  }

  /**
   * Inject text into the worker's PTY (equivalent to tmux send-keys).
   * Use to nudge a stuck worker without restarting it.
   */
  inject(text: string): boolean {
    if (!this.pty || this.status !== 'running') return false;
    injectMessage((data) => this.pty!.write(data), text);
    return true;
  }

  /**
   * Suspend the worker — wait for next REPL idle (up to timeoutMs), write a
   * snapshot handoff doc, then terminate the PTY. Status transitions
   * `running → suspending → suspended`. The worker entry is intended to
   * survive in the registry until `resume()` re-spawns it.
   *
   * Returns the snapshot path and whether suspend completed via natural idle
   * or via timeout fallback. Idempotent for the already-suspended state
   * (returns the existing snapshot path).
   */
  async suspend(timeoutMs: number = 30_000): Promise<{ path: string; reason: 'idle' | 'timeout' }> {
    if (this.status === 'suspended') {
      return { path: this.snapshotPath || '', reason: 'idle' };
    }
    if (this.status === 'suspending') {
      throw new Error(`Worker "${this.name}" is already suspending`);
    }
    if (this.status !== 'running' || !this.pty || !this.env) {
      throw new Error(`Worker "${this.name}" is not in a suspendable state (status=${this.status})`);
    }

    this.status = 'suspending';
    const suspendStart = Date.now();
    const idleFlagPath = join(this.env.ctxRoot, 'state', this.name, 'last_idle.flag');
    const baselineIdle = readIdleFlagSeconds(idleFlagPath); // may be undefined

    this.log(`Suspending (waiting up to ${Math.round(timeoutMs / 1000)}s for idle)...`);

    // Poll the idle flag every 100ms.
    let reason: 'idle' | 'timeout' = 'timeout';
    while (Date.now() - suspendStart < timeoutMs) {
      const current = readIdleFlagSeconds(idleFlagPath);
      if (current !== undefined) {
        // Idle hit AFTER the suspend call started.
        const currentMs = current * 1000;
        if (currentMs >= suspendStart) {
          reason = 'idle';
          break;
        }
        // Or idle hit very recently relative to baseline (worker was idle
        // when suspend was called). Treat that as idle too.
        if (baselineIdle === undefined || current > baselineIdle) {
          reason = 'idle';
          break;
        }
      }
      await sleep(100);
    }

    // Build snapshot.
    this.suspendedAt = new Date().toISOString();
    const snapshotDir = join(this.env.ctxRoot, 'state', this.name, 'snapshots');
    try { mkdirSync(snapshotDir, { recursive: true }); } catch { /* ignore */ }
    const snapshotFile = join(
      snapshotDir,
      `suspend-${this.suspendedAt.replace(/[:.]/g, '-')}.md`,
    );
    const snapshotBody = buildSnapshot(this, reason);
    try {
      writeFileSync(snapshotFile, snapshotBody, 'utf-8');
      this.snapshotPath = snapshotFile;
    } catch (err) {
      this.log(`Snapshot write failed: ${(err as Error).message}`);
      // Continue with terminate even if snapshot write failed; resume will
      // still re-spawn from the original prompt.
    }

    // Terminate PTY.
    try {
      this.pty.write('\x03');
      await sleep(500);
      this.pty.kill();
    } catch { /* ignore */ }
    // Note: we do NOT null out pty here — onExit will do it. But we DO mark
    // ourselves suspended now so onExit's branch keeps the status correct
    // even if the kill takes a tick to land.
    this.status = 'suspended';

    this.log(`Suspended (reason: ${reason}, snapshot: ${this.snapshotPath || '<none>'})`);
    return { path: this.snapshotPath || '', reason };
  }

  /**
   * Get the original spawn prompt (for resume re-spawn).
   */
  getOriginalPrompt(): string | undefined {
    return this.originalPrompt;
  }

  /**
   * Get the snapshot path, if suspended.
   */
  getSnapshotPath(): string | undefined {
    return this.snapshotPath;
  }

  /**
   * Get current worker status snapshot.
   */
  getStatus(): WorkerStatus {
    return {
      name: this.name,
      status: this.status,
      pid: this.pty?.getPid() ?? undefined,
      dir: this.dir,
      parent: this.parent,
      spawnedAt: this.spawnedAt,
      exitCode: this.exitCode,
      suspendedAt: this.suspendedAt,
      snapshotPath: this.snapshotPath,
    };
  }

  isFinished(): boolean {
    return this.status === 'completed' || this.status === 'failed';
  }

  isSuspended(): boolean {
    return this.status === 'suspended';
  }

  /**
   * Register a callback that fires when the worker exits.
   */
  onDone(cb: (name: string, exitCode: number) => void): void {
    this.onDoneCallback = cb;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the idle-flag file as Unix seconds. Returns undefined if missing
 * or malformed. Tolerant: stat-then-read so a missing file is the silent
 * common case, not an error.
 */
function readIdleFlagSeconds(path: string): number | undefined {
  try {
    statSync(path);
  } catch {
    return undefined;
  }
  try {
    const raw = readFileSync(path, 'utf-8').trim();
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    return n;
  } catch {
    return undefined;
  }
}

function buildSnapshot(w: WorkerProcess, reason: 'idle' | 'timeout'): string {
  return [
    `# Worker suspend snapshot`,
    ``,
    `- Worker: ${w.name}`,
    `- Parent: ${w.parent ?? '(none)'}`,
    `- Working directory: ${w.dir}`,
    `- Suspended at: ${new Date().toISOString()}`,
    `- Suspend reason: ${reason}`,
    ``,
    `## Original task prompt`,
    ``,
    `\`\`\``,
    w.getOriginalPrompt() ?? '(unknown)',
    `\`\`\``,
    ``,
    `## Resume instructions`,
    ``,
    `This file is the handoff doc for the resumed session. When `,
    `\`cortextos resume-worker ${w.name}\` re-spawns this worker, the `,
    `new session reads this file first, runs \`git status\` to see what `,
    `already happened in the working directory, then continues the `,
    `original task. The original prompt above is the spec.`,
    ``,
  ].join('\n');
}
