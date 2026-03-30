import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

export const ecosystemCommand = new Command('ecosystem')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--output <path>', 'Output file', 'ecosystem.config.js')
  .description('Generate PM2 ecosystem.config.js from agent configs')
  .action(async (options: { instance: string; output: string }) => {
    const ctxRoot = join(homedir(), '.cortextos', options.instance);
    const projectRoot = process.cwd();

    // Find all agents
    const agents: Array<{ name: string; dir: string; org?: string }> = [];

    // Scan orgs/*/agents/*
    const orgsDir = join(projectRoot, 'orgs');
    if (existsSync(orgsDir)) {
      for (const org of readdirSync(orgsDir, { withFileTypes: true })) {
        if (!org.isDirectory()) continue;
        const agentsDir = join(orgsDir, org.name, 'agents');
        if (!existsSync(agentsDir)) continue;
        for (const agent of readdirSync(agentsDir, { withFileTypes: true })) {
          if (!agent.isDirectory()) continue;
          agents.push({ name: agent.name, dir: join(agentsDir, agent.name), org: org.name });
        }
      }
    }

    if (agents.length === 0) {
      console.log('No agents found. Add agents first: cortextos add-agent <name>');
      return;
    }

    // Use dist/ in project root for all scripts
    const distDir = join(projectRoot, 'dist');

    // Generate ecosystem config with daemon
    const apps: Array<Record<string, unknown>> = [
      {
        name: 'cortextos-daemon',
        script: join(distDir, 'daemon.js'),
        args: `--instance ${options.instance}`,
        cwd: projectRoot,
        env: {
          CTX_INSTANCE_ID: options.instance,
          CTX_ROOT: ctxRoot,
          CTX_PROJECT_ROOT: projectRoot,
        },
        max_restarts: 10,
        restart_delay: 5000,
        autorestart: true,
      },
    ];

    // Note: agents are managed by the daemon, not PM2 directly.
    // The daemon discovers and spawns agents from orgs/*/agents/*/

    const ecosystem = { apps };

    const content = `module.exports = ${JSON.stringify(ecosystem, null, 2)};\n`;
    writeFileSync(options.output, content, 'utf-8');
    console.log(`Generated ${options.output} with daemon (manages ${agents.length} agents)`);
    console.log('\nStart with:');
    console.log(`  pm2 start ${options.output}`);
    console.log('  pm2 save');
  });
