import { writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Atomically write data to a file by writing to a temp file first,
 * then renaming. Rename is atomic on the same filesystem.
 * Matches the bash pattern: printf > .tmp.file && mv .tmp.file file
 */
export function atomicWriteSync(filePath: string, data: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp.${process.pid}.${Date.now()}`);
  try {
    writeFileSync(tmpPath, data + '\n', 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      const { unlinkSync } = require('fs');
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}
