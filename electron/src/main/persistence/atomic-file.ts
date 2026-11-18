import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const atomicWriteFile = async (path: string, data: string | Uint8Array, options: { createDirectory?: boolean } = {}): Promise<void> => {
  const directory = dirname(path);
  if (options.createDirectory !== false) await mkdir(directory, { recursive: true, mode: 0o700 });

  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }

  try {
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    // Directory fsync is unavailable on some supported filesystems and Windows.
  }
};

const TEMPORARY_NAME = /^\.(.+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;

/** A kill during a write leaves its temporary file behind. Rename is atomic, so
 * none of them is ever the live copy; the age check spares a write in progress. */
export const removeAbandonedTemporaryFiles = async (path: string, olderThanMs = 60 * 60_000, now = Date.now()): Promise<number> => {
  const directory = dirname(path);
  let removed = 0;
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (TEMPORARY_NAME.exec(name)?.[1] !== basename(path)) continue;
    const candidate = join(directory, name);
    try {
      if (now - (await stat(candidate)).mtimeMs < olderThanMs) continue;
      await rm(candidate, { force: true }); removed += 1;
    } catch { /* A file that cannot be examined stays until a later start. */ }
  }
  return removed;
};
