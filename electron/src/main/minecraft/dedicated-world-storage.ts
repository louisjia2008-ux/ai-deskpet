import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const BACKUP_NAME = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-[a-f0-9-]{36}$/u;
const STAGING_NAME = /^\.snapshot-[a-f0-9-]{36}$/u;

/** Log4j limits the active file even while the server runs for days. */
export const DEDICATED_LOG_CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<Configuration status="WARN">
  <Appenders>
    <Console name="Console" target="SYSTEM_OUT">
      <PatternLayout pattern="[%d{HH:mm:ss}] [%t/%level]: %msg%n"/>
    </Console>
    <RollingFile name="File" fileName="logs/latest.log" filePattern="logs/%d{yyyy-MM-dd}-%i.log.gz">
      <PatternLayout pattern="[%d{HH:mm:ss}] [%t/%level]: %msg%n"/>
      <Policies>
        <OnStartupTriggeringPolicy/>
        <TimeBasedTriggeringPolicy/>
        <SizeBasedTriggeringPolicy size="16 MB"/>
      </Policies>
      <DefaultRolloverStrategy max="8">
        <Delete basePath="logs" maxDepth="1">
          <IfFileName glob="*.log.gz"/>
          <IfAny><IfLastModified age="P7D"/><IfAccumulatedFileSize exceeds="144 MB"/></IfAny>
        </Delete>
      </DefaultRolloverStrategy>
    </RollingFile>
  </Appenders>
  <Loggers><Root level="info"><AppenderRef ref="Console"/><AppenderRef ref="File"/></Root></Loggers>
</Configuration>
`;

async function directoryExists(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error('Minecraft world or backup path is not a directory.');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function completedBackups(backupPath: string): Promise<string[]> {
  const entries = await readdir(backupPath, { withFileTypes: true });
  return entries.filter(entry => entry.isDirectory() && BACKUP_NAME.test(entry.name)).map(entry => entry.name).sort().reverse();
}

export async function maintainBackups(backupPath: string): Promise<string | null> {
  await mkdir(backupPath, { recursive: true, mode: 0o700 });
  const entries = await readdir(backupPath, { withFileTypes: true });
  for (const entry of entries) if (entry.isDirectory() && STAGING_NAME.test(entry.name)) {
    await rm(join(backupPath, entry.name), { recursive: true, force: true });
  }
  const backups = await completedBackups(backupPath);
  for (const name of backups.slice(3)) await rm(join(backupPath, name), { recursive: true, force: true });
  const latest = BACKUP_NAME.exec(backups[0] ?? '')?.[1];
  return latest?.replace(/T(\d{2})-(\d{2})-(\d{2})/u, 'T$1:$2:$3') ?? null;
}

export async function snapshotWorld(worldPath: string, backupPath: string, signal: AbortSignal): Promise<string | null> {
  if (!await directoryExists(worldPath)) return null;
  const id = randomUUID();
  const staging = join(backupPath, `.snapshot-${id}`);
  const time = new Date().toISOString();
  try {
    await mkdir(staging, { mode: 0o700 });
    await cp(worldPath, join(staging, 'world'), {
      recursive: true, errorOnExist: true, force: false, preserveTimestamps: true,
      filter: async (path) => {
        signal.throwIfAborted();
        if (/[/\\](?:session\.lock|[^/\\]+\.tmp)$/u.test(path)) return false;
        const file = await lstat(path);
        if (!file.isDirectory() && !file.isFile()) throw new Error('Minecraft backup found an unsupported world file type.');
        return true;
      },
    });
    signal.throwIfAborted();
    await rename(staging, join(backupPath, `${time.replaceAll(':', '-')}-${id}`));
    return await maintainBackups(backupPath);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

/** Clean old launcher crash reports and any oversized logs carried over from an earlier launch. */
export async function trimServerLogs(directory: string): Promise<void> {
  const files: Array<{ path: string; modified: number; size: number }> = [];
  let totalBytes = 0;
  for (const name of ['logs', 'crash-reports']) {
    const folder = join(directory, name);
    if (!await directoryExists(folder)) continue;
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:log(?:\.gz)?|txt)$/u.test(entry.name)) continue;
      const path = join(folder, entry.name);
      const file = await lstat(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (!file?.isFile()) continue;
      totalBytes += file.size;
      if (entry.name !== 'latest.log') files.push({ path, modified: file.mtimeMs, size: file.size });
    }
  }
  const cutoff = Date.now() - 7 * 86_400_000;
  for (const file of files.sort((a, b) => a.modified - b.modified)) {
    if (file.modified >= cutoff && totalBytes <= 200 * 1024 * 1024) break;
    await rm(file.path, { force: true });
    totalBytes -= file.size;
  }
}
