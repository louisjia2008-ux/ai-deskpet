/* global process */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const electron = dirname(dirname(fileURLToPath(import.meta.url)));
const project = join(electron, '..', 'minecraft-mod');
const target = join(electron, '.minecraft-package', 'minecraft-dedicated');
const windows = process.platform === 'win32';
const javaName = windows ? 'java.exe' : 'java';

function jdkSupportsBuild(home) {
  if (!home) return false;
  const result = spawnSync(join(home, 'bin', windows ? 'javac.exe' : 'javac'), ['-version'], { timeout: 10_000, encoding: 'utf8' });
  return result.status === 0 && /\bjavac 21(?:\.|\s|$)/u.test(`${result.stdout}${result.stderr}`);
}

function selectJavaHome() {
  const fromMac = process.platform === 'darwin'
    ? spawnSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8', timeout: 10_000 }).stdout?.trim() : null;
  const java = spawnSync(javaName, ['-XshowSettings:properties', '-version'], { encoding: 'utf8', timeout: 10_000 });
  const fromPath = java.stderr?.match(/^\s*java\.home\s*=\s*(.+)$/mu)?.[1]?.trim();
  return [process.env.JAVA_HOME, fromMac, fromPath].find(jdkSupportsBuild);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
const javaHome = selectJavaHome();
if (!javaHome) {
  // A prior candidate JAR must never survive a build without Java 21.
  await writeFile(join(target, 'manifest.json'), JSON.stringify({ version: 1, packaged: false }) + '\n');
  process.stdout.write('Minecraft dedicated server Mod is unavailable in this build (JDK 21 was not found).\n');
} else {
  const args = ['--no-daemon', '--no-configuration-cache', 'remapJar'];
  const environment = { ...process.env, JAVA_HOME: javaHome, PATH: `${join(javaHome, 'bin')}${delimiter}${process.env.PATH ?? ''}` };
  const invoke = (gradleArgs, stdio) => spawnSync(windows ? 'gradlew.bat' : './gradlew', gradleArgs, {
    cwd: project, env: environment, stdio, shell: windows, encoding: 'utf8',
  });
  const cached = invoke(['--offline', ...args], 'pipe');
  let built = cached;
  if (cached.status !== 0) {
    process.stderr.write(cached.stdout ?? '');
    process.stderr.write(cached.stderr ?? '');
    built = invoke(args, 'inherit');
  }
  if (built.error) throw built.error;
  if (built.status !== 0) throw new Error(`Minecraft Mod Gradle build failed (${built.status ?? built.signal}).`);

  const properties = await readFile(join(project, 'gradle.properties'), 'utf8');
  const modVersion = /^mod_version=([\w.+-]+)$/mu.exec(properties)?.[1];
  if (!modVersion) throw new Error('The Minecraft Mod version is missing or invalid.');
  const jar = 'deskpet-mod.jar';
  const sourceJar = join(project, 'build', 'libs', `deskpet-${modVersion}.jar`);
  const bytes = await readFile(sourceJar);
  const zip = await JSZip.loadAsync(bytes);
  const metadata = JSON.parse(await zip.file('fabric.mod.json')?.async('string') ?? 'null');
  if (metadata?.id !== 'deskpet' || metadata.version !== modVersion || zip.file('deskpet-raw-survey-wand')) {
    throw new Error('The built artifact is not the expected production DeskPet Mod.');
  }
  await writeFile(join(target, jar), bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(target, 'manifest.json'), JSON.stringify({ version: 1, packaged: true, jar, modVersion, sha256 }, null, 2) + '\n');
  process.stdout.write(`Minecraft dedicated server Mod ${modVersion} packaged (SHA-256 ${sha256}).\n`);
}
