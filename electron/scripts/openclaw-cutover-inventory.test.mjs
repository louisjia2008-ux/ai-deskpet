import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { inventory } from './openclaw-cutover-inventory.mjs';

const script = fileURLToPath(new URL('./openclaw-cutover-inventory.mjs', import.meta.url)),
  execFile = promisify(execFileCallback);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cutover-inventory-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, config: join(root, 'config.fixture'), jobs: join(root, 'jobs.fixture') };
}
test('reports explicit and inherited policy counts; only enumerated values and counts reach stdout', async (t) => {
  const { config, jobs } = await fixture(t),
    privateMarker = randomUUID();
  await writeFile(
    config,
    `{ // JSON5-style input, also used by OpenClaw
    channels:{telegram:{enabled:true, groupPolicy:'allowlist', accounts:{
      '${privateMarker}':{groupPolicy:'open', enabled:false,botToken:'${privateMarker}'},
      other:{}, future:{groupPolicy:'${privateMarker}'},
    }}},
  }`,
  );
  await writeFile(
    jobs,
    JSON.stringify({
      version: 1,
      jobs: [
        {
          id: privateMarker,
          enabled: true,
          name: privateMarker,
          schedule: { kind: 'cron', expr: privateMarker },
          delivery: { mode: 'announce', to: privateMarker },
          payload: { message: privateMarker },
        },
        { enabled: false, schedule: { kind: 'at' }, delivery: { mode: 'webhook', to: privateMarker } },
        { enabled: true, schedule: { kind: 'every' }, delivery: { mode: 'none' } },
        { schedule: { kind: privateMarker }, delivery: { mode: privateMarker } },
      ],
    }),
  );
  const before = [await readFile(config), await readFile(jobs)];
  const { stdout, stderr } = await execFile(process.execPath, [script, '--jobs', jobs, '--config', config]);
  assert.equal(stderr, '');
  assert.ok(!stdout.includes(privateMarker));
  assert.ok(!stdout.includes(config));
  const report = JSON.parse(stdout);
  assert.deepEqual(report.telegram, {
    groupPolicy: 'allowlist',
    enabled: 'enabled',
    accounts: {
      total: 3,
      explicitEnabled: { enabled: 0, disabled: 1, unknown: 2 },
      policyOverrides: { open: 1, allowlist: 0, disabled: 0, unknown: 1 },
      inherited: 1,
      effectivePolicy: { open: 1, allowlist: 1, disabled: 0, unknown: 1 },
    },
  });
  assert.deepEqual(report.jobs, {
    total: 4,
    enabled: { enabled: 2, disabled: 1, unknown: 1 },
    scheduleKind: { cron: 1, at: 1, every: 1, unknown: 1 },
    deliveryMode: { none: 1, announce: 1, webhook: 1, unknown: 1 },
  });
  assert.deepEqual([await readFile(config), await readFile(jobs)], before);
});
test('never follows includes or treats a missing policy and unrecognized jobs layout as a known safe value', async (t) => {
  const { config, jobs } = await fixture(t);
  await writeFile(config, JSON.stringify({ channels: { telegram: { $include: 'nonexistent-relative-file' } } }));
  await writeFile(jobs, JSON.stringify({ tasks: [{ enabled: true }] }));
  const unresolved = await inventory(config, jobs);
  assert.equal(unresolved.telegram.groupPolicy, 'unknown');
  assert.equal(unresolved.telegram.accounts.total, 'unknown');
  assert.equal(unresolved.jobs.total, 'unknown');
  await writeFile(config, JSON.stringify({ channels: { telegram: { accounts: { a: {}, b: { groupPolicy: 'disabled' } } } } }));
  await writeFile(jobs, '[]');
  const known = await inventory(config, jobs);
  assert.equal(known.telegram.groupPolicy, 'unknown');
  assert.deepEqual(known.telegram.accounts.effectivePolicy, { open: 0, allowlist: 0, disabled: 1, unknown: 1 });
  assert.equal(known.jobs.total, 0);
});
test('requires both paths; malformed input cannot execute expressions or echo data, paths or parse errors', async (t) => {
  const { root, config, jobs } = await fixture(t),
    privateMarker = randomUUID(),
    markerFile = join(root, privateMarker);
  await writeFile(markerFile, 'intact');
  await writeFile(jobs, '{"jobs":[]}');
  await writeFile(config, `{ channels: (() => {require('fs').unlinkSync('${markerFile}');return {}})() }`);
  for (const args of [
    [],
    ['--config', privateMarker],
    ['--config', config, '--jobs', jobs],
    ['--config', markerFile, '--jobs', jobs],
  ]) {
    await assert.rejects(execFile(process.execPath, [script, ...args], { cwd: root }), (error) => {
      assert.equal(error.stdout, '');
      assert.ok(!error.stderr.includes(privateMarker));
      assert.ok(!error.stderr.includes(root));
      return true;
    });
  }
  assert.equal(await readFile(markerFile, 'utf8'), 'intact');
});
