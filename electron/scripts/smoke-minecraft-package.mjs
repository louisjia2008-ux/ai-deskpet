/* global process, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

const product = process.env.DESKPET_PACKAGE_MODE === 'validation-candidate' ? 'DeskPet Electron Candidate' : 'DeskPet Electron';
const packageRoot = join(process.cwd(), 'out', `${product}-${process.platform}-${process.arch}`);
const macBundle = join(packageRoot, product + '.app', 'Contents');
const executable = process.platform === 'darwin' ? join(macBundle, 'MacOS', 'deskpet-electron')
  : join(packageRoot, process.platform === 'win32' ? 'deskpet-electron.exe' : 'deskpet-electron');
const resources = process.platform === 'darwin' ? join(macBundle, 'Resources') : join(packageRoot, 'resources');
const dedicated = join(resources, 'minecraft-dedicated');
const mod = JSON.parse(await readFile(join(dedicated, 'manifest.json'), 'utf8'));
assert.equal(mod.version, 1);
if (mod.packaged === false) {
  await assert.rejects(stat(join(dedicated, 'deskpet-mod.jar')), { code: 'ENOENT' });
  process.stdout.write('Packaged Minecraft dedicated server correctly reports the Mod unavailable.\n');
} else {
  assert.equal(mod.packaged, true);
  assert.equal(mod.jar, 'deskpet-mod.jar');
  assert.match(mod.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(createHash('sha256').update(await readFile(join(dedicated, mod.jar))).digest('hex'), mod.sha256);
  process.stdout.write(`Packaged Minecraft dedicated Mod ${mod.modVersion} SHA-256 verified.\n`);
}
for (const engine of ['minecraft-runtime', 'minecraft-companion-runtime']) {
  await assert.rejects(stat(join(resources, engine, 'node_modules')), { code: 'ENOENT' });
  const require = createRequire(join(resources, engine, 'package.json'));
  for (const name of ['mineflayer', 'mineflayer-pathfinder', 'vec3']) {
    assert.ok(relative(resources, require.resolve(name)).startsWith(`node_modules${sep}`), `${engine} must resolve ${name} from the packaged shared dependency tree.`);
  }
}
async function smoke(core) {
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-packaged-minecraft-'));
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const child = spawn(executable, core
    ? [join(resources, 'minecraft-companion-runtime', 'index.js'), '--engine', 'core', '--data-dir', profile]
    : [join(resources, 'minecraft-runtime', 'bridge.js'), '--data-dir', profile], {
    env: { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exit = new Promise((resolve, reject) => { child.once('exit', (code) => resolve(code)); child.once('error', reject); });
  let buffer = '', ready = false, refused = false, timer;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Packaged Minecraft smoke timed out.')), 20_000); });
    await Promise.race([deadline, new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => { if (!refused) reject(new Error('Packaged Minecraft helper exited before connection readback.')); });
      child.stderr.on('data', () => { /* Private dependency diagnostics are not printed. */ });
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); } catch { reject(new Error('Packaged helper stdout is not JSONL.')); return; }
          if (message.type === 'ready') {
            if (core && (message.engine !== 'core' || message.capabilities?.automaticReconnect !== false || !message.capabilities?.taskLifecycle)) {
              reject(new Error('Packaged Companion did not start the reviewed core engine.')); return;
            }
            ready = true;
            child.stdin.write(JSON.stringify({ version: 1, id: 'smoke-connect', type: 'connect', config: {
              host: '127.0.0.1', port: address.port, username: 'DeskPetSmoke', auth: 'offline',
              version: '1.21.8', ownerName: '', executorMode: 'strict',
            } }) + '\n');
          }
          if (message.type === 'event' && message.event?.type === 'mc_status' && message.event.status?.connected) {
            reject(new Error('A refused connection must never report a spawned player.')); return;
          }
          if (message.type === 'event' && message.event?.type === 'mc_error' && /ECONNREFUSED/u.test(message.event.message)) {
            refused = true; resolve();
          }
          if (core && message.type === 'event' && message.event?.type === 'connection') {
            if (message.event.state === 'ready') { reject(new Error('A refused connection must never report ready.')); return; }
            if (message.event.state === 'error' && /ECONNREFUSED/u.test(message.event.error?.message)) { refused = true; resolve(); }
          }
        }
      });
    })]);
    assert.ok(ready && refused);
    child.stdin.end(JSON.stringify({ version: 1, id: 'smoke-shutdown', type: 'shutdown' }) + '\n');
    assert.equal(await Promise.race([exit, deadline]), 0);
    process.stdout.write(`Packaged Minecraft ${core ? 'Companion core' : 'legacy'} smoke passed: Electron Node runtime, shared dependencies, refused connection and clean exit.\n`);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    await rm(profile, { recursive: true, force: true });
  }
}

await smoke(false);
await smoke(true);
