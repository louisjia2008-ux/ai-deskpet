import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const identitySchema = z.object({ dev: z.number(), ino: z.number() }).strict();
export type FolderIdentity = z.infer<typeof identitySchema>;
const folderGrantSchema = identitySchema.extend({ name: z.string().nullable() });
export const DEFAULT_WRITE_FOLDER = '收集';
const defaultWriteGrant = { name: DEFAULT_WRITE_FOLDER, dev: null, ino: null } as const;
const writableFolderSchema = z.union([
  identitySchema.extend({ name: z.string() }),
  z.object({ name: z.literal(DEFAULT_WRITE_FOLDER), dev: z.null(), ino: z.null() }).strict(),
]);

export const folderPolicySchema = z.object({
  grantId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  shareable: z.array(folderGrantSchema),
  writable: z.array(writableFolderSchema).optional(),
}).strict();
export type FolderPolicy = z.infer<typeof folderPolicySchema>;

export function currentFolderPolicy(policy: FolderPolicy | undefined, grantId: string): FolderPolicy {
  return policy?.grantId === grantId ? policy : { grantId, revision: 0, shareable: [] };
}

export function isFolderName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.startsWith('.') &&
    !/[/\\\p{Cc}]/u.test(name) && !/^[a-z]:/iu.test(name);
}

export function noteFolder(path: string): string | null {
  const components = path.split('/');
  if (path.length > 1024 || !path.toLowerCase().endsWith('.md') || !components.every(isFolderName)) {
    throw new Error('knowledge.invalidPath');
  }
  return components.length === 1 ? null : components[0]!;
}

export function folderIdentity(root: string, name: string | null): FolderIdentity | undefined {
  if (name !== null && !isFolderName(name)) return undefined;
  const path = name === null ? root : join(root, name);
  try {
    const stat = lstatSync(path);
    // Require the actual spelling even on case-insensitive or normalizing volumes.
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(path) !== path) return undefined;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return undefined;
  }
}

export function pathMissing(path: string): boolean {
  try { return lstatSync(path, { throwIfNoEntry: false }) === undefined; }
  catch { return false; }
}

export function writableFolderGrant(root: string, name: string): z.infer<typeof writableFolderSchema> | undefined {
  const identity = folderIdentity(root, name);
  if (identity) return { name, ...identity };
  if (name === DEFAULT_WRITE_FOLDER && pathMissing(join(root, name))) return defaultWriteGrant;
  return undefined;
}

/** Null allows creation of the default directory; undefined denies the placement. */
export function writablePlacement(policy: FolderPolicy, root: string, name: string): FolderIdentity | null | undefined {
  const approved = (policy.writable ?? [defaultWriteGrant]).find(folder => folder.name === name);
  if (!approved) return undefined;
  const current = folderIdentity(root, name);
  if (approved.dev === null) return pathMissing(join(root, name)) ? null : undefined;
  return current?.dev === approved.dev && current.ino === approved.ino ? current : undefined;
}

export function isShareable(policy: FolderPolicy, root: string, name: string | null): boolean {
  const approved = policy.shareable.find(folder => folder.name === name);
  if (!approved) return false;
  const current = folderIdentity(root, name);
  return current?.dev === approved.dev && current.ino === approved.ino;
}
