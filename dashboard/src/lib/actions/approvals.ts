'use server';

import { execSync } from 'child_process';
import { revalidatePath } from 'next/cache';
import { getFrameworkRoot, getCTXRoot } from '@/lib/config';
import { syncAll } from '@/lib/sync';
import type { ActionResult } from '@/lib/types';

// ---------------------------------------------------------------------------
// Shell escape helper
// ---------------------------------------------------------------------------

function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''");
}

// ---------------------------------------------------------------------------
// Server Actions
// ---------------------------------------------------------------------------

/**
 * Resolve an approval by shelling out to bus/update-approval.sh.
 * Revalidates the approvals and overview pages after resolution.
 */
export async function resolveApproval(
  id: string,
  decision: 'approved' | 'rejected',
  note?: string,
): Promise<ActionResult> {
  // Validate inputs
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return { success: false, error: 'Invalid approval ID' };
  }

  if (!['approved', 'rejected'].includes(decision)) {
    return { success: false, error: 'Decision must be "approved" or "rejected"' };
  }

  if (note && note.length > 1000) {
    return { success: false, error: 'Note must be 1000 characters or fewer' };
  }

  const frameworkRoot = getFrameworkRoot();
  const env = {
    ...process.env,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_ROOT: getCTXRoot(),
    CTX_AGENT_NAME: 'dashboard',
  };

  const args = [shellEscape(id), decision];
  if (note) args.push(shellEscape(note));

  try {
    execSync(
      `bash '${shellEscape(frameworkRoot)}/bus/update-approval.sh' ${args.map((a) => `'${a}'`).join(' ')}`,
      { encoding: 'utf-8', timeout: 10000, env },
    );

    // Sync so SQLite reflects the change
    try {
      syncAll();
    } catch {
      // Sync is best-effort
    }

    // Revalidate pages that show approval data
    revalidatePath('/approvals');
    revalidatePath('/'); // Overview "Action Required" section

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[actions/approvals] resolveApproval error:', message);
    return { success: false, error: message };
  }
}
