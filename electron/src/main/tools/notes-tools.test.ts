// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DomainRepository } from '../domain/repository';
import { ChatService } from '../domain/chat-service';
import { ChatWorkService } from '../domain/chat-work-service';
import type { KnowledgeDestination } from '../../shared/knowledge';
import { ToolFailure } from '../runtime/tool-failure';
import { VaultKnowledgeService } from '../knowledge/vault-index';
import { ToolRegistry } from '../runtime/tool-registry';
import { registerNotesTools } from './notes-tools';

const roots: string[] = [];
afterEach(async () => { for (const folder of roots.splice(0)) await rm(folder, { recursive: true, force: true }); });

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-notes-')); roots.push(root);
  const vault = join(root, 'vault'); await mkdir(vault);
  await writeFile(join(vault, 'dentist.md'), '# Health\nDENTIST_FRIDAY_PRIVATE\n');
  await writeFile(join(vault, 'other.md'), 'Groceries');
  await writeFile(join(root, 'outside.md'), 'OUTSIDE_SECRET');
  await symlink(join(root, 'outside.md'), join(vault, 'linked.md'));
  const key = randomBytes(32);
  const knowledge = new VaultKnowledgeService({ directory: join(root, 'index'), vault: { getVaultKey: async () => key },
    embeddings: { embed: async (inputs: string[]) => inputs.map(text => { const vector = Array<number>(768).fill(0); vector[text.includes('DENTIST') ? 0 : 1] = 1; return vector; }) } });
  await knowledge.initialize();
  const registry = new ToolRegistry();
  let destination: KnowledgeDestination = 'local';
  const recordResult = vi.fn();
  registerNotesTools(registry, {
    linked: () => knowledge.status().vaultName !== null,
    scope: () => {
      const captured = destination;
      return { destination: captured, origin: 'desktop', claimSave: () => undefined, recordResult, assertCurrent() {
        if (captured !== destination) throw new ToolFailure('knowledge.policyChanged');
      } };
    },
    search: (query, target, signal) => knowledge.searchForTool(query, target, signal),
    read: (path, target, signal) => knowledge.readNoteForTool(path, target, signal),
    save: (input, source, target, signal, assertAuthorized) => knowledge.saveNote(input, source, target, signal, assertAuthorized),
  });
  const context = { runId: randomUUID(), taskId: randomUUID(), signal: new AbortController().signal, assertAuthorized: () => undefined };
  return { root, vault, knowledge, registry, context, recordResult, route: (target: KnowledgeDestination) => { destination = target; } };
};

it('declares the notes tools only while a vault is linked and returns verified excerpts', async () => {
  const f = await fixture();
  expect(f.registry.describe().some(tool => tool.id.startsWith('notes.'))).toBe(false);
  await f.knowledge.selectRoot(f.vault); await f.knowledge.reindex();
  expect(f.registry.describe().filter(tool => tool.id.startsWith('notes.')).map(tool => tool.id)).toEqual(['notes.search', 'notes.read', 'notes.save']);
  const found = await f.registry.get('notes.search').execute({ query: 'DENTIST' }, f.context) as { privacy: string; hits: Array<{ path: string; lines: string; excerpt: string }> };
  expect(found.privacy).toBe('local-only');
  expect(found.hits[0]).toEqual({ path: 'dentist.md', lines: '1-2', excerpt: '# Health\nDENTIST_FRIDAY_PRIVATE\n' });
  expect(await f.registry.get('notes.read').execute({ path: 'dentist.md' }, f.context)).toEqual({
    privacy: 'local-only', path: 'dentist.md', text: '# Health\nDENTIST_FRIDAY_PRIVATE\n', truncated: false });
  await f.knowledge.detach();
  expect(f.registry.describe().some(tool => tool.id.startsWith('notes.'))).toBe(false);
});

it('refuses paths outside the vault, linked files and non-Markdown files', async () => {
  const f = await fixture();
  await f.knowledge.selectRoot(f.vault); await f.knowledge.reindex();
  for (const path of ['../outside.md', 'linked.md', 'missing.md', '/etc/hosts', 'dentist.txt'])
    await expect(f.registry.get('notes.read').execute({ path }, f.context)).rejects.toMatchObject({ code: 'tool.fileMissing' });
});

it('makes a task and its conversation local-only after a note is read', async () => {
  const f = await fixture();
  await f.knowledge.selectRoot(f.vault); await f.knowledge.reindex();
  const repo = new DomainRepository(join(f.root, 'profile'), { getVaultKey: async () => Buffer.alloc(32, 3) }); await repo.initialize();
  const chat = new ChatService(repo), work = new ChatWorkService(repo);
  const session = await chat.createSession('Notes', 'normal');
  const assistant = await chat.addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'streaming', errorCode: null });
  await work.begin({ sessionId: session.id, runId: f.context.runId, assistantMessageId: assistant.id, goal: 'When is the dentist?', privacy: 'cloud-allowed' });
  const output = await f.registry.get('notes.search').execute({ query: 'DENTIST' }, f.context);
  await work.recordTool(f.context.runId, 'notes.search', { query: 'DENTIST' }, output);
  expect(work.current(f.context.runId)?.privacy).toBe('local-only');
  expect(repo.snapshot().chatSessions.find(item => item.id === session.id)).toMatchObject({ historyPrivacy: 'local-only', knowledgeLocalOnly: true });
});

it.each(['cloud', 'remote'] as const)('uses a shareable view in %s and records shareable results without making chat private', async destination => {
  const f = await fixture();
  await mkdir(join(f.vault, 'Public'));
  await writeFile(join(f.vault, 'Public', 'entry.md'), '# Reference\nDENTIST_PUBLIC_FIXTURE');
  await f.knowledge.selectRoot(f.vault);
  await f.knowledge.setFolderSharing('Public', 'shareable');
  await f.knowledge.reindex();
  f.route(destination);
  const { runId } = f.context;
  const repo = new DomainRepository(join(f.root, 'profile'), { getVaultKey: async () => Buffer.alloc(32, 4) });
  await repo.initialize();
  const chat = new ChatService(repo), work = new ChatWorkService(repo);
  const session = await chat.createSession('Notes', 'normal');
  const assistant = await chat.addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'streaming', errorCode: null });
  await work.begin({ sessionId: session.id, runId, assistantMessageId: assistant.id, goal: 'Find a reference', privacy: 'cloud-allowed' });
  const result = await f.registry.get('notes.search').execute({ query: 'DENTIST' }, f.context);
  expect(result).toMatchObject({ privacy: 'cloud-allowed', hits: [{ path: 'Public/entry.md' }] });
  expect(JSON.stringify(result)).not.toMatch(/dentist\.md|DENTIST_FRIDAY_PRIVATE|vault/);
  await work.recordTool(runId, 'notes.search', { query: 'DENTIST' }, result);
  expect(work.current(runId)?.privacy).toBe('cloud-allowed');
  await expect(f.registry.get('notes.read').execute({ path: 'dentist.md' }, f.context)).rejects.toMatchObject({ code: 'knowledge.folderPrivate' });
});

it('drops an in-progress result when its model destination changes', async () => {
  const f = await fixture();
  await f.knowledge.selectRoot(f.vault); await f.knowledge.reindex();
  const call = f.registry.get('notes.search').execute({ query: 'DENTIST' }, f.context);
  f.route('cloud');
  await expect(call).rejects.toMatchObject({ code: 'knowledge.policyChanged' });
  expect(f.recordResult).not.toHaveBeenCalled();
});
