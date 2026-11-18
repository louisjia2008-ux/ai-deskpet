import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect,it } from 'vitest';
import { WorkspaceAccess } from '../tools/workspace';
import { telegramCredentialPath, telegramWorkspacePreview } from './telegram-workspace';

it('denies direct and recursive credential access without suppressing normal desktop files', async () => {
  const root=await mkdtemp(join(tmpdir(),'telegram-credential-fixture-'));
  try {
    await mkdir(join(root,'nested'));await writeFile(join(root,'nested','credentials.json'),'synthetic match');
    await writeFile(join(root,'notes.txt'),'synthetic match');
    const remote=new WorkspaceAccess(root,undefined,telegramCredentialPath);
    await expect(remote.read('nested/credentials.json')).rejects.toThrow('tool.channelBlocked');
    expect((await remote.list('nested')).entries).toEqual([]);
    expect((await remote.search({query:'synthetic'})).matches.map(m=>m.path)).toEqual(['notes.txt']);
    await expect(remote.write('nested/credentials.json','replace')).rejects.toThrow('tool.channelBlocked');
    expect(await new WorkspaceAccess(root).read('nested/credentials.json')).toBe('synthetic match');
    expect(() => telegramWorkspacePreview('workspace.search',{query:'synthetic private text'},true)).toThrow();
    expect(telegramWorkspacePreview('workspace.read',{path:'notes.txt'},true,'请打开 notes.txt')).toContain('notes.txt');
  } finally { await rm(root,{recursive:true,force:true}); }
});
