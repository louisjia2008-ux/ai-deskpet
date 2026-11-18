import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { PersistenceCorruptionError } from './errors';

// A quarantined profile is an existing user's data, never a fresh installation.
export const assertNoQuarantinedData = async (path: string): Promise<void> => {
  let names: string[];
  try { names = await readdir(dirname(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const previous = names.filter((name) => name.startsWith(`${basename(path)}.corrupt-`)).sort().at(-1);
  if (previous !== undefined) throw new PersistenceCorruptionError('Existing data requires recovery.', join(dirname(path), previous));
};
