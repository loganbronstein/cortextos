import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getCTXRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * POST /api/messages/upload
 * Upload a media file (image, audio, document) and deliver it to an agent's inbox.
 *
 * Form fields:
 *   agent   - target agent name
 *   type    - 'photo' | 'voice' | 'document' | 'video'
 *   caption - optional text caption
 *   file    - the file to upload (multipart)
 */
export async function POST(request: NextRequest) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: 'Invalid multipart form data' }, { status: 400 });
  }

  const agent = formData.get('agent') as string;
  const type = (formData.get('type') as string) || 'photo';
  const caption = (formData.get('caption') as string) || '';
  const file = formData.get('file') as File | null;

  if (!agent || !/^[a-z0-9_-]+$/.test(agent)) {
    return Response.json({ error: 'agent is required' }, { status: 400 });
  }
  if (!file) {
    return Response.json({ error: 'file is required' }, { status: 400 });
  }

  const ctxRoot = getCTXRoot();

  // Save uploaded file to media directory
  const mediaDir = path.join(ctxRoot, 'media', agent);
  fs.mkdirSync(mediaDir, { recursive: true });

  const ext = file.name ? path.extname(file.name) : '';
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`;
  const localPath = path.join(mediaDir, filename);

  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(localPath, buffer);

  // Write to agent inbox as a media message
  const epochMs = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  const from = 'mobile-user';
  const messageId = `${epochMs}-${from}-${rand}`;
  const inboxFilename = `2-${epochMs}-from-${from}-${rand}.json`;

  const inboxDir = path.join(ctxRoot, 'inbox', agent);
  fs.mkdirSync(inboxDir, { recursive: true });

  // Build a descriptive text for the agent to understand what was sent
  const typeLabel = type === 'photo' ? 'photo' : type === 'voice' ? 'voice message' : type === 'video' ? 'video' : 'document';
  const text = caption
    ? `[${typeLabel}: ${file.name || filename}]\n${caption}`
    : `[${typeLabel}: ${file.name || filename}]`;

  const inboxMessage = {
    id: messageId,
    from,
    to: agent,
    priority: 'normal',
    timestamp: new Date().toISOString(),
    text,
    type,
    local_file: localPath,
    file_name: file.name || filename,
    reply_to: null,
  };

  const tmpPath = path.join(inboxDir, `.tmp.${inboxFilename}`);
  const finalPath = path.join(inboxDir, inboxFilename);
  fs.writeFileSync(tmpPath, JSON.stringify(inboxMessage) + '\n');
  fs.renameSync(tmpPath, finalPath);

  // Wake fast-checker
  const pidFile = path.join(ctxRoot, 'state', agent, '.fast-checker.pid');
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pid > 0) process.kill(pid, 'SIGUSR1');
    } catch { /* ignore */ }
  }

  // Log to inbound-messages.jsonl
  const logDir = path.join(ctxRoot, 'logs', agent);
  fs.mkdirSync(logDir, { recursive: true });
  const logEntry = JSON.stringify({
    id: messageId,
    timestamp: new Date().toISOString(),
    agent,
    direction: 'inbound',
    type,
    text,
    local_file: localPath,
    file_name: file.name || filename,
    source: 'mobile',
  });
  fs.appendFileSync(path.join(logDir, 'inbound-messages.jsonl'), logEntry + '\n');

  return Response.json({
    success: true,
    messageId,
    mediaUrl: `/api/media/${path.relative(ctxRoot, localPath)}`,
  });
}
