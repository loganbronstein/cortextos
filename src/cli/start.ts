import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { IPCClient } from '../daemon/ipc-server.js';

export const startCommand = new Command('start')
  .argument('[agent]', 'Specific agent to start (starts all if omitted)')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Start the daemon or a specific agent')
  .action(async (agent: string | undefined, options: { instance: string }) => {
    const ipc = new IPCClient(options.instance);
    const daemonRunning = await ipc.isDaemonRunning();

    if (!daemonRunning) {
      console.log('Starting cortextOS daemon...');
      console.log('');
      console.log('To start the daemon with PM2 for persistence:');
      console.log('');
      console.log('  pm2 start ecosystem.config.js');
      console.log('  pm2 save');
      console.log('');
      console.log('Or run directly (foreground):');
      console.log('');
      console.log('  node dist/daemon.js');
      console.log('');

      // For direct start without PM2, we could spawn the daemon here
      // but per D5, PM2 is the recommended approach
      return;
    }

    if (agent) {
      console.log(`Starting agent: ${agent}`);
      const response = await ipc.send({ type: 'start-agent', agent });
      if (response.success) {
        console.log(`  ${response.data}`);
      } else {
        console.error(`  Error: ${response.error}`);
      }
    } else {
      // Show status of all agents
      const response = await ipc.send({ type: 'status' });
      if (response.success) {
        const statuses = response.data as any[];
        if (statuses.length === 0) {
          console.log('No agents configured. Add one with: cortextos add-agent <name>');
        } else {
          console.log('Agent statuses:');
          for (const s of statuses) {
            console.log(`  ${s.name}: ${s.status} (pid: ${s.pid || '-'})`);
          }
        }
      }
    }
  });
