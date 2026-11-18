import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, linkSync, lstatSync, openSync, readSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { KnowledgeDiaryCopy, KnowledgeDiarySync } from '../../shared/knowledge';
import { WorkspaceAccess } from '../tools/workspace';
import { folderIdentity, isFolderName, pathMissing, type FolderIdentity } from './vault-folders';

const date = z.iso.date();
const folder = z.string().refine(isFolderName);
const identity = z.object({ dev: z.number(), ino: z.number() }).strict();
const temporaryName = /^\.deskpet-diary-[a-f0-9-]{36}\.md$/u;
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const copySchema = z.object({
  date,
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  dev: z.number(),
  ino: z.number(),
  parent: identity,
  retainedInvalid: z.boolean(),
  removed: z.literal(true).optional(),
  temporary: z.string().regex(temporaryName).optional(),
}).strict().refine(copy => {
  const parts = copy.path.split('/');
  return parts.length === 2 && isFolderName(parts[0]!) && parts[1] === copy.date + '.md';
});

export const diarySyncSchema = z.object({
  enabled: z.boolean(),
  folder,
  target: identity.optional(),
  copies: z.array(copySchema),
}).strict();
export type DiarySyncState = z.infer<typeof diarySyncSchema>;
export type TrackedDiaryCopy = z.infer<typeof copySchema>;
type Root = FolderIdentity & { path: string };

const material = z.object({ date, createdAt: z.iso.datetime(), text: z.string().trim().min(1).max(6000) });
const diaryContent = (entry: KnowledgeDiaryCopy): string => `---\ncreated: ${entry.createdAt}\nby: deskpet\nkind: diary\n---\n\n${entry.text}`;
const parentName = (copy: TrackedDiaryCopy): string => copy.path.split('/')[0]!;
const normalizedName = (value: string): string => value.normalize('NFC').toLowerCase();
const sameIdentity = (one: FolderIdentity | undefined, other: FolderIdentity | undefined): boolean =>
  !!one && !!other && one.dev === other.dev && one.ino === other.ino;
const identityKey = (value: FolderIdentity): string => `${value.dev}:${value.ino}`;
const MAX_BYTES = 32_768;

export function diarySettings(state: DiarySyncState): KnowledgeDiarySync {
  return { enabled: state.enabled, folder: state.folder };
}

/** A folder is still protected after disabling sync or changing targets. Its
 * original name and pinned identity cover aliases and top-level renames. */
export function isDiaryFolderProtected(state: DiarySyncState | undefined, root: string, name: string): boolean {
  if (!state) return false;
  const present = state.copies.filter(copy => !copy.removed);
  const normalized = normalizedName(name);
  if ((state.enabled && normalizedName(state.folder) === normalized)
    || present.some(copy => normalizedName(parentName(copy)) === normalized)) return true;
  const current = folderIdentity(root, name);
  return (state.enabled && sameIdentity(current, state.target)) || present.some(copy => sameIdentity(current, copy.parent));
}

/** Also protect individual diary files moved to a different folder. Matching
 * the previously exported digest catches an exact copy with a new inode. */
export function diaryFileBarrier(state: DiarySyncState | undefined, root: string): (path: string, digest?: string) => boolean {
  if (!state?.copies.length) return () => false;
  const inodes = new Set(state.copies.filter(copy => !copy.removed).map(identityKey));
  const digests = new Set(state.copies.map(copy => copy.sha256));
  return (path, digest) => {
    if (digest && digests.has(digest)) return true;
    if (!inodes.size) return false;
    try {
      const entry = lstatSync(join(root, path), { throwIfNoEntry: false });
      return !!entry && inodes.has(identityKey(entry));
    } catch {
      // An unverified path is never needed for a remote tool result.
      return true;
    }
  };
}

type FileFingerprint = FolderIdentity & { sha256: string; size: number; mtimeMs: number; ctimeMs: number };

/** Compare a bounded descriptor read with its path before and after reading. */
function fileFingerprint(path: string): FileFingerprint | 'missing' | 'changed' {
  try {
    const before = lstatSync(path, { throwIfNoEntry: false });
    if (!before) return 'missing';
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES) return 'changed';
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_BYTES || !sameIdentity(opened, before)) return 'changed';
      const bytes = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = readSync(descriptor, bytes, length, bytes.length - length, length);
        if (read === 0) break;
        length += read;
      }
      const after = fstatSync(descriptor);
      const located = lstatSync(path, { throwIfNoEntry: false });
      if (length !== opened.size || after.nlink !== 1 || !sameIdentity(located, opened)
        || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) return 'changed';
      return { dev: opened.dev, ino: opened.ino, size: opened.size, mtimeMs: opened.mtimeMs, ctimeMs: opened.ctimeMs,
        sha256: sha256(bytes.subarray(0, length)) };
    } finally { closeSync(descriptor); }
  } catch {
    return 'changed';
  }
}

function sameCopyAt(root: Root, path: string, copy: TrackedDiaryCopy): FileFingerprint | 'missing' | 'changed' {
  const name = parentName(copy);
  if (!sameIdentity(folderIdentity(root.path, name), copy.parent)) return pathMissing(join(root.path, name)) ? 'missing' : 'changed';
  const fingerprint = fileFingerprint(path);
  if (typeof fingerprint === 'string') return fingerprint;
  return sameIdentity(copy, fingerprint) && copy.sha256 === fingerprint.sha256 ? fingerprint : 'changed';
}

function assertPlacement(root: Root, name: string, expected: FolderIdentity, authorize: () => void): void {
  authorize();
  if (!sameIdentity(folderIdentity(root.path, null), root)) throw new Error('knowledge.rootChanged');
  if (!sameIdentity(folderIdentity(root.path, name), expected)) throw new Error('knowledge.diaryFolderInvalid');
}

export async function stageDiaryCopy(root: Root, config: DiarySyncState, entry: KnowledgeDiaryCopy,
  authorize: () => void): Promise<TrackedDiaryCopy | null> {
  if (!config.target || !material.safeParse(entry).success) throw new Error('knowledge.diarySyncFailed');
  const expected = config.target;
  const assert = () => assertPlacement(root, config.folder, expected, authorize);
  assert();
  const path = `${config.folder}/${entry.date}.md`;
  if (!pathMissing(join(root.path, path))) return null;
  const temporary = '.deskpet-diary-' + randomUUID() + '.md';
  const content = diaryContent(entry);
  const destination = `${config.folder}/${temporary}`;
  await new WorkspaceAccess(root.path, root).writeHostMarkdown(destination, content, assert);
  assert();
  const actual = fileFingerprint(join(root.path, destination));
  if (typeof actual === 'string' || actual.sha256 !== sha256(content)) throw new Error('knowledge.diarySyncFailed');
  return { date: entry.date, path, sha256: actual.sha256, dev: actual.dev, ino: actual.ino,
    parent: expected, retainedInvalid: false, temporary };
}

/** The identity receipt must already be durable before this no-clobber link. */
export function publishDiaryCopy(root: Root, copy: TrackedDiaryCopy, entry: KnowledgeDiaryCopy, authorize: () => void): boolean {
  if (!copy.temporary || copy.sha256 !== sha256(diaryContent(entry))) return false;
  const name = parentName(copy);
  const staged = join(root.path, name, copy.temporary);
  const target = join(root.path, copy.path);
  assertPlacement(root, name, copy.parent, authorize);
  if (typeof sameCopyAt(root, staged, copy) === 'string' || !pathMissing(target)) return false;
  assertPlacement(root, name, copy.parent, authorize);
  try {
    linkSync(staged, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  return true;
}

/** Clean a stage by checking its identity before removal. A stage may have one
 * extra link to the final note if the process died just after publication. */
export function removeDiaryStage(root: Root, copy: TrackedDiaryCopy, authorize: () => void): boolean {
  if (!copy.temporary) return true;
  const name = parentName(copy);
  authorize();
  if (!sameIdentity(folderIdentity(root.path, null), root)) throw new Error('knowledge.rootChanged');
  if (!sameIdentity(folderIdentity(root.path, name), copy.parent)) return false;
  const staged = join(root.path, name, copy.temporary);
  const parked = lstatSync(staged, { throwIfNoEntry: false });
  if (!parked) return true;
  if (!parked.isFile() || !sameIdentity(parked, copy)) return false;
  const target = lstatSync(join(root.path, copy.path), { throwIfNoEntry: false });
  if (parked.nlink > 1 && !(parked.nlink === 2 && target?.isFile() && sameIdentity(target, copy))) return false;
  if (parked.nlink === 1 && typeof sameCopyAt(root, staged, copy) === 'string') return false;
  assertPlacement(root, name, copy.parent, authorize);
  unlinkSync(staged);
  return true;
}

/** Remove an exact untouched copy. Any changed inode, contents or path is
 * retained. There are no awaits between verification and the unlink. */
export function revokeDiaryCopy(root: Root, copy: TrackedDiaryCopy, authorize: () => void): 'removed' | 'missing' | 'changed' {
  authorize();
  if (!sameIdentity(folderIdentity(root.path, null), root)) throw new Error('knowledge.rootChanged');
  const name = parentName(copy);
  if (!sameIdentity(folderIdentity(root.path, name), copy.parent)) return pathMissing(join(root.path, name)) ? 'missing' : 'changed';
  assertPlacement(root, name, copy.parent, authorize);
  const path = join(root.path, copy.path);
  const match = sameCopyAt(root, path, copy);
  if (typeof match === 'string') return match;
  assertPlacement(root, name, copy.parent, () => undefined);
  const last = lstatSync(path, { throwIfNoEntry: false });
  if (!last) return 'missing';
  if (!last.isFile() || last.nlink !== 1 || !sameIdentity(last, copy) || last.size !== match.size
    || last.mtimeMs !== match.mtimeMs || last.ctimeMs !== match.ctimeMs) return 'changed';
  unlinkSync(path);
  return 'removed';
}
