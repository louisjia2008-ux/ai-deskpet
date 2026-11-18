import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { test } from 'node:test';
import { createPackage } from '@electron/asar';

const script = join(dirname(fileURLToPath(import.meta.url)), 'audit-package.mjs');
const fixture = async (files = { 'index.js': '/* synthetic audit fixture, not an app */' }) => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-package-audit-'));
  const source = join(root, 'source'), out = join(root, 'out');
  await mkdir(source); await mkdir(out);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(source, name)), { recursive: true }); await writeFile(join(source, name), text);
  }
  await createPackage(source, join(out, 'app.asar'));
  return { root, out };
};
const audit = (cwd, args = []) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

test('audits the default output or one exact candidate without changing the exclusions', async () => {
  const f = await fixture();
  try {
    assert.equal(audit(f.root).status, 0);
    const exact = audit(f.root, [f.out]); assert.equal(exact.status, 0); assert.match(exact.stdout, /1 ASAR archive/);
    await writeFile(join(f.out, 'forbidden.zip'), 'synthetic');
    const rejected = audit(f.root, [f.out]); assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /prohibited Core\/model\/archive/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects prohibited content inside the candidate ASAR as well as empty targets and extra arguments', async () => {
  const f = await fixture({ 'assets/synthetic.model3.json': '{}' });
  try {
    assert.notEqual(audit(f.root, [f.out]).status, 0);
    assert.match(audit(f.root, [f.out, 'unexpected']).stderr, /Usage:/);
    const empty = join(f.root, 'empty'); await mkdir(empty);
    assert.match(audit(f.root, [empty]).stderr, /No packaged ASAR archive/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
