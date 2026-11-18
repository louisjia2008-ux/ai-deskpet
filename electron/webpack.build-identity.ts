import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The current disk sources, including uncommitted files, identify this build. */
export const captureBuildIdentity = (project: string) => {
  const names: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error('Build identity does not follow linked source files.');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) names.push(relative(project, path).replaceAll('\\', '/'));
    }
  };
  walk(join(project, 'src'));
  for (const name of ['package.json', 'package-lock.json', 'forge.config.ts', 'webpack.main.config.ts', 'webpack.renderer.config.ts', 'webpack.rules.ts', 'webpack.build-identity.ts', 'tsconfig.json']) {
    if (statSync(join(project, name)).isFile()) names.push(name);
  }
  const sources = [...new Set(names)].sort().map((name) => ({ name, sha256: createHash('sha256').update(readFileSync(join(project, name))).digest('hex') }));
  return { sourceSHA256: createHash('sha256').update(JSON.stringify(sources)).digest('hex'), sourceFileCount: sources.length, builtAtUTC: new Date().toISOString() };
};
