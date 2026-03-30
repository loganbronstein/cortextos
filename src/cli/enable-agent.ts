import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { IPCClient } from '../daemon/ipc-server.js';

function getEnabledAgentsPath(instanceId: string): string {
  return join(homedir(), '.cortextos', instanceId, 'config', 'enabled-agents.json');
}

function readEnabledAgents(instanceId: string): Record<string, any> {
  const path = getEnabledAgentsPath(instanceId);
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function writeEnabledAgents(instanceId: string, agents: Record<string, any>): void {
  const path = getEnabledAgentsPath(instanceId);
  const dir = join(homedir(), '.cortextos', instanceId, 'config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(agents, null, 2) + '\n', 'utf-8');
}

export const enableAgentCommand = new Command('enable')
  .argument('<agent>', 'Agent name to enable')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--org <org>', 'Organization name')
  .description('Enable an agent (register and start)')
  .action(async (agent: string, options: { instance: string; org?: string }) => {
    const agents = readEnabledAgents(options.instance);
    agents[agent] = {
      enabled: true,
      status: 'configured',
      ...(options.org ? { org: options.org } : {}),
    };
    writeEnabledAgents(options.instance, agents);

    // Create per-agent state directories
    const ctxRoot = join(homedir(), '.cortextos', options.instance);
    const agentDirs = [
      join(ctxRoot, 'inbox', agent),
      join(ctxRoot, 'inflight', agent),
      join(ctxRoot, 'processed', agent),
      join(ctxRoot, 'logs', agent),
      join(ctxRoot, 'state', agent),
    ];
    for (const dir of agentDirs) {
      mkdirSync(dir, { recursive: true });
    }

    console.log(`Agent "${agent}" enabled.`);

    // Try to start via daemon IPC
    const ipc = new IPCClient(options.instance);
    const running = await ipc.isDaemonRunning();
    if (running) {
      const response = await ipc.send({ type: 'start-agent', agent });
      if (response.success) {
        console.log(`  Started via daemon: ${response.data}`);
      }
    } else {
      console.log('  Daemon not running. Start with: cortextos start');
    }
  });

export const disableAgentCommand = new Command('disable')
  .argument('<agent>', 'Agent name to disable')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Disable an agent (stop and deregister)')
  .action(async (agent: string, options: { instance: string }) => {
    const agents = readEnabledAgents(options.instance);
    if (agents[agent]) {
      agents[agent].enabled = false;
    }
    writeEnabledAgents(options.instance, agents);

    // Try to stop via daemon IPC
    const ipc = new IPCClient(options.instance);
    const running = await ipc.isDaemonRunning();
    if (running) {
      const response = await ipc.send({ type: 'stop-agent', agent });
      if (response.success) {
        console.log(`Agent "${agent}" disabled and stopped.`);
      } else {
        console.log(`Agent "${agent}" disabled. Stop failed: ${response.error}`);
      }
    } else {
      console.log(`Agent "${agent}" disabled.`);
    }
  });
