import { NextRequest } from 'next/server';
import fs from 'fs/promises';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/agents/[name]/memory?path=/absolute/path/to/file.md
// Returns the content of a memory file.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const filePath = searchParams.get('path');

  if (!filePath) {
    return Response.json({ error: 'path parameter required' }, { status: 400 });
  }

  // Basic path validation - must be a .md file
  if (!filePath.endsWith('.md')) {
    return Response.json({ error: 'Invalid file path' }, { status: 400 });
  }

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return new Response(content, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch {
    return new Response('', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
