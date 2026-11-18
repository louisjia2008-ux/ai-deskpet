/* global process */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { createPackage } from '@electron/asar';

test('binary rollback keeps local service state and encrypted vaults; source migration omits them', {
  skip: process.platform !== 'darwin',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const scripts = join(project, 'scripts');
  const repo = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(scripts, { recursive: true });
  for (const name of ['install-local-macos.mjs', 'install-cutover-policy.mjs', 'verify-mac-package.mjs', 'upgrade-retention.mjs']) {
    await cp(join(repo, 'scripts', name), join(scripts, name));
  }
  await symlink(join(repo, 'node_modules'), join(project, 'node_modules'));

  const app = join(project, 'out', 'DeskPet Electron-darwin-' + process.arch, 'DeskPet Electron.app');
  const contents = join(app, 'Contents');
  const pkg = join(root, 'package-input');
  await mkdir(pkg);
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ deskpetBuild: { version: 1, mode: 'daily' } }));
  await mkdir(join(contents, 'Resources'), { recursive: true });
  await createPackage(pkg, join(contents, 'Resources', 'app.asar'));
  await mkdir(join(contents, 'MacOS'));
  await cp('/usr/bin/true', join(contents, 'MacOS', 'fixture'));
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.deskpet.companion.electron</string>
  <key>CFBundleExecutable</key><string>fixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>DeskPetArtifactMode</key><string>daily</string>
</dict></plist>`);
  const home = join(root, 'fixture-home');
  await mkdir(home);
  const env = { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: root };
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.deskpet.companion.electron', app], { env, stdio: 'pipe' });

  const data = join(home, 'Library/Application Support/DeskPet Electron');
  const localFiles = [
    'qq-channel-state.enc.json', 'qq-channel-vault/vault-key.safe', 'telegram-channel-state.enc.json',
    'telegram-channel-vault/vault-key.safe', 'knowledge/index', 'knowledge-vault/vault-key.safe',
    'stdio-bridge-vault/vault-key.safe', 'mcp-auth-vault/provider-secrets/synthetic.safe', 'playwright-mcp/workspace/output/synthetic.txt',
    'persona.enc.json', 'minecraft/microsoft-profiles/cache.fixture', 'rea-analysis/state.json',
  ];
  const seed = async (directory, marker) => {
    for (const name of ['profile.enc.json', ...localFiles]) {
      const file = join(directory, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, marker);
    }
  };
  const install = (...args) => execFileSync(process.execPath, [join(scripts, 'install-local-macos.mjs'), ...args], { env, stdio: 'pipe' });
  await seed(data, 'synthetic local bytes');
  const backup = join(root, 'checkpoint');
  install('--checkpoint=' + backup);
  const manifest = JSON.parse(await readFile(join(backup, 'profile-manifest.json'), 'utf8'));
  for (const path of localFiles) {
    const bytes = await readFile(join(backup, 'previous-profile', path));
    assert.deepEqual(bytes, await readFile(join(data, path)));
    assert.ok(manifest.files.some(entry => entry.path === path && entry.sha256 === createHash('sha256').update(bytes).digest('hex')));
  }

  const source = join(root, 'migration-input');
  await seed(source, 'synthetic migration bytes');
  install('--source-profile=' + source, '--checkpoint=' + join(root, 'migration-checkpoint'));
  assert.deepEqual(await readdir(data), ['profile.enc.json']);
  assert.equal(await readFile(join(data, 'profile.enc.json'), 'utf8'), 'synthetic migration bytes');
});
