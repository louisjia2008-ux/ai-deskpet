import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const treeIdentity = async root => {
  const hash = createHash('sha256'); let bytes = 0, files = 0;
  const visit = async (directory, prefix = '') => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = `${prefix}${entry.name}`, path = join(directory, entry.name);
      if (entry.isDirectory()) { hash.update(JSON.stringify(['directory', name])); await visit(path, `${name}/`); }
      else if (entry.isFile()) {
        const data = await readFile(path); const info = await stat(path);
        hash.update(JSON.stringify(['file', name, info.mode & 0o777, createHash('sha256').update(data).digest('hex')]));
        bytes += data.length; files++;
      } else throw new Error('Minecraft staged dependencies must be regular files, not links or devices.');
    }
  };
  await visit(root);
  return { digest: hash.digest('hex'), bytes, files };
};

/** Move the reviewed Companion dependency tree within generated package staging. */
export const shareMinecraftDependencies = async root => {
  const staging = join(root, '.minecraft-package');
  const tree = join(staging, 'minecraft-companion-runtime', 'node_modules');
  if (!(await lstat(tree)).isDirectory()) throw new Error('Minecraft staged dependencies must be a real directory.');
  const dependencies = await treeIdentity(tree);
  if (dependencies.files === 0) throw new Error('Minecraft staged dependencies are empty.');
  const shared = join(staging, 'node_modules');
  await rm(shared, { recursive: true, force: true });
  await rename(tree, shared);
  return { sharedFiles: dependencies.files, sharedBytes: dependencies.bytes, dependencySHA256: dependencies.digest };
};
