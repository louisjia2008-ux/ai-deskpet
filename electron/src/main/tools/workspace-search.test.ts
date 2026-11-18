import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceAccess } from './workspace';

const roots: string[] = [];
const root = async () => { const path = await mkdtemp(join(tmpdir(), 'deskpet-search-')); roots.push(path); return path; };
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('workspace discovery and search', () => {
  it('lists files, directories and links without following links, with a visible result limit', async () => {
    const path = await root(); const outside = await root();
    await mkdir(join(path, 'notes')); await writeFile(join(path, 'readme.md'), 'text'); await symlink(outside, join(path, 'linked'));
    const workspace = new WorkspaceAccess(path);
    const listing = await workspace.list();
    expect(listing.entries).toEqual(expect.arrayContaining([{ name: 'notes', path: 'notes', type: 'directory' }, { name: 'linked', path: 'linked', type: 'symlink' }]));
    expect(await workspace.list('.', 1)).toMatchObject({ entries: expect.any(Array), truncated: true });
    await expect(workspace.list('linked')).rejects.toThrow('escapes');
    await expect(workspace.list('../')).rejects.toThrow('escapes');
  });
  it('finds literal text with line numbers, case handling and useful long-line excerpts', async () => {
    const path = await root(); await mkdir(join(path, 'notes'));
    await writeFile(join(path, 'notes/today.md'), `hello\nTea 茉莉花茶\n${'a'.repeat(900)}TEA finish\n`);
    const workspace = new WorkspaceAccess(path);
    const response = await workspace.search({ query: 'tea' });
    expect(response.matches).toMatchObject([{ path: 'notes/today.md', line: 2, text: 'Tea 茉莉花茶', lineTruncated: false }, { line: 3, lineTruncated: true }]);
    expect(response.matches[1]?.text).toContain('TEA finish');
    expect((await workspace.search({ query: 'Tea', caseSensitive: true })).matches).toHaveLength(1);
    expect((await workspace.search({ query: '茉莉花茶', path: 'notes' })).matches).toHaveLength(1);
    expect((await workspace.search({ query: 'Tea.*' })).matches).toEqual([]);
    expect(await workspace.search({ query: 'tea', maxResults: 1 })).toMatchObject({ truncated: true });
  });
  it('does not search outside the workspace, hidden content, build output, binaries or large files', async () => {
    const path = await root(); const outside = await root();
    await writeFile(join(outside, 'secret.txt'), 'needle'); await symlink(outside, join(path, 'linked'));
    await mkdir(join(path, 'node_modules')); await writeFile(join(path, 'node_modules/package.json'), 'needle');
    await writeFile(join(path, '.secret.txt'), 'needle'); await writeFile(join(path, 'binary.txt'), '\0needle');
    await writeFile(join(path, 'large.txt'), 'needle' + 'x'.repeat(1024 * 1024));
    await writeFile(join(path, 'public.md'), 'needle');
    const workspace = new WorkspaceAccess(path);
    expect((await workspace.search({ query: 'needle' })).matches).toMatchObject([{ path: 'public.md' }]);
    await expect(workspace.search({ query: 'needle', path: 'linked' })).rejects.toThrow('escapes');
    await expect(workspace.search({ query: 'needle', path: 'missing' })).rejects.toMatchObject({ code: 'ENOENT' });
    const controller = new AbortController(); controller.abort();
    await expect(workspace.search({ query: 'needle' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
