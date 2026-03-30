import { NextRequest } from 'next/server';
import { execSync } from 'child_process';
import { getTasks } from '@/lib/data/tasks';
import { getFrameworkRoot, getCTXRoot, getOrgs } from '@/lib/config';
import { syncAll } from '@/lib/sync';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Shell escape helper - prevents injection in execSync calls
// ---------------------------------------------------------------------------

function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''");
}

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

const VALID_STATUSES = ['pending', 'in_progress', 'blocked', 'completed'];
const VALID_PRIORITIES = ['urgent', 'high', 'normal', 'low'];

// ---------------------------------------------------------------------------
// GET /api/tasks - List tasks with optional filters
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const filters = {
    org: searchParams.get('org') || undefined,
    agent: searchParams.get('agent') || undefined,
    priority: searchParams.get('priority') || undefined,
    status: searchParams.get('status') || undefined,
    project: searchParams.get('project') || undefined,
    search: searchParams.get('search') || undefined,
  };

  try {
    const tasks = getTasks(filters);
    return Response.json(tasks);
  } catch (err) {
    console.error('[api/tasks] GET error:', err);
    return Response.json({ error: 'Failed to fetch tasks' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/tasks - Create a new task via bus/create-task.sh
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { title, description, assignee, priority, project, needsApproval } =
    body as {
      title?: string;
      description?: string;
      assignee?: string;
      priority?: string;
      project?: string;
      needsApproval?: boolean;
    };

  // Validate required fields
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return Response.json({ error: 'Title is required' }, { status: 400 });
  }
  if (title.length > 500) {
    return Response.json(
      { error: 'Title must be 500 characters or fewer' },
      { status: 400 },
    );
  }
  if (priority && !VALID_PRIORITIES.includes(priority)) {
    return Response.json(
      { error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` },
      { status: 400 },
    );
  }

  // Use org from request body or first available org
  const org = (body.org as string) || getOrgs()[0] || '';

  const frameworkRoot = getFrameworkRoot();
  const env = {
    ...process.env,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_ROOT: getCTXRoot(),
    CTX_AGENT_NAME: 'dashboard',
    CTX_ORG: org,
  };

  // Build the command arguments (positional: title, description, assignee, priority, project)
  // Must pass empty strings for skipped args to keep positions aligned
  const safeTitle = shellEscape(title.trim());
  const safeDesc = shellEscape(description ? String(description).slice(0, 2000) : '');
  const safeAssignee = shellEscape(assignee ? String(assignee) : '');
  const safePriority = shellEscape(priority || 'normal');
  const safeProject = shellEscape(project ? String(project) : '');

  let cmd = `bash '${shellEscape(frameworkRoot)}/bus/create-task.sh' '${safeTitle}' '${safeDesc}' '${safeAssignee}' '${safePriority}' '${safeProject}'`;
  if (needsApproval) cmd += ' --needs-approval';

  try {
    const result = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 10000,
      env,
    });

    // Trigger sync so subsequent reads reflect the new task
    try {
      syncAll();
    } catch {
      // Sync is best-effort
    }

    return Response.json(
      { success: true, taskId: result.trim() },
      { status: 201 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/tasks] POST error:', message);
    return Response.json(
      { error: 'Failed to create task', details: message },
      { status: 500 },
    );
  }
}
