import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import serverArtifacts from '../../../../minecraft-mod/scripts/server-artifacts.json';

export const DEDICATED_MINECRAFT_VERSION = '1.21.8';
export const DEDICATED_HOST = '127.0.0.1';
export const DEDICATED_DATA_DIRECTORY = 'minecraft-dedicated';
const run = promisify(execFile);

// Eclipse Temurin release assets pinned from the Adoptium feature_releases/21/ga API.
const JAVA_PACKAGES = {
  'darwin-arm64': ['21.0.13.1+2', 'aarch64_mac', 'tar.gz', 47946379, '848feb1906c7de79de4f8391636042193fbd46eff86e26299506c4656f62c260'],
  'darwin-x64': ['21.0.13+9', 'x64_mac', 'tar.gz', 41902098, 'c909674b1c10c261b9a3fb7e9c0efebd303e33f88a4fe84be7135b5e2d711f89'],
  'linux-arm64': ['21.0.13+9', 'aarch64_linux', 'tar.gz', 51266660, 'b1734db7ade49c3f6acc6ae06233b8c2dd90e3e2f00f67000ae1c972aaa64d8c'],
  'linux-x64': ['21.0.13.1+2', 'x64_linux', 'tar.gz', 52190567, '18f44fab9065217f3ba61d0eef8a7b5f3c3713aa7293001b0d4ac10ede3850f0'],
  'win32-arm64': ['21.0.12.1+1', 'aarch64_windows', 'zip', 40078274, 'e82cc17e0bf89a25b0b0ed106d072f2ea420587d0a6870534b71b1dce3ae28c3'],
  'win32-x64': ['21.0.13.1+2', 'x64_windows', 'zip', 49108427, 'e15ee1e54a5a3b38027a09cedfa87bc3348d7dd3ce50866dd3d9671d7fffc6c1'],
} as const;

function javaPackage(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  if (!Object.hasOwn(JAVA_PACKAGES, key)) return null;
  const [release, target, extension, size, sha256] = JAVA_PACKAGES[key as keyof typeof JAVA_PACKAGES];
  const file = `OpenJDK21U-jre_${target}_hotspot_${release.replace('+', '_')}.${extension}`;
  return { file, url: `https://github.com/adoptium/temurin21-binaries/releases/download/jdk-${encodeURIComponent(release)}/${file}`,
    release, size, sha256 };
}

export const dedicatedJavaVersion = (): string | null => javaPackage()?.release ?? null;

// Mojang 1.21.8 official version metadata (SHA-1 e7625384d0bdf069fb75349992292ca86198c851).
const MOJANG_SERVER_SHA1 = '6bce4ef400e4efaa63a13d5e6f6b500be969ef81';
const MOJANG_SERVER_BYTES = 57_555_044;
const ARTIFACT_STAGE = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;

const packagedModSchema = z.object({
  version: z.literal(1), packaged: z.literal(true), jar: z.literal('deskpet-mod.jar'),
  modVersion: z.string().regex(/^[\w.+-]{1,64}$/u), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
const missingModSchema = z.object({ version: z.literal(1), packaged: z.literal(false) }).strict();
export type DedicatedPackagedMod = { path: string; version: string; sha256: string };

export async function inspectPackagedMod(resourcesPath: string): Promise<DedicatedPackagedMod | null> {
  const directory = join(resourcesPath, DEDICATED_DATA_DIRECTORY);
  const raw = await readFile(join(directory, 'manifest.json'), 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (raw === null) return null;
  const metadata: unknown = JSON.parse(raw);
  if (missingModSchema.safeParse(metadata).success) return null;
  const parsed = packagedModSchema.safeParse(metadata);
  if (!parsed.success) throw new Error('Minecraft Mod manifest is invalid.');
  return { path: join(directory, parsed.data.jar), version: parsed.data.modVersion, sha256: parsed.data.sha256 };
}

export async function assertChecksum(path: string, algorithm: 'sha1' | 'sha256', expected: string, signal: AbortSignal, expectedSize?: number): Promise<void> {
  const file = await lstat(path);
  if (!file.isFile() || (expectedSize !== undefined && file.size !== expectedSize)) {
    throw new Error(`Minecraft artifact size or file type verification failed (${basename(path)}).`);
  }
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error(`Minecraft artifact ${algorithm.toUpperCase()} verification failed (${basename(path)}).`);
}

const MAX_JAR_BYTES = 80 * 1024 * 1024;

async function ensureDownload(file: string, url: string, algorithm: 'sha1' | 'sha256', expected: string, signal: AbortSignal, size?: number): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const prefix = `${basename(file)}.download-`;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith(prefix) && ARTIFACT_STAGE.test(entry.name.slice(prefix.length))) {
      await rm(join(directory, entry.name), { force: true });
    }
  }
  try {
    await assertChecksum(file, algorithm, expected, signal, size);
    return;
  } catch (error) {
    // Refuse a modified cached artifact. Atomic downloads never leave an incomplete final file.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${file}.download-${randomUUID()}`;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
  try {
    const response = await fetch(url, { signal: requestSignal });
    if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:') {
      throw new Error(`Minecraft artifact download failed (${response.status}, ${basename(file)}).`);
    }
    let bytes = 0;
    const body = response.body;
    const limited = async function* () {
      const reader = body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > (size ?? MAX_JAR_BYTES)) throw new Error(`Minecraft artifact exceeds its download limit (${basename(file)}).`);
          yield value;
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    };
    await pipeline(limited(), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: requestSignal });
    await assertChecksum(temporary, algorithm, expected, requestSignal, size);
    await rename(temporary, file);
  } catch (error) {
    throw new Error(`Could not provision ${basename(file)}. ${error instanceof Error ? error.message : ''}`, { cause: error });
  } finally { await rm(temporary, { force: true }); }
}

/** Never inherit JVM injection variables, model provider credentials or an arbitrary PATH. */
export function dedicatedEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(['HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.has(key.toUpperCase()) && value !== undefined));
}

async function extractJava(root: string, archive: string, signal: AbortSignal): Promise<string> {
  const temporary = join(root, `java-extract-${randomUUID()}`);
  const runtime = join(root, 'java');
  const windows = process.platform === 'win32';
  const tar = windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
  const options = { signal, timeout: 45_000, env: dedicatedEnvironment(), maxBuffer: 4 * 1024 * 1024 };
  try {
    const { stdout } = await run(tar, ['-tf', archive], options);
    const entries = stdout.trimEnd().split(/\r?\n/u);
    if (entries.some(name => isAbsolute(name) || name.includes('\\') || name.includes(':') || name.split('/').includes('..'))) {
      throw new Error('The verified Java archive has an unexpected path layout.');
    }
    const bins = entries.filter(name => name.endsWith(windows ? '/bin/java.exe' : '/bin/java'));
    if (bins.length !== 1 || !bins[0]) throw new Error('Java executable is missing from the verified archive.');
    await mkdir(temporary, { mode: 0o700 });
    await run(tar, ['-xf', archive, '-C', temporary], options);
    signal.throwIfAborted();
    // Extract a fresh executable and libraries each start; do not trust previously unpacked files.
    await rm(runtime, { recursive: true, force: true });
    await rename(temporary, runtime);
    const java = join(runtime, bins[0]);
    const version = await run(java, ['-version'], options);
    if (!/version "21(?:[."])/u.test(version.stderr + version.stdout)) throw new Error('The verified runtime did not report Java 21.');
    return java;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function prepareDedicatedRuntime(root: string, directory: string, signal: AbortSignal) {
  const pkg = javaPackage();
  if (!pkg) throw new Error(`Local Minecraft does not support ${process.platform}/${process.arch}.`);
  const archive = join(root, 'downloads', pkg.file);
  const mojang = serverArtifacts.find(artifact => artifact.path === 'server.jar');
  if (!mojang) throw new Error('The pinned Minecraft server artifact is missing.');
  // Abort sibling HTTP operations on failure and join them before a retry can reuse their destination.
  const group = new AbortController();
  const operation = AbortSignal.any([group.signal, signal]);
  const tasks = [
    ensureDownload(archive, pkg.url, 'sha256', pkg.sha256, operation, pkg.size),
    ensureDownload(join(directory, 'server.jar'), mojang.url, 'sha1', MOJANG_SERVER_SHA1, operation, MOJANG_SERVER_BYTES),
    ...serverArtifacts.filter(artifact => artifact !== mojang)
      .map(artifact => ensureDownload(join(directory, artifact.path), artifact.url, 'sha256', artifact.sha256, operation)),
  ];
  try { await Promise.all(tasks); }
  catch (error) { group.abort(); await Promise.allSettled(tasks); throw error; }
  // Also check the SHA-256 from the shared Fabric acceptance pins for Minecraft itself.
  await assertChecksum(join(directory, 'server.jar'), 'sha256', mojang.sha256, signal);
  // These caches contain executable JARs extracted or remapped by Fabric and Mojang.
  // Regenerate them from the verified inputs so an altered cache cannot bypass the pins.
  for (const cache of ['.fabric', 'libraries', 'versions']) await rm(join(directory, cache), { force: true, recursive: true });
  const extractPrefix = 'java-extract-';
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(extractPrefix) && ARTIFACT_STAGE.test(entry.name.slice(extractPrefix.length))) {
      await rm(join(root, entry.name), { force: true, recursive: true });
    }
  }
  signal.throwIfAborted();
  return { java: await extractJava(root, archive, signal), modArtifacts: serverArtifacts.filter(entry => entry.path.startsWith('mods/')).map(entry => basename(entry.path)),
    libraries: serverArtifacts.filter(entry => entry.path.startsWith('fabric-libraries/')).map(entry => entry.path) };
}
