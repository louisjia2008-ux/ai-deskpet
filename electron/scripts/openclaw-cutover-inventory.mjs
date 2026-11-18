import { constants } from 'node:fs';
import {Buffer} from 'node:buffer';
import console from 'node:console';
import process from 'node:process';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const UNKNOWN = 'unknown';
const POLICY = ['open', 'allowlist', 'disabled'];
const SCHEDULE = ['cron', 'at', 'every'];
const DELIVERY = ['none', 'announce', 'webhook'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const select = (value, allowed) => (allowed.includes(value) ? value : UNKNOWN);
const counts = (keys) => Object.fromEntries([...keys, UNKNOWN].map((key) => [key, 0]));
const flag = (value) => (value === true ? 'enabled' : value === false ? 'disabled' : UNKNOWN);
const usage = 'Usage: node scripts/openclaw-cutover-inventory.mjs --config <file> --jobs <file>';

// Strict JSON requires only Node. For JSON5-style configs, Acorn is already pinned
// by the development lockfile. Convert *only* data nodes; never import, evaluate,
// resolve includes, interpolate environment variables or invoke an OpenClaw process.
function parseData(source) {
  try {
    return JSON.parse(source);
  } catch {
    /* comments / unquoted object keys / trailing commas */
  }
  const { parse } = createRequire(import.meta.url)('acorn');
  const program = parse('(' + source + '\n)', { ecmaVersion: 2022 });
  const toData = (node) => {
    if (
      node?.type === 'Literal' &&
      !node.regex &&
      !node.bigint &&
      ['string', 'number', 'boolean', 'object'].includes(typeof node.value)
    )
      return node.value;
    if (
      node?.type === 'UnaryExpression' &&
      ['-', '+'].includes(node.operator) &&
      node.argument.type === 'Literal' &&
      typeof node.argument.value === 'number'
    ) {
      return node.operator === '-' ? -node.argument.value : node.argument.value;
    }
    if (node?.type === 'ArrayExpression') return node.elements.map(toData);
    if (node?.type !== 'ObjectExpression') throw new Error('invalid-data');
    const result = Object.create(null);
    for (const property of node.properties) {
      if (
        property.type !== 'Property' ||
        property.kind !== 'init' ||
        property.computed ||
        property.method ||
        property.shorthand ||
        !['Identifier', 'Literal'].includes(property.key.type)
      )
        throw new Error('invalid-data');
      const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
      if (typeof key !== 'string' || Object.hasOwn(result, key)) throw new Error('invalid-data');
      result[key] = toData(property.value);
    }
    return result;
  };
  if (program.body.length !== 1 || program.body[0].type !== 'ExpressionStatement') throw new Error('invalid-data');
  return toData(program.body[0].expression);
}

async function readData(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > 8 * 1024 * 1024) throw new Error('unsupported-input');
    const bytes = Buffer.alloc(st.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const r = await handle.read(bytes, size, bytes.length - size, size);
      if (!r.bytesRead) break;
      size += r.bytesRead;
    }
    if (size !== st.size) throw new Error('changing-input');
    return parseData(
      bytes
        .subarray(0, size)
        .toString('utf8')
        .replace(/^\uFEFF/u, ''),
    );
  } finally {
    await handle.close();
  }
}

const unresolved = (obj) => !object(obj) || Object.hasOwn(obj, '$include');
function telegramSummary(config) {
  const channels = config?.channels,
    tg = channels?.telegram;
  const unknownAccounts = {
    total: UNKNOWN,
    explicitEnabled: UNKNOWN,
    policyOverrides: UNKNOWN,
    inherited: UNKNOWN,
    effectivePolicy: UNKNOWN,
  };
  if (unresolved(config) || unresolved(channels) || unresolved(tg))
    return { groupPolicy: UNKNOWN, enabled: UNKNOWN, accounts: unknownAccounts };
  const groupPolicy = select(tg.groupPolicy, POLICY),
    enabled = flag(tg.enabled);
  const accounts = {
    total: 0,
    explicitEnabled: counts(['enabled', 'disabled']),
    policyOverrides: counts(POLICY),
    inherited: 0,
    effectivePolicy: counts(POLICY),
  };
  if (!Object.hasOwn(tg, 'accounts')) return { groupPolicy, enabled, accounts };
  if (unresolved(tg.accounts)) return { groupPolicy, enabled, accounts: unknownAccounts };
  for (const account of Object.values(tg.accounts)) {
    accounts.total++;
    if (unresolved(account)) {
      accounts.explicitEnabled.unknown++;
      accounts.policyOverrides.unknown++;
      accounts.effectivePolicy.unknown++;
      continue;
    }
    accounts.explicitEnabled[flag(account.enabled)]++;
    if (Object.hasOwn(account, 'groupPolicy')) {
      const policy = select(account.groupPolicy, POLICY);
      accounts.policyOverrides[policy]++;
      accounts.effectivePolicy[policy]++;
    } else {
      accounts.inherited++;
      accounts.effectivePolicy[groupPolicy]++;
    }
  }
  return { groupPolicy, enabled, accounts };
}
function jobSummary(store) {
  const jobs = Array.isArray(store) ? store : !unresolved(store) ? store.jobs : undefined;
  if (!Array.isArray(jobs)) return { total: UNKNOWN, enabled: UNKNOWN, scheduleKind: UNKNOWN, deliveryMode: UNKNOWN };
  const result = {
    total: jobs.length,
    enabled: counts(['enabled', 'disabled']),
    scheduleKind: counts(SCHEDULE),
    deliveryMode: counts(DELIVERY),
  };
  for (const row of jobs) {
    const job = unresolved(row) ? null : row;
    result.enabled[flag(job?.enabled)]++;
    result.scheduleKind[select(unresolved(job?.schedule) ? null : job.schedule.kind, SCHEDULE)]++;
    result.deliveryMode[select(unresolved(job?.delivery) ? null : job.delivery.mode, DELIVERY)]++;
  }
  return result;
}

export async function inventory(configPath, jobsPath) {
  if (typeof configPath !== 'string' || !configPath || typeof jobsPath !== 'string' || !jobsPath)
    throw new Error('paths-required');
  return { telegram: telegramSummary(await readData(configPath)), jobs: jobSummary(await readData(jobsPath)) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log(usage);
  else if (
    args.length !== 4 ||
    !['--config', '--jobs'].includes(args[0]) ||
    !['--config', '--jobs'].includes(args[2]) ||
    args[0] === args[2] ||
    !args[1] ||
    !args[3] ||
    args[1].startsWith('--') ||
    args[3].startsWith('--')
  ) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    const paths = Object.fromEntries([
      [args[0], args[1]],
      [args[2], args[3]],
    ]);
    try {
      console.log(JSON.stringify(await inventory(paths['--config'], paths['--jobs']), null, 2));
    } catch {
      console.error('Inventory unavailable: an input was unreadable, unsupported, changed, or exceeded 8 MiB.');
      process.exitCode = 1;
    }
  }
}
