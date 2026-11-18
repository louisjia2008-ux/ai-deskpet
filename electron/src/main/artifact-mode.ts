import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ArtifactMode = 'daily' | 'validation-candidate';

/** Read only signed package metadata. Runtime flags/environment cannot downgrade it. */
export const readArtifactMode = (appPath: string, packaged: boolean): ArtifactMode => {
  let value: { deskpetBuild?: { version?: unknown; mode?: unknown } };
  try { value = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')) as typeof value; }
  catch (error) { if (!packaged && (error as NodeJS.ErrnoException).code === 'ENOENT') return 'daily'; throw new Error('startup.packageModeInvalid'); }
  if (!packaged && value.deskpetBuild === undefined) return 'daily';
  if (value.deskpetBuild?.version !== 1 || typeof value.deskpetBuild.mode !== 'string' || !['daily', 'validation-candidate'].includes(value.deskpetBuild.mode)) throw new Error('startup.packageModeInvalid');
  return value.deskpetBuild.mode as ArtifactMode;
};
