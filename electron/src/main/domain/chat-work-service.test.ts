import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ChatRequestPreparation, ContextTrace, MemoryItem } from '../../shared';
import { ChatService } from './chat-service';
import { ChatWorkService } from './chat-work-service';
import { DomainRepository } from './repository';
import { historyLookupReference } from './chat-history-lineage';
import { recentDigest } from './companion-recent-state';
import { prepareChatContext } from './chat-context';
import { mergeTurnContextTrace } from '../providers/chat-request-policy';
import { chatWorkTaskSchema } from './chat-work-schemas';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const trace = (sessionId: string, patch: Partial<ContextTrace> = {}): ContextTrace => ({
  version: 1, memoryReferences: [], historyMessageIds: [], scope: { kind: 'session', sessionId }, privacy: 'cloud-allowed', lineage: 'complete', ...patch,
});
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deskpet-work-')); roots.push(directory);
  const path = join(directory, 'profile.enc.json'); let locked = false;
  const vault = { getVaultKey: async () => { if (locked) throw new Error('Fixture vault locked'); return Buffer.alloc(32, 72); } };
  const reopen = async () => { const repository = new DomainRepository(path, vault); await repository.initialize(); return repository; };
  const repository = await reopen(), chat = new ChatService(repository), work = new ChatWorkService(repository);
  const session = await chat.createSession('Synthetic current task', 'normal');
  const question = await chat.addMessage({ sessionId: session.id, role: 'user', content: 'Write a researched comparison.', status: 'complete', errorCode: null });
  const assistant = await chat.addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'streaming', errorCode: null });
  await repository.transaction((state) => { state.chatMessages.find((message) => message.id === assistant.id)!.contextTrace = trace(session.id); });
  const runId = randomUUID(), begin = { sessionId: session.id, assistantMessageId: assistant.id, runId, goal: question.content, privacy: 'cloud-allowed' as const };
  const task = await work.begin(begin);
  const saved = async (content: string, patch: Partial<ChatMessage> = {}, sourceSessionId?: string) => {
    const source = sourceSessionId ? repository.snapshot().chatSessions.find((item) => item.id === sourceSessionId)! : await chat.createSession('Synthetic source archive', 'normal');
    const message = await chat.addMessage({ sessionId: source.id, role: 'user', content, status: 'complete', errorCode: null });
    await repository.transaction((state) => { Object.assign(state.chatMessages.find((item) => item.id === message.id)!, patch); });
    return repository.snapshot().chatMessages.find((item) => item.id === message.id)!;
  };
  return { repository, chat, work, session, question, assistant, task, begin, runId, path, reopen, saved, lock: (value: boolean) => { locked = value; } };
};
const preparation = (contextTrace: ContextTrace, runId: string, questionId: string): ChatRequestPreparation => ({
  requestId: randomUUID(), runId, bindingDigest: 'a'.repeat(64), expectedBodySHA256: 'b'.repeat(64), inputEstimate: 30,
  maxInputTokens: 4096, maxOutputTokens: 512, capacitySource: 'configured', contextTrace, userMessageIds: [questionId],
});
const memory = (): MemoryItem => ({ id: randomUUID(), text: 'Synthetic remembered fact.', tags: [], source: 'user', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  contextMetadata: { version: 1, trust: 'host-confirmed', origin: 'manual-user', revision: 1, privacy: 'cloud-allowed', scope: { kind: 'global' },
    sourceReferences: [{ kind: 'manual-user', actionId: randomUUID() }], sentCount: 0, lastSentAt: null } });

describe('durable host-owned chat task records', () => {
  it('persists encrypted plans and host outcomes, deduplicates starts, and recovers running work as interrupted', async () => {
    const f = await fixture();
    expect(await f.work.begin(f.begin)).toEqual(f.task);
    await f.work.update(f.runId, { plan: ['Read primary source', 'Write comparison'], notes: 'SYNTHETIC_PRIVATE_WORK_NOTE', nextStep: 'Read source.' });
    expect(await readFile(f.path, 'utf8')).not.toContain('SYNTHETIC_PRIVATE_WORK_NOTE');
    const reopened = await f.reopen(), work = new ChatWorkService(reopened);
    expect(await work.recoverInterrupted()).toBe(1); expect(await work.recoverInterrupted()).toBe(0);
    expect(work.get(f.session.id, f.task.id)).toMatchObject({ status: 'interrupted', plan: ['Read primary source', 'Write comparison'], nextStep: 'Read source.' });
    await expect(work.update(f.runId, { notes: 'Too late.' })).rejects.toThrow('chatWork.unavailable');
  });

  it('rejects owner conflicts and model attempts to change status, identity, privacy or evidence', async () => {
    const f = await fixture(), before = f.repository.snapshot();
    await expect(f.work.begin({ ...f.begin, goal: 'A different task.' })).rejects.toThrow('chatWork.conflict');
    for (const patch of [{ status: 'completed' }, { privacy: 'cloud-allowed' }, { sessionId: randomUUID() }, { sources: [] }, { artifacts: [] }, { historyLookupReferences: [] }]) {
      await expect(f.work.update(f.runId, patch as never)).rejects.toThrow();
    }
    expect(f.repository.snapshot()).toEqual(before);
    const other = await f.chat.createSession('Other owner', 'normal');
    expect(f.work.get(other.id, f.task.id)).toBeNull(); expect(f.work.list(other.id).items).toEqual([]);
  });

  it('checks revocation after a transaction waits and acknowledges no plan after a write failure', async () => {
    const f = await fixture(); let release!: () => void, accepting = true;
    const blocker = f.repository.transaction(async () => { await new Promise<void>((resolve) => { release = resolve; }); });
    await Promise.resolve();
    const update = f.work.update(f.runId, { notes: 'Revoked.' }, () => { if (!accepting) throw new Error('revoked'); });
    const rejected = expect(update).rejects.toThrow('revoked'); accepting = false; release(); await blocker; await rejected;
    expect(f.work.current(f.runId)?.notes).toBe('');
    f.lock(true); await expect(f.work.update(f.runId, { notes: 'Uncommitted.' })).rejects.toThrow('Fixture vault locked'); f.lock(false);
    expect(f.work.current(f.runId)?.notes).toBe('');
  });

  it('records only valid successful tool evidence, deduplicates it, and bounds retention visibly', async () => {
    const f = await fixture();
    await f.work.recordTool(f.runId, 'web.read', { url: 'https://forged.example/' }, { url: 'invalid url', text: 'Invalid output.' });
    await f.work.recordTool(f.runId, 'web.read', {}, { ok: false, url: 'https://failed.example/', text: 'Failed.' });
    await f.work.recordTool(f.runId, 'workspace.write', {}, { written: true, path: '../escape.md', bytes: 1, sha256: 'a'.repeat(64) });
    expect(f.work.current(f.runId)).toMatchObject({ sources: [], artifacts: [] });
    for (let index = 0; index < 42; index += 1) await f.work.recordTool(f.runId, 'web.read', {}, { url: `https://example.test/${index}`, text: `Title: Source ${index}`, sourceSHA256: 'a'.repeat(64) });
    await f.work.recordTool(f.runId, 'web.read', {}, { url: 'https://example.test/41', text: 'Title: Rechecked source', sourceSHA256: 'b'.repeat(64) });
    await f.work.recordTool(f.runId, 'workspace.write', {}, { written: true, path: 'reports/result.md', bytes: 19, sha256: 'c'.repeat(64) });
    const task = f.work.current(f.runId)!;
    expect(task.sources).toHaveLength(40); expect(task.sources[0]?.url).toBe('https://example.test/2');
    expect(task.sources.at(-1)).toMatchObject({ title: 'Rechecked source', sha256: 'b'.repeat(64) });
    expect(task).toMatchObject({ evidenceTruncated: true, artifacts: [{ path: 'reports/result.md', bytes: 19, sha256: 'c'.repeat(64) }] });
    await f.work.finish(f.runId, 'completed', 'A verified result.');
    await f.work.finish(f.runId, 'failed', 'Cannot replace a terminal outcome.');
    expect(f.work.current(f.runId)).toMatchObject({ status: 'completed', summary: 'A verified result.' });
  });

  it.each(['workspace.read', 'workspace.list', 'workspace.search', 'system.summary'])('propagates successful %s privacy to the current task and conversation', async (toolId) => {
    const f = await fixture();
    await f.work.recordTool(f.runId, toolId, {}, { ok: false }); expect(f.work.current(f.runId)?.privacy).toBe('cloud-allowed');
    await f.work.recordTool(f.runId, toolId, {}, { text: 'Synthetic local material' });
    expect(f.work.current(f.runId)?.privacy).toBe('local-only'); expect(f.repository.snapshot().chatSessions[0]?.historyPrivacy).toBe('local-only');
    expect(f.work.get(f.session.id, f.task.id, 'remote')).toBeNull(); expect(f.work.list(f.session.id, { destination: 'unknown' }).items).toEqual([]);
  });

  it('retains public skill dependencies without tainting subsequent web evidence', async () => {
    const f = await fixture(), id = randomUUID(), text = 'Compare primary source evidence.';
    const digest = createHash('sha256').update(text).digest('hex');
    await f.repository.transaction(state => { state.desktopExtensions.skills.push({ id, name: 'Public procedure', text, enabled: true, exposure: 'public', revision: 4, digest }); });
    const reference = { id, revision: 4, digest };
    await f.work.recordTool(f.runId, 'skills.list', { scope: 'public' }, { skills: [{ ...reference, name: 'Public procedure', description: text }], privacy: 'cloud-allowed' });
    await f.work.recordTool(f.runId, 'skills.read', { id }, { ...reference, text, privacy: 'cloud-allowed' });
    await f.work.recordTool(f.runId, 'web.read', {}, { url: 'https://example.test/evidence', text: 'Title: Synthetic evidence' });
    expect(f.work.current(f.runId)).toMatchObject({ privacy: 'cloud-allowed', skillReferences: [reference], sources: [{ url: 'https://example.test/evidence' }] });
    expect(f.repository.snapshot().chatSessions.find(item => item.id === f.session.id)?.historyPrivacy).not.toBe('local-only');
    expect((await f.reopen()).snapshot().chatWorkTasks.find(item => item.id === f.task.id)?.skillReferences).toEqual([reference]);
  });

  it('records private catalog lineage and immediately confines its task and conversation', async () => {
    const f = await fixture(), id = randomUUID(), text = 'PRIVATE_METHOD_SUMMARY';
    const digest = createHash('sha256').update(text).digest('hex');
    await f.repository.transaction(state => { state.desktopExtensions.skills.push({ id, name: 'Local procedure', text, enabled: true, revision: 1, digest }); });
    await f.work.recordTool(f.runId, 'skills.list', { scope: 'local' }, { skills: [{ id, revision: 1, digest, name: 'Local procedure', description: text }], privacy: 'local-only' });
    expect(f.work.current(f.runId)).toMatchObject({ privacy: 'local-only', skillReferences: [{ id, revision: 1, digest }] });
    expect(f.repository.snapshot().chatSessions.find(item => item.id === f.session.id)?.historyPrivacy).toBe('local-only');
    expect(f.work.get(f.session.id, f.task.id, 'remote')).toBeNull();
  });

  it.each(['revision', 'digest', 'disabled'] as const)('rejects a stale skill %s before persisting evidence', async mismatch => {
    const f = await fixture(), id = randomUUID(), text = 'Approved method';
    const digest = createHash('sha256').update(text).digest('hex');
    await f.repository.transaction(state => { state.desktopExtensions.skills.push({ id, name: 'Procedure', text, enabled: mismatch !== 'disabled', exposure: 'public', revision: 2, digest }); });
    const before = f.repository.snapshot();
    await expect(f.work.recordTool(f.runId, 'skills.read', { id }, { id, revision: mismatch === 'revision' ? 1 : 2, digest: mismatch === 'digest' ? '0'.repeat(64) : digest,
      text, privacy: 'cloud-allowed' })).rejects.toThrow('extensions.changed');
    expect(f.repository.snapshot()).toEqual(before);
  });

  it('checks skill revision again after a queued evidence transaction waits', async () => {
    const f = await fixture(), id = randomUUID(), text = 'Approved method';
    const digest = createHash('sha256').update(text).digest('hex');
    await f.repository.transaction(state => { state.desktopExtensions.skills.push({ id, name: 'Procedure', text, enabled: true, exposure: 'public', revision: 2, digest }); });
    let release!: () => void;
    const revoke = f.repository.transaction(async state => {
      await new Promise<void>(resolve => { release = resolve; });
      state.desktopExtensions.skills[0]!.revision = 3; state.desktopExtensions.skills[0]!.exposure = 'local-only';
    });
    await Promise.resolve();
    const record = f.work.recordTool(f.runId, 'skills.list', { scope: 'public' }, { skills: [{ id, revision: 2, digest }], privacy: 'cloud-allowed' });
    const rejected = expect(record).rejects.toThrow('extensions.changed');
    release(); await revoke; await rejected;
    expect(f.work.current(f.runId)?.skillReferences).toBeUndefined();
  });

  it('records MCP document evidence, keeps snippets separate, and confines authenticated data to the device', async () => {
    const f = await fixture(), source = { url: 'https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/types/records',
      title: 'Microsoft Learn · microsoft_docs_fetch', sha256: 'd'.repeat(64) };
    await f.work.recordTool(f.runId, 'mcp.microsoft_docs_search', {}, { text: 'Search excerpt.', source });
    await f.work.recordTool(f.runId, 'mcp.microsoft_docs_fetch', {}, { ok: false, source });
    expect(f.work.current(f.runId)?.sources).toEqual([]);
    await f.work.recordTool(f.runId, 'mcp.microsoft_docs_fetch', {}, { text: 'Document contents.', source });
    expect(f.work.current(f.runId)).toMatchObject({ sources: [source], privacy: 'cloud-allowed' });
    await f.work.recordTool(f.runId, 'mcp.github_search_repositories', {}, { text: 'Authenticated response.' });
    expect(f.work.current(f.runId)?.privacy).toBe('local-only');
    expect(f.work.get(f.session.id, f.task.id, 'remote')).toBeNull();
  });

  it('fails closed for unknown derived records and accepts legacy tasks without optional lookup metadata', async () => {
    const f = await fixture();
    await f.repository.transaction((state) => { delete state.chatMessages.find((message) => message.id === f.assistant.id)!.contextTrace; });
    expect(f.work.get(f.session.id, f.task.id)?.id).toBe(f.task.id);
    await f.work.update(f.runId, { nextStep: 'Derived next step.' });
    expect(f.work.get(f.session.id, f.task.id)).toBeNull();
    const { historyLookupReferences: _references, ...old } = f.task; void _references;
    expect(chatWorkTaskSchema.parse(old).historyLookupReferences).toEqual([]);
  });
});

describe('literal history lookup and durable provenance', () => {
  it('returns bounded literal pages and snippets, with a stable original-content digest and separate session IDs', async () => {
    const f = await fixture(), content = `${'A'.repeat(700)}needle ${'汉'.repeat(600)} end`;
    const source = await f.saved(content), context = { sessionId: f.session.id, destination: 'remote' as const };
    const search = f.work.searchHistory(context, { query: 'NEEDLE', limit: 1 });
    expect(search.items).toHaveLength(1);
    const hit = search.items[0]!; expect(hit.sessionId).toBe(source.sessionId); expect(hit.snippet).toBe(content.slice(hit.offset, hit.offset + 480));
    expect(hit.sourceSHA256).toBe(createHash('sha256').update(content).digest('hex'));
    const page = f.work.readHistory(context, { messageId: source.id, maxCharacters: 256 })!;
    expect(page).toMatchObject({ text: content.slice(0, 256), nextOffset: 256, truncated: true, sourceSHA256: hit.sourceSHA256 });
    expect(f.work.readHistory(context, { messageId: source.id, offset: page.nextOffset!, maxCharacters: 256 })?.text).toBe(content.slice(256, 512));
    expect(f.work.searchHistory(context, { query: 'needle.*' }).items).toEqual([]);
    expect(f.work.searchHistory(context, { query: 'needle', targetSessionId: f.session.id }).items).toEqual([]);
    expect(f.work.readHistory(context, { messageId: f.question.id })).toBeNull();
  });

  it('excludes deleted, unknown, incomplete, unpublished, missing-ancestor and cyclic source messages', async () => {
    const f = await fixture(), context = { sessionId: f.session.id, destination: 'local' as const };
    const unknown = await f.saved('needle unknown');
    await f.repository.transaction((state) => { delete state.chatMessages.find((message) => message.id === unknown.id)!.contextTrace; });
    const streaming = await f.saved('needle streaming', { status: 'streaming' });
    const unpublished = await f.saved('needle unpublished', { automationTriggerId: randomUUID() });
    const missing = await f.saved('needle missing');
    await f.repository.transaction((state) => { state.chatMessages.find((message) => message.id === missing.id)!.contextTrace!.historyMessageIds = [randomUUID()]; });
    const cyclic = await f.saved('needle cyclic');
    await f.repository.transaction((state) => { state.chatMessages.find((message) => message.id === cyclic.id)!.contextTrace!.historyLookupReferences = [historyLookupReference(cyclic)]; });
    const deleted = await f.saved('needle deleted');
    await f.repository.transaction((state) => { state.chatSessions.find((session) => session.id === deleted.sessionId)!.deletedAt = new Date().toISOString(); });
    for (const source of [unknown, streaming, unpublished, missing, cyclic, deleted]) expect(f.work.readHistory(context, { messageId: source.id })).toBeNull();
    expect(f.work.searchHistory(context, { query: 'needle' }).items).toEqual([]);
  });

  it('blocks cross-session private output remotely and persists local-only taint before a later provider turn', async () => {
    const f = await fixture(), source = await f.saved('SYNTHETIC_PRIVATE_LOOKUP');
    await f.repository.transaction((state) => { state.chatSessions.find((session) => session.id === source.sessionId)!.historyPrivacy = 'local-only'; });
    const local = { sessionId: f.session.id, destination: 'local' as const };
    expect(f.work.searchHistory({ ...local, destination: 'remote' }, { query: 'SYNTHETIC_PRIVATE' }).items).toEqual([]);
    expect(f.work.readHistory({ ...local, destination: 'unknown' }, { messageId: source.id })).toBeNull();
    const page = f.work.readHistory(local, { messageId: source.id })!;
    expect(page.privacy).toBe('local-only');
    await f.work.recordTool(f.runId, 'history.read', { messageId: source.id }, page);
    expect(f.work.current(f.runId)).toMatchObject({ privacy: 'local-only', historyLookupReferences: [historyLookupReference(source)] });
    expect(f.repository.snapshot().chatSessions.find((session) => session.id === f.session.id)?.historyPrivacy).toBe('local-only');
    await expect(f.chat.prepareRequest(f.assistant.id, preparation(trace(f.session.id, { historyLookupReferences: [historyLookupReference(source)] }), f.runId, f.question.id))).rejects.toThrow('chat.contextStale');
  });

  it('withdraws rolling-summary descendants from cross-session lookup and prepared requests', async () => {
    const f = await fixture();
    const original = await f.saved('Original chat continuity fact.');
    const answer = await f.saved('Continuity answer in another conversation.', { role: 'assistant' });
    const descendant = await f.saved('Continuity descendant after reading history.', { role: 'assistant' });
    const revision = recentDigest('synthetic recent summary version');
    await f.repository.transaction(state => {
      state.companionRecent.entries = [{ source: 'desktop', id: original.id, sessionId: original.sessionId, at: original.createdAt, sha: recentDigest(original.content) }];
      state.companionRecent.summary = { text: original.content, revision, updatedAt: original.createdAt, localOnly: false, refs: [original.id] };
      state.chatMessages.find(item => item.id === answer.id)!.contextTrace = trace(answer.sessionId, { recentRevision: revision });
      state.chatMessages.find(item => item.id === descendant.id)!.contextTrace = trace(descendant.sessionId, { historyLookupReferences: [historyLookupReference(answer)] });
    });
    const remote = { sessionId: f.session.id, destination: 'remote' as const };
    expect(f.work.readHistory(remote, { messageId: answer.id })?.text).toBe(answer.content);
    expect(f.work.readHistory(remote, { messageId: descendant.id })?.text).toBe(descendant.content);
    const receipt = await f.chat.prepareRequest(f.assistant.id, preparation(trace(f.session.id, {
      historyLookupReferences: [historyLookupReference(descendant)],
    }), f.runId, f.question.id));
    expect(() => f.chat.assertPreparedRequest(f.assistant.id, receipt.requestId)).not.toThrow();
    await f.repository.transaction(state => {
      state.chatSessions.find(item => item.id === original.sessionId)!.historyPrivacy = 'local-only';
    });
    expect(f.work.searchHistory(remote, { query: 'Continuity' }).items).toEqual([]);
    expect(f.work.readHistory(remote, { messageId: descendant.id })).toBeNull();
    expect(() => f.chat.assertPreparedRequest(f.assistant.id, receipt.requestId)).toThrow('chat.contextStale');
  });

  it('checks memory revisions, recall suppression and session scope through every source ancestor', async () => {
    const f = await fixture(), fact = memory(), source = await f.saved('needle source');
    const derived = await f.saved('needle derived', {}, source.sessionId);
    await f.repository.transaction((state) => {
      state.memories.push(fact);
      state.chatMessages.find((message) => message.id === source.id)!.contextTrace!.memoryReferences = [{ id: fact.id, revision: 1 }];
      state.chatMessages.find((message) => message.id === derived.id)!.contextTrace!.historyMessageIds = [source.id];
    });
    const context = { sessionId: f.session.id, destination: 'local' as const };
    expect(f.work.readHistory(context, { messageId: derived.id })?.text).toBe('needle derived');
    f.repository.suppressMemoryRecall([fact.id]); expect(f.work.readHistory(context, { messageId: derived.id })).toBeNull(); f.repository.clearMemoryRecallSuppression([fact.id]);
    await f.repository.transaction((state) => { state.memories[0]!.contextMetadata!.scope = { kind: 'session', sessionId: source.sessionId }; });
    expect(f.work.readHistory(context, { messageId: derived.id })).toBeNull();
    await f.repository.transaction((state) => { state.memories[0]!.contextMetadata!.scope = { kind: 'global' }; state.memories[0]!.contextMetadata!.revision = 2; });
    expect(f.work.searchHistory(context, { query: 'needle' }).items).toEqual([]);
  });

  it('pins actual returned source versions and rejects a change between the lookup and its durable recording', async () => {
    const f = await fixture(), source = await f.saved('needle initial');
    const page = f.work.searchHistory({ sessionId: f.session.id, destination: 'remote' }, { query: 'needle' });
    await f.repository.transaction((state) => { state.chatMessages.find((message) => message.id === source.id)!.content = 'needle corrected'; });
    await expect(f.work.recordTool(f.runId, 'history.search', {}, page)).rejects.toThrow('chat.contextStale');
    expect(f.work.current(f.runId)?.historyLookupReferences).toEqual([]);
  });

  it('revalidates cross-session lineage immediately before dispatch and prevents a continuation from dropping it', async () => {
    const f = await fixture(), source = await f.saved('Synthetic source answer.');
    const reference = historyLookupReference(source), sourceTrace = trace(f.session.id, { historyLookupReferences: [reference] });
    const first = await f.chat.prepareRequest(f.assistant.id, preparation(sourceTrace, f.runId, f.question.id));
    expect(() => f.chat.assertPreparedRequest(f.assistant.id, first.requestId)).not.toThrow();
    await expect(f.chat.prepareRequest(f.assistant.id, preparation(trace(f.session.id), f.runId, f.question.id))).rejects.toThrow('chat.contextStale');
    await f.repository.transaction((state) => { state.chatMessages.find((message) => message.id === source.id)!.content = 'Corrected after preparation.'; });
    expect(() => f.chat.assertPreparedRequest(f.assistant.id, first.requestId)).toThrow('chat.contextStale');
    await expect(f.chat.prepareRequest(f.assistant.id, preparation(sourceTrace, f.runId, f.question.id))).rejects.toThrow('chat.contextStale');
  });

  it('propagates lookup lineage into later derived replies and excludes all descendants when the source is deleted', async () => {
    const f = await fixture(), source = await f.saved('Original cross-session source.');
    const page = f.work.readHistory({ sessionId: f.session.id, destination: 'remote' }, { messageId: source.id })!;
    await f.work.recordTool(f.runId, 'history.read', {}, page);
    const inherited = f.work.current(f.runId)!.historyLookupReferences;
    await f.chat.prepareRequest(f.assistant.id, preparation(trace(f.session.id, { historyLookupReferences: inherited }), f.runId, f.question.id));
    await f.chat.updateMessage(f.assistant.id, { content: 'Derived answer from the original source.', status: 'complete', errorCode: null });
    await f.work.finish(f.runId, 'completed', 'Derived answer from the original source.');
    const context = () => { const state = f.repository.snapshot(); return prepareChatContext({ sessionId: f.session.id,
      history: state.chatMessages.filter((message) => message.sessionId === f.session.id), memories: [], consolidationState: state,
      query: 'Continue.', locale: 'en', binding: { providerId: randomUUID(), kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'fixture' },
      requiredMessages: [{ role: 'user', content: 'Continue.' }], maxOutputTokens: 512,
      contextBudget: { contextWindowTokens: 8192, safetyMarginTokens: 256, capacitySource: 'configured' } }); };
    expect(context().projection.historyLookupReferences).toEqual(inherited);
    expect(context().messages.some((message) => message.content.includes('Derived answer'))).toBe(true);
    expect(f.work.get(f.session.id, f.task.id, 'remote')).not.toBeNull();
    await f.repository.transaction((state) => { state.chatSessions.find((session) => session.id === source.sessionId)!.deletedAt = new Date().toISOString(); });
    expect(context().messages.some((message) => message.content.includes('Derived answer'))).toBe(false);
    expect(f.work.get(f.session.id, f.task.id)).toBeNull();
    expect(f.work.readHistory({ sessionId: f.session.id, destination: 'local' }, { messageId: f.assistant.id })).toBeNull();
  });

  it('merges lookup references across tool rounds and rejects conflicting versions', () => {
    const sessionId = randomUUID(), reference = { sessionId: randomUUID(), messageId: randomUUID(), contentSHA256: 'a'.repeat(64) };
    const previous = trace(sessionId, { historyLookupReferences: [reference] });
    expect(mergeTurnContextTrace(previous, trace(sessionId)).historyLookupReferences).toEqual([reference]);
    expect(() => mergeTurnContextTrace(previous, trace(sessionId, { historyLookupReferences: [{ ...reference, contentSHA256: 'b'.repeat(64) }] }))).toThrow('chat.contextStale');
  });
});
