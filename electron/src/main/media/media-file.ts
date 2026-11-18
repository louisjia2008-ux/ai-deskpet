import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { MEDIA_MAX_ASSET_BYTES } from '../../shared/media';

const MEDIA_PATH = /^reply-images\/([a-f0-9]{64})\.(png|jpg|gif|webp)$/u;
/** Exact hash filenames, bounded bytes, no links and content verification. This
 * intentionally also serves historical attachments after a soft deletion. */
export const readMediaProtocolFile = async (managedRoot: string, relativePath: string): Promise<{ bytes: Buffer; mime: string } | null> => {
  const match = MEDIA_PATH.exec(relativePath); if (!match) return null;
  const root = await realpath(managedRoot), directory = join(root, 'reply-images');
  const parent = await lstat(directory); if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('media.invalidStorage');
  const target = join(root, relativePath), info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MEDIA_MAX_ASSET_BYTES || relative(root, await realpath(target)) !== relativePath) throw new Error('media.storageMismatch');
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); let bytes: Buffer;
  try {
    const storage = Buffer.alloc(info.size + 1), part = await handle.read(storage, 0, storage.length, 0);
    if (part.bytesRead !== info.size) throw new Error('media.storageMismatch'); bytes = storage.subarray(0, part.bytesRead);
  } finally { await handle.close(); }
  if (createHash('sha256').update(bytes).digest('hex') !== match[1]) throw new Error('media.storageMismatch');
  const mime = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[match[2]!]!;
  return { bytes, mime };
};
