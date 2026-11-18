import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { shareMinecraftDependencies } from './minecraft-shared-dependencies.mjs';

const names = ['minecraft-runtime', 'minecraft-companion-runtime'];
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-shared-deps-'));
  for (const name of names) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
      '': { name, license: name === names[0] ? 'MIT' : 'AGPL-3.0-only', dependencies: { 'deskpet-shared-fixture': '1.0.0' }, engines: { node: '>=22' } },
      'node_modules/deskpet-shared-fixture': { version: '1.0.0', integrity: 'fixture' },
    } }));
    const engine = join(root, '.minecraft-package', name);
    await mkdir(join(engine, 'node_modules', 'deskpet-shared-fixture'), { recursive: true });
    await writeFile(join(engine, 'node_modules', 'deskpet-shared-fixture', 'index.js'), 'module.exports = "shared";');
    await writeFile(join(engine, 'index.js'), `module.exports = [${JSON.stringify(name)}, require('deskpet-shared-fixture')];`);
  }
  return root;
};

test('shares exact dependencies with normal Node resolution while keeping engine code separate', async () => {
  const root = await fixture();
  try {
    const result = await shareMinecraftDependencies(root);
    assert.equal(result.sharedFiles, 1); assert.ok(result.savedBytes > 0);
    const require = createRequire(join(root, 'check.cjs'));
    for (const name of names) {
      const engine = join(root, '.minecraft-package', name);
      assert.deepEqual(require(join(engine, 'index.js')), [name, 'shared']);
      await assert.rejects(stat(join(engine, 'node_modules')), { code: 'ENOENT' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mismatch of ['lock', 'bytes']) test(`refuses ${mismatch} mismatches without deleting either tree`, async () => {
  const root = await fixture();
  try {
    const tree = join(root, '.minecraft-package', names[1], 'node_modules');
    const file = mismatch === 'lock' ? join(root, names[1], 'package-lock.json') : join(tree, 'deskpet-shared-fixture', 'index.js');
    if (mismatch === 'lock') {
      const lock = JSON.parse(await readFile(file, 'utf8')); lock.packages['node_modules/deskpet-shared-fixture'].integrity = 'changed';
      await writeFile(file, JSON.stringify(lock));
    } else await writeFile(file, 'module.exports = "changed";');
    await assert.rejects(shareMinecraftDependencies(root), /differ/);
    for (const name of names) assert.ok((await stat(join(root, '.minecraft-package', name, 'node_modules'))).isDirectory());
  } finally { await rm(root, { recursive: true, force: true }); }
});
