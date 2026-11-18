/* global process */
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'minecraft-companion-runtime');
const target = join(root, '.minecraft-package', 'minecraft-companion-runtime');
const provenance = JSON.parse(await readFile(join(source, 'COMPANION_SOURCE.json'), 'utf8'));
const localFiles = provenance.local_files ?? {};
const localAdditions = provenance.local_additions ?? {};
for (const name of Object.keys(localFiles)) {
  if (!Object.hasOwn(provenance.files, name)) throw new Error('Minecraft Companion local override is not in the reviewed source: ' + name);
}
for (const name of Object.keys(localAdditions)) {
  if (!/^core\/(?:[\w-]+\/)*[\w-]+\.js$/u.test(name) || Object.hasOwn(provenance.files, name)) {
    throw new Error('Minecraft Companion local addition has an invalid or overlapping path: ' + name);
  }
}
for (const [name, upstream] of Object.entries({ ...provenance.files, ...localAdditions })) {
  const expected = localFiles[name] ?? upstream;
  if (createHash('sha256').update(await readFile(join(source, name))).digest('hex') !== expected) {
    throw new Error('Minecraft Companion production source differs from its pinned hash: ' + name);
  }
}
const runtimeRequire = createRequire(join(source, 'package.json'));
for (const name of ['mineflayer', 'mineflayer-pathfinder', 'vec3']) runtimeRequire.resolve(name);
await stat(join(source, 'core-host.js'));
await rm(target, { recursive: true, force: true });
await mkdir(dirname(target), { recursive: true });
await cp(source, target, {
  recursive: true,
  dereference: true,
  filter: path => {
    const parts = relative(source, path).split(sep);
    return !parts.some(part => ['.git', '.ralph', '.cache', '.DS_Store', '.bin', 'test', 'tests', 'test-support', '__tests__'].includes(part))
      && !/\.(?:test|spec)\.[cm]?js$/u.test(parts.at(-1) ?? '');
  },
});
process.stdout.write('Pinned Minecraft Companion core prepared separately from the legacy runtime.\n');
