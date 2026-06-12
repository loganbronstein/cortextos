import { Command } from 'commander';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { IPCClient } from '../daemon/ipc-server.js';

export const restartCommand = new Command('restart')
  .argument('<agent>', 'Agent name to restart')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Restart a running agent atomically (re-reads config.json and .env, respawns the PTY, preserving the conversation). Does NOT restart the daemon process itself — use `pm2 restart cortextos-daemon` for that.')
  .action(async (agent: string, options: { instance: string }) => {
    const ipc = new IPCClient(options.instance);
    const daemonRunning = await ipc.isDaemonRunning();

    if (!daemonRunning) {
      console.error('Daemon is not running. Start it first: cortextos start');
      process.exit(1);
    }

    console.log(`Restarting agent: ${agent}`);

    // BUG-011 fix: a SINGLE atomic restart-agent IPC (not stop+start). The old
    // stop+start pair raced the daemon's auto-respawn and tripped the DEDUPED
    // guard, leaving the agent stopped. Write the .user-restart marker first so
    // the SessionEnd crash-alert hook classifies the imminent PTY exit as a
    // planned restart, not a 🚨 crash (BUG-036). intent=preserve keeps the
    // conversation (a stale/foreign .force-fresh is superseded, not honored).
    const stateDir = join(homedir(), '.cortextos', options.instance, 'state', agent);
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, '.user-restart'), 'restarted via cortextos restart\n', 'utf-8');
    } catch (err) {
      console.error(`  Warning: failed to write .user-restart marker: ${(err as Error).message}`);
    }

    const resp = await ipc.send({ type: 'restart-agent', agent, intent: 'preserve', source: 'cortextos restart' });
    if (!resp.success) {
      console.error(`  Restart failed: ${resp.error}`);
      console.error(`  Recover with: cortextos start ${agent}`);
      process.exit(1);
    }
    console.log(`  ${resp.data}`);
  });
