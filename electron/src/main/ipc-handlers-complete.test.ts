// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { invokePayloadSchemas } from '../shared/schemas';

const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return sources(path);
  return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
});

describe('IPC handlers', () => {
  // E2E specs may stub a handler with ipcMain.handle, so a channel exposed to the renderer
  // must also be named by main-process code, or the real app answers it with an error.
  it('names every renderer-invokable channel in main-process code', () => {
    const main = sources(join(__dirname)).map(path => readFileSync(path, 'utf8')).join('\n');
    const missing = Object.keys(invokePayloadSchemas).filter(channel => !main.includes(`'${channel}'`));
    expect(missing).toEqual([]);
  });
});
