import { Command } from 'commander';
import { resolve } from 'path';
import { resolveEnv } from '../utils/env.js';
import { IPCClient } from '../daemon/ipc-server.js';

export const spawnWorkerCommand = new Command('spawn-worker')
  .description('Spawn an ephemeral worker Claude Code session for a parallelized task')
  .argument('<name>', 'Worker name (used for bus identity)')
  .requiredOption('--dir <path>', 'Working directory for the worker session')
  .requiredOption('--prompt <text>', 'Task prompt to inject at session start')
  .option('--parent <agent>', 'Parent agent name (for bus reply routing)')
  .option('--model <model>', 'Claude model to use (defaults to org default)')
  .action(async (name: string, opts: { dir: string; prompt: string; parent?: string; model?: string }) => {
    const env = resolveEnv();
    const client = new IPCClient(env.instanceId);
    const dir = resolve(opts.dir);

    const response = await client.send({
      type: 'spawn-worker',
      data: { name, dir, prompt: opts.prompt, parent: opts.parent, model: opts.model },
    });

    if (response.success) {
      console.log(`Worker "${name}" spawning in ${dir}`);
      console.log(`Monitor: cortextos list-workers`);
      console.log(`Inject:  cortextos inject-worker ${name} "<text>"`);
      console.log(`Stop:    cortextos terminate-worker ${name}`);
    } else {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }
  });

export const terminateWorkerCommand = new Command('terminate-worker')
  .description('Terminate a running worker session')
  .argument('<name>', 'Worker name')
  .action(async (name: string) => {
    const env = resolveEnv();
    const client = new IPCClient(env.instanceId);

    const response = await client.send({
      type: 'terminate-worker',
      data: { name },
    });

    if (response.success) {
      console.log(`Worker "${name}" terminating`);
    } else {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }
  });

export const listWorkersCommand = new Command('list-workers')
  .description('List active and recently completed worker sessions')
  .action(async () => {
    const env = resolveEnv();
    const client = new IPCClient(env.instanceId);

    const response = await client.send({ type: 'list-workers' });

    if (!response.success) {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }

    const workers = response.data as Array<{
      name: string; status: string; pid?: number; dir: string;
      parent?: string; spawnedAt: string; exitCode?: number;
    }>;

    if (!workers || workers.length === 0) {
      console.log('No active workers');
      return;
    }

    for (const w of workers) {
      const pid = w.pid ? ` (pid ${w.pid})` : '';
      const parent = w.parent ? ` ← ${w.parent}` : '';
      const exit = w.exitCode !== undefined ? ` exit=${w.exitCode}` : '';
      const age = Math.round((Date.now() - new Date(w.spawnedAt).getTime()) / 1000);
      console.log(`${w.name}  ${w.status}${pid}${exit}${parent}  ${age}s  ${w.dir}`);
    }
  });

export const injectWorkerCommand = new Command('inject-worker')
  .description('Inject text into a running worker session (nudge / stuck-state recovery)')
  .argument('<name>', 'Worker name')
  .argument('<text>', 'Text to inject into the worker PTY')
  .action(async (name: string, text: string) => {
    const env = resolveEnv();
    const client = new IPCClient(env.instanceId);

    const response = await client.send({
      type: 'inject-worker',
      data: { name, text },
    });

    if (response.success) {
      console.log(`Injected into worker "${name}"`);
    } else {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }
  });

export const suspendWorkerCommand = new Command('suspend-worker')
  .description('Gracefully suspend a worker — wait for next REPL idle (up to --timeout), snapshot state, terminate the PTY. Resume later with `cortextos resume-worker <name>`. Unlike inject-worker, this is a real control signal: a worker mid-tool-call WILL be stopped (after the in-flight call finishes idling, or after the timeout falls through to a hard kill).')
  .argument('<name>', 'Worker name')
  .option('--timeout <s>', 'Max seconds to wait for next idle before forcing the kill', '30')
  .action(async (name: string, opts: { timeout: string }) => {
    const env = resolveEnv();
    const client = new IPCClient(env.instanceId);

    const timeoutSec = Number(opts.timeout);
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > 600) {
      console.error('Error: --timeout must be a number between 1 and 600 seconds');
      process.exit(1);
    }

    const response = await client.send({
      type: 'suspend-worker',
      data: { name, timeoutMs: Math.round(timeoutSec * 1000) },
    });

    if (response.success) {
      const data = response.data as { snapshotPath: string; reason: 'idle' | 'timeout' };
      console.log(`Worker "${name}" suspended (reason: ${data.reason})`);
      if (data.snapshotPath) {
        console.log(`Snapshot: ${data.snapshotPath}`);
      }
      console.log(`Resume:   cortextos resume-worker ${name}`);
    } else {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }
  });

export const resumeWorkerCommand = new Command('resume-worker')
  .description('Resume a previously-suspended worker — re-spawns the session with a handoff prompt pointing at the snapshot. The resumed worker reads the snapshot first, runs `git status` to see what already happened, then continues the original task.')
  .argument('<name>', 'Worker name')
  .action(async (name: string) => {
    const env = resolveEnv();
    const client = new IPCClient(env.instanceId);

    const response = await client.send({
      type: 'resume-worker',
      data: { name },
    });

    if (response.success) {
      console.log(`Worker "${name}" resuming`);
    } else {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }
  });

export const listSuspendedWorkersCommand = new Command('list-suspended-workers')
  .description('List workers currently in the suspended state (persisted across daemon restarts)')
  .action(async () => {
    const env = resolveEnv();
    const client = new IPCClient(env.instanceId);

    const response = await client.send({ type: 'list-suspended-workers' });
    if (!response.success) {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }

    const records = response.data as Array<{
      name: string; dir: string; parent?: string; snapshotPath: string;
      suspendedAt: string; reason: 'idle' | 'timeout';
    }>;

    if (!records || records.length === 0) {
      console.log('No suspended workers');
      return;
    }

    for (const r of records) {
      const age = Math.round((Date.now() - new Date(r.suspendedAt).getTime()) / 1000);
      const parent = r.parent ? ` ← ${r.parent}` : '';
      console.log(`${r.name}  suspended (${r.reason})${parent}  ${age}s ago`);
      console.log(`  dir:      ${r.dir}`);
      console.log(`  snapshot: ${r.snapshotPath}`);
    }
  });
