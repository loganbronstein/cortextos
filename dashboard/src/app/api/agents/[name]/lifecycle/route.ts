import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { getFrameworkRoot, getCTXRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''");
}

function isValidName(name: string): boolean {
  return /^[a-z0-9_-]+$/.test(name);
}

const VALID_ACTIONS = ['enable', 'disable', 'restart'];

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

  const { env, frameworkRoot } = getShellEnv();
  const escapedName = shellEscape(decoded);
  const orgFlag = org ? ` --org '${shellEscape(org)}'` : '';

  let cmd: string;
  switch (action) {
    case 'enable':
      cmd = `bash '${shellEscape(frameworkRoot)}/enable-agent.sh' '${escapedName}'${orgFlag}`;
      break;
    case 'disable':
      cmd = `bash '${shellEscape(frameworkRoot)}/disable-agent.sh' '${escapedName}'${orgFlag}`;
      break;
    case 'restart':
      cmd = `bash '${shellEscape(frameworkRoot)}/enable-agent.sh' '${escapedName}' --restart${orgFlag}`;
      break;
    default:
      return Response.json({ error: 'Invalid action' }, { status: 400 });
  }

  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30000,
      env,
    });

    return Response.json({
      success: true,
      action,
      agent: decoded,
      output: stdout.trim(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Try to extract stderr from ExecException
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr)
        : undefined;

    console.error(`[api/agents/${decoded}/lifecycle] POST error:`, message);
    return Response.json(
      {
        error: `Failed to ${action} agent`,
        details: message,
        stderr: stderr?.trim(),
      },
      { status: 500 },
    );
  }
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

  // 1. Disable the agent first
  try {
    const orgFlag = org ? ` --org '${shellEscape(org)}'` : '';
    execSync(
      `bash '${shellEscape(frameworkRoot)}/disable-agent.sh' '${shellEscape(decoded)}'${orgFlag}`,
      { encoding: 'utf-8', timeout: 30000, env },
    );
  } catch (err: unknown) {
    // Log but continue - agent may already be disabled
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[api/agents/${decoded}/lifecycle] disable during delete:`, message);
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
  if (deleteFiles && org) {
    try {
      const agentDir = path.join(frameworkRoot, 'orgs', org, 'agents', decoded);
      await fs.rm(agentDir, { recursive: true, force: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[api/agents/${decoded}/lifecycle] failed to remove agent dir:`, message);
      // Non-fatal - agent is already deregistered
    }
  }

  return Response.json({ success: true, deleted: decoded });
}
