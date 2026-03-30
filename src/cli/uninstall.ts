import { Command } from 'commander';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const uninstallCommand = new Command('uninstall')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--force', 'Skip confirmation')
  .option('--keep-state', 'Remove agent config but preserve state directory (logs, tasks, heartbeats)')
  .description('Remove cortextOS state directories and PM2 processes')
  .action(async (options: { instance: string; force?: boolean; keepState?: boolean }) => {
    const instanceId = options.instance;
    const ctxRoot = join(homedir(), '.cortextos', instanceId);

    if (!existsSync(ctxRoot)) {
      console.log(`No cortextOS state found at ${ctxRoot}`);
      return;
    }

    console.log(`\nUninstalling cortextOS instance: ${instanceId}`);
    console.log(`  State directory: ${ctxRoot}`);
    if (options.keepState) {
      console.log('  Mode: --keep-state (preserving state directory, removing agent config only)\n');
    } else {
      console.log('');
    }

    // Stop PM2 processes if pm2 is available
    try {
      const { execSync } = require('child_process');
      const pm2List = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
      const processes = JSON.parse(pm2List);
      const cortextosProcesses = processes.filter((p: { name: string }) =>
        p.name.startsWith('cortextos-') || p.name.startsWith(`ctx-${instanceId}`),
      );
      for (const p of cortextosProcesses) {
        try {
          execSync(`pm2 delete ${p.name} 2>/dev/null`, { timeout: 5000 });
          console.log(`  Stopped PM2 process: ${p.name}`);
        } catch { /* ignore */ }
      }
    } catch {
      // PM2 not available, skip
    }

    if (options.keepState) {
      // --keep-state: remove only enabled-agents config, preserve all state data
      const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
      if (existsSync(enabledFile)) {
        try {
          rmSync(enabledFile);
          console.log('  Removed enabled-agents.json');
        } catch { /* ignore */ }
      }
      console.log('  Preserved state directory (logs, tasks, heartbeats, analytics)');
    } else {
      // Full uninstall: remove entire state directory
      try {
        rmSync(ctxRoot, { recursive: true, force: true });
        console.log(`  Removed state directory: ${ctxRoot}`);
      } catch (err) {
        console.error(`  Failed to remove ${ctxRoot}: ${err}`);
      }
    }

    // Remove ecosystem.config.js if exists in current directory
    const ecosystemPath = join(process.cwd(), 'ecosystem.config.js');
    if (existsSync(ecosystemPath)) {
      try {
        rmSync(ecosystemPath);
        console.log('  Removed ecosystem.config.js');
      } catch { /* ignore */ }
    }

    console.log('\n  cortextOS uninstalled.');
  });
