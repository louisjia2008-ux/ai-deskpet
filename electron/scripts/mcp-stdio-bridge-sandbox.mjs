/* global process, Buffer, setTimeout, clearTimeout */
import { constants } from 'node:fs';
import { open, lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const inside = (parent, child) => parent === child || child.startsWith(parent + '/');
const forbidden = [
  '/Users',
  '/System',
  '/Library',
  '/Applications',
  '/usr',
  '/bin',
  '/sbin',
  '/private/etc',
  '/private/var/db',
  '/opt/homebrew',
  homedir(),
  resolve(import.meta.dirname, '..'),
];
const protectedFile = /^(?:credentials?|secrets?|tokens?|auth|api[-_]?keys?|passwords?)(?:[._-].*)?$/iu;
const readable = new Set(['.js', '.cjs', '.mjs', '.json']);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
const securePath = (path) => !/[\p{C}*?{}]/u.test(path) && !path.includes('[') && !path.includes(']');

export async function copyService(directory, entry, destination) {
  if (
    !isAbsolute(directory) ||
    directory !== resolve(directory) ||
    directory !== (await realpath(directory)) ||
    !securePath(directory) ||
    inside(directory, destination) ||
    inside(destination, directory) ||
    directory === '/' ||
    forbidden.some((path) => inside(path, directory) || inside(directory, path)) ||
    /(?:^|\/)[^/]+\.app(?:\/|$)/iu.test(directory) ||
    directory === '/Volumes' ||
    dirname(directory) === '/Volumes' ||
    isAbsolute(entry) ||
    entry.split('/').some((part) => !part || part.startsWith('.')) ||
    !securePath(entry) ||
    !['.mjs', '.cjs', '.js'].includes(extname(entry))
  )
    throw Error('Choose a dedicated, canonical, reviewed service directory and a relative JavaScript entry.');
  for (const f of ['package.json', entry]) {
    const path = join(directory, f),
      stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1 || path !== (await realpath(path)))
      throw Error('Choose an unlinked package and entry.');
  }
  let count = 0,
    bytes = 0;
  let packageName = null;
  const walk = async (subdir, depth) => {
    const src = join(directory, subdir),
      target = join(destination, subdir),
      initial = await lstat(src);
    if (!initial.isDirectory() || src !== (await realpath(src)) || depth > 24) throw Error('Unsafe service directory.');
    await mkdir(target, { mode: 0o700 });
    for (const file of await readdir(src, { withFileTypes: true })) {
      if (file.name.startsWith('.') || protectedFile.test(file.name)) continue;
      if (++count > 12000 || !securePath(file.name)) throw Error('Service snapshot exceeds safe limits.');
      const path = join(src, file.name),
        name = join(subdir, file.name);
      if (file.isSymbolicLink()) throw Error('Linked service files are unsupported.');
      if (file.isDirectory()) {
        await walk(name, depth + 1);
        continue;
      }
      if (!readable.has(extname(file.name))) continue;
      const before = await lstat(path);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size > 4 * 1024 * 1024 ||
        (bytes += before.size) > 48 * 1024 * 1024 ||
        path !== (await realpath(path))
      )
        throw Error('Unsafe service file.');
      const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!same(before, await f.stat())) throw Error('Service file changed.');
        const contents = Buffer.alloc(before.size);
        let total = 0;
        while (total < contents.length) {
          const { bytesRead } = await f.read(contents, total, contents.length - total, total);
          if (!bytesRead) break;
          total += bytesRead;
        }
        if (
          total !== before.size ||
          !same(before, await f.stat()) ||
          !same(before, await lstat(path)) ||
          path !== (await realpath(path))
        )
          throw Error('Service file changed.');
        if (name === 'package.json') packageName = JSON.parse(contents.toString('utf8')).name;
        await writeFile(join(destination, name), contents, { mode: 0o400, flag: 'wx' });
      } finally {
        await f.close();
      }
    }
    if (!same(initial, await lstat(src)) || src !== (await realpath(src))) throw Error('Service directory changed.');
  };
  await walk('', 0);
  if (
    typeof packageName !== 'string' ||
    !/^(?:@[a-z0-9][a-z0-9._-]{0,79}\/)?[a-z0-9][a-z0-9._-]{0,79}$/iu.test(packageName) ||
    !(await lstat(join(destination, entry))).isFile()
  )
    throw Error('Missing reviewed package or entry.');
  return basename(packageName);
}

export async function prepareRuntime(snapshot) {
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 22)
    throw Error('Requires macOS and Node 22 or newer.');
  const binary = await realpath(process.execPath);
  if (
    !/^\/(?:opt\/homebrew\/Cellar\/node(?:@\d+)?\/[^/]+\/bin\/node|usr\/local\/(?:bin\/node|Cellar\/node(?:@\d+)?\/[^/]+\/bin\/node))$/u.test(
      binary,
    )
  )
    throw Error('Use an existing Homebrew or /usr/local Node runtime.');
  const libs = new Set([binary]);
  process.report.excludeEnv = true;
  for (const path of process.report.getReport().sharedObjects) {
    if (
      path === binary ||
      inside('/usr/lib', path) ||
      inside('/System/Library', path) ||
      inside('/System/Volumes/Preboot/Cryptexes', path)
    )
      continue;
    const real = await realpath(path);
    if (!/^\/(?:opt\/homebrew|usr\/local)\/Cellar\/[^/]+\/[^/]+\/lib\/.+\.dylib$/u.test(real) || !securePath(real))
      throw Error('Unsupported runtime dependency. Refusing to widen the sandbox.');
    libs.add(real);
  }
  const guard = await lstat('/usr/bin/sandbox-exec');
  if (!guard.isFile() || guard.uid !== 0 || guard.mode & 0o022) throw Error('macOS sandbox unavailable.');
  const q = JSON.stringify;
  const literalPaths = [...libs].map((path) => '(literal ' + q(path) + ')').join(' ');
  // Reset system.sb filesystem permissions before adding exact runtime libraries.
  // In particular, never grant /System as a subtree (it contains the Data volume).
  const profile =
    '(version 1)(deny default)(import "system.sb")' +
    '(deny file-read* file-test-existence file-map-executable file-write* network* mach-lookup mach-register process-fork ipc-posix-shm* sysctl-write)' +
    '(allow sysctl-read)(allow process-exec (literal ' +
    q(binary) +
    '))' +
    '(allow file-read* file-map-executable ' +
    literalPaths +
    ' (subpath "/usr/lib")(subpath "/System/Library/Frameworks")(subpath "/System/Library/PrivateFrameworks")(subpath "/System/Library/dyld")(subpath "/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld"))' +
    '(allow file-read* file-test-existence (subpath ' +
    q(snapshot) +
    ')(literal "/dev/null")(literal "/dev/random")(literal "/dev/urandom"))' +
    '(allow file-read-metadata file-test-existence (path-ancestors ' +
    q(snapshot) +
    ')(subpath "/opt/homebrew/Cellar")(subpath "/opt/homebrew/opt")(subpath "/usr/local/opt")(subpath "/usr/local/Cellar")(literal "/"))';
  return { binary, profile, snapshot };
}

export function startChild(runtime, args, probe = false) {
  return spawn(
    '/usr/bin/sandbox-exec',
    [
      '-p',
      runtime.profile,
      runtime.binary,
      '--no-addons',
      '--jitless',
      '--max-old-space-size=96',
      ...(probe ? [] : ['--permission', '--allow-fs-read=' + runtime.snapshot]),
      ...args,
    ],
    {
      cwd: runtime.snapshot,
      env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC', OPENSSL_CONF: '/dev/null' },
      shell: false,
      stdio: ['pipe', 'pipe', probe ? 'pipe' : 'ignore'],
    },
  );
}

export async function verifyIsolation(runtime, canary) {
  // The trusted probe deliberately omits Node's permission layer to establish
  // kernel denial independently. No service code runs until all checks pass.
  const source = [
    "const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');",
    "const deny=f=>{try{f();return false;}catch(e){return ['EACCES','EPERM'].includes(e.code);}};",
    "const root=process.argv[2]; try{if(!fs.readFileSync(root+'/package.json').length)process.exit(7)}catch(e){process.exit(e.code==='ENOENT'?15:7)};",
    "try{process.chdir(root);if(!fs.readFileSync('package.json').length)process.exit(16)}catch{process.exit(16)};",
    "if(!deny(()=>fs.readFileSync(process.argv[1])))process.exit(10);if(!deny(()=>fs.writeFileSync(root+'/write-probe','x')))process.exit(11);if(!['EACCES','EPERM'].includes(cp.spawnSync('/usr/bin/true',[],{env:{}}).error?.code))process.exit(12);",
    "const s=net.connect(1,'127.0.0.1');s.on('connect',()=>process.exit(3));s.on('error',e=>{if(!['EACCES','EPERM'].includes(e.code))process.exit(4);process.stdout.end('isolated');});",
  ].join('\n');
  const child = startChild(runtime, ['-e', source, '--', canary, runtime.snapshot], true);
  child.stdin.on('error', () => {});
  child.stdin.end();
  await new Promise((done, fail) => {
    let answer = '',
      diagnostic = '';
    child.stderr.on('data', (chunk) => {
      if (diagnostic.length < 4000) diagnostic += chunk.toString().slice(0, 4000 - diagnostic.length);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5500);
    child.stdout.on('data', (chunk) => {
      answer += chunk.toString();
      if (answer.length > 32) child.kill('SIGKILL');
    });
    child.once('error', () => {
      clearTimeout(timer);
      fail(Error('Sandbox probe unavailable.'));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && answer === 'isolated') {
        done();
        return;
      }
      const tag =
        {
          3: 'network-open',
          4: 'network-error-unexpected',
          7: 'absolute-package-read-denied',
          15: 'absolute-package-missing',
          16: 'relative-package-read-denied',
          10: 'outside-read',
          11: 'workspace-write',
          12: 'spawn-denial-unconfirmed',
        }[code] ??
        (/unbound variable|syntax error|invalid.*profile/iu.test(diagnostic)
          ? 'seatbelt-profile'
          : /dyld|library not loaded/iu.test(diagnostic)
            ? 'runtime-library'
            : /openssl configuration|openssl.*config/iu.test(diagnostic)
              ? 'openssl-config'
              : /sandbox_apply|operation not permitted/iu.test(diagnostic)
                ? 'sandbox-unavailable'
                : /uv_loop_init|uv_pipe|uv_signal|uv_thread|uv_async/iu.test(diagnostic)
                  ? 'node-libuv'
                  : /Assertion failed|Assertion \w+ failed/iu.test(diagnostic)
                    ? 'node-assertion'
                    : 'runtime-start');
      fail(Error('Sandbox isolation probe failed: ' + tag + ' (' + String(code ?? signal) + ').'));
    });
  });
}
