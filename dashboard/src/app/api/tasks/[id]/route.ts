import { NextRequest } from 'next/server';
import { execSync } from 'child_process';
import { getTaskById } from '@/lib/data/tasks';
import { getFrameworkRoot, getCTXRoot } from '@/lib/config';
import { syncAll } from '@/lib/sync';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Shell escape helper
// ---------------------------------------------------------------------------

function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_STATUSES = ['pending', 'in_progress', 'blocked', 'completed'];
const VALID_PRIORITIES = ['urgent', 'high', 'normal', 'low'];

// Reject IDs that look like path traversal attempts
function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

// ---------------------------------------------------------------------------
// GET /api/tasks/[id] - Get a single task by ID
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  try {
    const task = getTaskById(id);
    if (!task) {
      return Response.json({ error: 'Task not found' }, { status: 404 });
    }
    return Response.json(task);
  } catch (err) {
    console.error('[api/tasks/[id]] GET error:', err);
    return Response.json({ error: 'Failed to fetch task' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/tasks/[id] - Delete a task
// ---------------------------------------------------------------------------

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  const task = getTaskById(id);
  if (!task) {
    return Response.json({ error: 'Task not found' }, { status: 404 });
  }

  // Delete the task file directly
  const fs = await import('fs/promises');
  const path = await import('path');
  const ctxRoot = getCTXRoot();
  const taskDir = task.org
    ? path.default.join(ctxRoot, 'orgs', task.org, 'tasks')
    : path.default.join(ctxRoot, 'tasks');
  const taskFile = path.default.join(taskDir, `${id}.json`);

  try {
    await fs.default.unlink(taskFile);
    try { syncAll(); } catch { /* best-effort */ }
    return Response.json({ success: true });
  } catch (err) {
    console.error('[api/tasks/[id]] DELETE error:', err);
    return Response.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PUT /api/tasks/[id] - Edit task fields (title, description, assignee, priority)
// ---------------------------------------------------------------------------

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  const task = getTaskById(id);
  if (!task) {
    return Response.json({ error: 'Task not found' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { title, description, assignee, priority } = body as {
    title?: string;
    description?: string;
    assignee?: string;
    priority?: string;
  };

  if (title !== undefined && (!title || title.trim().length === 0)) {
    return Response.json({ error: 'Title cannot be empty' }, { status: 400 });
  }
  if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) {
    return Response.json({ error: 'Invalid priority' }, { status: 400 });
  }

  // Read and update the task JSON file directly
  const fs = await import('fs/promises');
  const path = await import('path');
  const ctxRoot = getCTXRoot();
  const taskDir = task.org
    ? path.default.join(ctxRoot, 'orgs', task.org, 'tasks')
    : path.default.join(ctxRoot, 'tasks');
  const taskFile = path.default.join(taskDir, `${id}.json`);

  try {
    const raw = await fs.default.readFile(taskFile, 'utf-8');
    const taskData = JSON.parse(raw);

    const oldAssignee = taskData.assigned_to;
    if (title !== undefined) taskData.title = title.trim();
    if (description !== undefined) taskData.description = description;
    if (assignee !== undefined) taskData.assigned_to = assignee;
    if (priority !== undefined) taskData.priority = priority;
    taskData.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    const tmp = taskFile + '.tmp';
    await fs.default.writeFile(tmp, JSON.stringify(taskData, null, 2) + '\n');
    await fs.default.rename(tmp, taskFile);

    // Notify new assignee if changed
    if (assignee && assignee !== oldAssignee && assignee !== 'human' && assignee !== 'user') {
      try {
        const { execSync } = await import('child_process');
        execSync(
          `bash "${getFrameworkRoot()}/bus/send-message.sh" "${assignee}" normal 'Task reassigned to you: [${id}] ${taskData.title}'`,
          { timeout: 5000, stdio: 'pipe', env: { ...process.env, CTX_FRAMEWORK_ROOT: getFrameworkRoot(), CTX_ROOT: getCTXRoot(), CTX_AGENT_NAME: 'dashboard', CTX_ORG: task?.org || '' } }
        );
      } catch { /* non-fatal */ }
    }

    try { syncAll(); } catch { /* best-effort */ }
    return Response.json({ success: true });
  } catch (err) {
    console.error('[api/tasks/[id]] PUT error:', err);
    return Response.json({ error: 'Failed to update task' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/tasks/[id] - Update task status via bus scripts
//
// Body: { status, note?, blockedBy?, outputSummary? }
// - status=completed -> delegates to complete-task.sh
// - other statuses   -> delegates to update-task.sh
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { status, note, blockedBy, outputSummary } = body as {
    status?: string;
    note?: string;
    blockedBy?: string;
    outputSummary?: string;
  };

  if (!status || !VALID_STATUSES.includes(status)) {
    return Response.json(
      { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` },
      { status: 400 },
    );
  }

  // Look up task's org to pass CTX_ORG to bus script
  const task = getTaskById(id);

  const frameworkRoot = getFrameworkRoot();
  const env = {
    ...process.env,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_ROOT: getCTXRoot(),
    CTX_AGENT_NAME: 'dashboard',
    CTX_ORG: task?.org || '',
  };

  try {
    if (status === 'completed') {
      // Use complete-task.sh for completion (handles additional side effects)
      const summary = outputSummary
        ? `'${shellEscape(String(outputSummary).slice(0, 2000))}'`
        : "''";
      execSync(
        `bash '${shellEscape(frameworkRoot)}/bus/complete-task.sh' '${shellEscape(id)}' ${summary}`,
        { encoding: 'utf-8', timeout: 10000, env },
      );
    } else {
      // Use update-task.sh for other status changes
      const args = [shellEscape(id), shellEscape(status)];
      if (note) args.push(shellEscape(String(note).slice(0, 2000)));
      if (blockedBy) args.push(shellEscape(String(blockedBy)));

      execSync(
        `bash '${shellEscape(frameworkRoot)}/bus/update-task.sh' ${args.map((a) => `'${a}'`).join(' ')}`,
        { encoding: 'utf-8', timeout: 10000, env },
      );
    }

    // Trigger sync so subsequent reads reflect the update
    try {
      syncAll();
    } catch {
      // Sync is best-effort
    }

    return Response.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/tasks/[id]] PATCH error:', message);
    return Response.json(
      { error: 'Failed to update task', details: message },
      { status: 500 },
    );
  }
}
