import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { shareMinecraftDependencies } from './minecraft-shared-dependencies.mjs';

const fixture = async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-shared-deps-'));
  test.after(() => rm(root, { recursive: true, force: true }));
  const staging = join(root, '.minecraft-package');
  const engine = join(staging, 'minecraft-companion-runtime');
  const stagedDependencies = join(engine, 'node_modules');
  const dependency = join(stagedDependencies, 'deskpet-shared-fixture');
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, 'index.js'), 'module.exports = "shared";');
  await writeFile(join(engine, 'index.js'), 'module.exports = require("deskpet-shared-fixture");');
  return { root, staging, engine, stagedDependencies, dependency };
};

test('moves Companion dependencies into the shared staging tree with normal Node resolution', async (test) => {
  const { root, staging, engine, stagedDependencies } = await fixture(test);
  const shared = join(staging, 'node_modules');
  await mkdir(shared);
  await writeFile(join(shared, 'stale-file'), 'old dependency');
  const result = await shareMinecraftDependencies(root);
  assert.equal(result.sharedFiles, 1);
  assert.ok(result.sharedBytes > 0);
  assert.match(result.dependencySHA256, /^[a-f0-9]{64}$/u);
  assert.equal(createRequire(join(root, 'check.cjs'))(join(engine, 'index.js')), 'shared');
  await assert.rejects(stat(stagedDependencies), { code: 'ENOENT' });
  await assert.rejects(stat(join(shared, 'stale-file')), { code: 'ENOENT' });
});

test('rejects an invalid staging tree before replacing existing dependencies', async (test) => {
  const { root, staging, stagedDependencies, dependency } = await fixture(test);
  const shared = join(staging, 'node_modules');
  await mkdir(shared);
  const old = join(shared, 'previous-file');
  await writeFile(old, 'previous dependencies');
  await symlink(old, join(dependency, 'unexpected-link'), 'file');
  await assert.rejects(shareMinecraftDependencies(root), /must be regular files/);
  assert.ok((await stat(stagedDependencies)).isDirectory());
  assert.equal(await readFile(old, 'utf8'), 'previous dependencies');
});
