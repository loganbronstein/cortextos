import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';
import { getFrameworkRoot, getCTXRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidName(name: string): boolean {
  return /^[a-z0-9_-]+$/.test(name);
}

const VALID_ACTIONS = ['enable', 'disable', 'restart'];

// Security (C4): Validate org and name against allowlist before use in shell commands or path.join.
function validateIdentifier(value: string | null | undefined, field: string): string {
  if (!value || !/^[a-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${field}: must match [a-z0-9_-]+`);
  }
  return value;
}

function getShellEnv() {
  const frameworkRoot = getFrameworkRoot();
  const ctxRoot = getCTXRoot();
  return {
    env: {
      ...process.env,
      CTX_FRAMEWORK_ROOT: frameworkRoot,
      CTX_ROOT: ctxRoot,
      PATH: process.env.PATH ?? '',
    },
    frameworkRoot,
    ctxRoot,
  };
}

// ---------------------------------------------------------------------------
// POST /api/agents/[name]/lifecycle - Enable, disable, or restart an agent
//
// Body: { action: "enable" | "disable" | "restart", org?: string, mode?: "continue" | "fresh" }
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);

  if (!isValidName(decoded)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { action, org } = body as {
    action?: string;
    org?: string;
  };

  if (!action || !VALID_ACTIONS.includes(action)) {
    return Response.json(
      { error: `action must be one of: ${VALID_ACTIONS.join(', ')}` },
      { status: 400 },
    );
  }

  // Security (C4): Validate org before use in shell commands.
  let safeOrg: string | undefined;
  if (org !== undefined) {
    try {
      safeOrg = validateIdentifier(org, 'org');
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 400 });
    }
  }

  const { env, frameworkRoot } = getShellEnv();
  const orgArgs = safeOrg ? ['--org', safeOrg] : [];

  let scriptArgs: string[];
  switch (action) {
    case 'enable':
      scriptArgs = [path.join(frameworkRoot, 'enable-agent.sh'), decoded, ...orgArgs];
      break;
    case 'disable':
      scriptArgs = [path.join(frameworkRoot, 'disable-agent.sh'), decoded, ...orgArgs];
      break;
    case 'restart':
      scriptArgs = [path.join(frameworkRoot, 'enable-agent.sh'), decoded, '--restart', ...orgArgs];
      break;
    default:
      return Response.json({ error: 'Invalid action' }, { status: 400 });
  }

  const result = spawnSync('bash', scriptArgs, {
    encoding: 'utf-8',
    timeout: 30000,
    env,
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    console.error(`[api/agents/${decoded}/lifecycle] POST error:`, stderr || result.stdout);
    return Response.json(
      { error: `Failed to ${action} agent`, stderr },
      { status: 500 },
    );
  }

  return Response.json({
    success: true,
    action,
    agent: decoded,
    output: result.stdout.trim(),
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/agents/[name]/lifecycle - Remove an agent entirely
//
// Query params: ?deleteFiles=true to also remove agent directory
// ---------------------------------------------------------------------------

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);

  if (!isValidName(decoded)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }

  const { env, frameworkRoot, ctxRoot } = getShellEnv();
  const enabledAgentsPath = path.join(ctxRoot, 'config', 'enabled-agents.json');
  const deleteFiles = request.nextUrl.searchParams.get('deleteFiles') === 'true';

  // Look up org from enabled-agents.json
  let org = '';
  let enabledAgents: Record<string, { org?: string; enabled?: boolean }> = {};
  try {
    const raw = await fs.readFile(enabledAgentsPath, 'utf-8');
    enabledAgents = JSON.parse(raw);
    if (enabledAgents[decoded]) {
      org = enabledAgents[decoded].org ?? '';
    }
  } catch {
    // File doesn't exist or is malformed
  }

  // Security (C4): Validate org from stored data before use in shell commands and path.join.
  let safeDeleteOrg = '';
  if (org) {
    try {
      safeDeleteOrg = validateIdentifier(org, 'org');
    } catch {
      // org stored in registry is malformed — skip shell/fs operations that use it
      safeDeleteOrg = '';
    }
  }

  // 1. Disable the agent first
  {
    const disableArgs = safeDeleteOrg ? [decoded, '--org', safeDeleteOrg] : [decoded];
    const disableResult = spawnSync(
      'bash',
      [path.join(frameworkRoot, 'disable-agent.sh'), ...disableArgs],
      { encoding: 'utf-8', timeout: 30000, env, stdio: 'pipe' },
    );
    if (disableResult.status !== 0) {
      // Log but continue - agent may already be disabled
      console.warn(`[api/agents/${decoded}/lifecycle] disable during delete:`, disableResult.stderr);
    }
  }

  // 2. Remove from enabled-agents.json
  try {
    delete enabledAgents[decoded];
    await fs.writeFile(
      enabledAgentsPath,
      JSON.stringify(enabledAgents, null, 2) + '\n',
      'utf-8',
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/agents/${decoded}/lifecycle] failed to update enabled-agents.json:`, message);
    return Response.json(
      { error: 'Failed to update agent registry', details: message },
      { status: 500 },
    );
  }

  // 3. Optionally remove agent directory
  if (deleteFiles && safeDeleteOrg) {
    try {
      const agentDir = path.join(frameworkRoot, 'orgs', safeDeleteOrg, 'agents', decoded);
      await fs.rm(agentDir, { recursive: true, force: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[api/agents/${decoded}/lifecycle] failed to remove agent dir:`, message);
      // Non-fatal - agent is already deregistered
    }
  }

  return Response.json({ success: true, deleted: decoded });
}
