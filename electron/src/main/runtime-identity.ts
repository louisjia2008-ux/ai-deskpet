import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { readArtifactMode } from './artifact-mode';

declare const DESKPET_BUILD_IDENTITY_JSON: string | undefined;

const hashFile = (path: string): string | null => {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
  catch { return null; }
};

// Captured at startup: a later build replacing files cannot change this run's identity.
const mainBundleSHA256 = hashFile(join(__dirname, 'index.js'));
const utilityBundleSHA256 = hashFile(join(__dirname, 'utility.js'));
const build = typeof DESKPET_BUILD_IDENTITY_JSON === 'string'
  ? JSON.parse(DESKPET_BUILD_IDENTITY_JSON) as { sourceSHA256: string; sourceFileCount: number; builtAtUTC: string }
  : null;

export const runtimeIdentity = () => ({
  pid: process.pid,
  appPath: app.getAppPath(),
  executablePath: process.execPath,
  dataDirectory: app.getPath('userData'),
  isPackaged: app.isPackaged,
  artifactMode: readArtifactMode(app.getAppPath(), app.isPackaged),
  runtimeApplicationName: app.getName(),
  mainBundleSHA256,
  utilityBundleSHA256,
  build,
});
