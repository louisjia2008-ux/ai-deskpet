// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ChatMessage, ProviderConfig } from '../../shared';
import type { ProviderAdapter, ProviderChatRequest } from '../providers/types';
import { ChatService } from './chat-service';
import { prepareChatContext } from './chat-context';
import { CompanionRecentService, recentPrompt } from './companion-recent-service';
import { currentRecent, recentForDestination, recentTraceAllowed, RECENT_WINDOW_MS, supersededChat } from './companion-recent-state';
import { DomainRepository } from './repository';
import { MemoryService } from './memory-service';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const exam = '我明天要考试';
const config: ProviderConfig = { id: randomUUID(), name: 'Synthetic local model', enabled: true,
  secretState: 'missing', kind: 'ollama', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1',
  supportsTools: false, localExecutionConfirmed: true };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-companion-recent-'));
  roots.push(root);
  const file = join(root, 'profile.enc.json');
  const vault = { getVaultKey: async () => Buffer.alloc(32, 13) };
  const repo = new DomainRepository(file, vault);
  await repo.initialize();
  const chat = new ChatService(repo);
  const requests: ProviderChatRequest[] = [];
  let now = Date.now();
  let local = true;
  let beforeSend: (() => Promise<void>) | undefined;
  const adapter: ProviderAdapter = {
    listModels: async () => [],
    async *streamChat(request, _, options) {
      await beforeSend?.();
      await options?.validateBeforeSend?.();
      options?.assertCurrent?.();
      requests.push(request);
      yield { type: 'text', text: JSON.stringify({ summary: exam }) };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
  const service = new CompanionRecentService(repo, {
    available: () => true,
    capture: async () => ({
      provider: local ? config : { ...config, kind: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', localExecutionConfirmed: false }, model: config.model, adapter,
      inspection: { contextWindowTokens: null, executionDestination: local ? 'local' : 'remote', source: 'unknown' },
    }),
    changed: () => undefined,
    now: () => now,
  });
  const note = async (source: 'desktop' | 'qq' | 'wechat', content: string, scope: 'owner' | 'group' = 'owner') => {
    const session = await chat.createSession('Synthetic fixture', 'normal', new Date(now));
    await repo.transaction(state => { state.chatSessions.find(item => item.id === session.id)!.companionScope = scope; });
    const message = await chat.addMessage({ sessionId: session.id, role: 'user', content, status: 'complete', errorCode: null }, new Date(now));
    await service.note(source, session.id, [message.id]);
    return session;
  };
  return { repo, service, file, vault, note, requests, now: () => now, advance: (ms: number) => { now += ms; },
    remote: () => { local = false; }, intercept: (fn: () => Promise<void>) => { beforeSend = fn; } };
}

it('keeps a bounded encrypted owner summary, with whole-window expiry and a durable clear', async () => {
  const f = await fixture();
  await f.note('desktop', exam);
  await f.note('qq', 'synthetic-group-qq', 'group');
  await f.note('wechat', 'synthetic-group-wechat', 'group');
  await f.service.tick();
  expect(f.requests).toHaveLength(1);
  expect(JSON.stringify(f.requests[0]!.messages)).toContain(exam);
  expect(JSON.stringify(f.requests[0]!.messages)).not.toContain('synthetic-group');
  expect(f.service.status()).toMatchObject({ text: exam, localOnly: false, containsLocal: false });
  expect(await readFile(f.file, 'utf8')).not.toContain(exam);
  const reopened = new DomainRepository(f.file, f.vault);
  await reopened.initialize();
  expect(currentRecent(reopened.snapshot(), f.now())?.text).toBe(exam);
  expect(currentRecent(reopened.snapshot(), f.now() + RECENT_WINDOW_MS)).toBeNull();
  f.advance(2);
  await f.service.clear();
  await f.service.tick();
  expect(f.service.status().text).toBe('');
  expect(f.repo.read('companionRecent').entries).toEqual([]);
});

it('omits local-only data on cloud requests, including replies derived from a revoked summary', async () => {
  const f = await fixture();
  await f.note('desktop', exam);
  await f.service.tick();
  const summary = currentRecent(f.repo.snapshot(), f.now())!;
  const prepare = (destination: 'local' | 'remote', recent: NonNullable<ReturnType<typeof currentRecent>>) => prepareChatContext({
    sessionId: randomUUID(), history: [], memories: [], query: 'fixture', locale: 'zh-CN',
    recent: { prompt: recentPrompt(recent.text), revision: recent.revision, privacy: recent.localOnly ? 'local-only' : 'cloud-allowed' },
    binding: { providerId: config.id, kind: config.kind, baseUrl: config.baseUrl, model: config.model, serviceExecution: destination, localExecutionConfirmed: true },
    requiredMessages: [{ role: 'user', content: '最近怎么样' }],
    maxOutputTokens: 512, contextBudget: { contextWindowTokens: 16_384, safetyMarginTokens: 256, capacitySource: 'configured' },
  });
  expect(prepare('remote', summary).messages.map(item => item.content).join(' ')).toContain(exam);
  await f.service.setLocalOnly(true);
  const restricted = currentRecent(f.repo.snapshot(), f.now())!;
  expect(recentTraceAllowed(f.repo.snapshot(), summary.revision, 'remote')).toBe(false);
  expect(JSON.stringify(prepare('remote', restricted).messages)).not.toContain(exam);
  expect(prepare('local', restricted).projection.privacy).toBe('local-only');
  expect(JSON.stringify(prepare('local', restricted).messages)).toContain(exam);
});

it('rechecks the original source before a background cloud dispatch', async () => {
  const f = await fixture();
  f.remote();
  const session = await f.note('desktop', exam);
  f.intercept(() => f.repo.transaction(state => { state.chatSessions.find(item => item.id === session.id)!.historyPrivacy = 'local-only'; }));
  await expect(f.service.tick()).rejects.toThrow('chat.contextStale');
  expect(f.requests).toHaveLength(0);
  await f.service.tick();
  expect(f.requests).toHaveLength(0);
  expect(f.service.status()).toMatchObject({ text: exam, containsLocal: true });
});

it('retains only the owner’s Minecraft chat as local material', async () => {
  const f = await fixture();
  f.remote();
  await f.service.noteMinecraft(randomUUID(), '星期天一起盖木屋', f.now());
  await f.service.tick();
  expect(f.requests).toHaveLength(0);
  expect(f.service.status()).toMatchObject({ text: '星期天一起盖木屋', containsLocal: true });
});

it('rebuilds a cloud view from shareable sources when the local view includes Minecraft', async () => {
  const f = await fixture();
  await f.note('desktop', exam);
  await f.service.noteMinecraft(randomUUID(), '星期天一起盖木屋', f.now());
  f.remote();
  await f.service.tick();
  expect(JSON.stringify(f.requests[0]?.messages)).toContain(exam);
  expect(JSON.stringify(f.requests[0]?.messages)).not.toContain('星期天一起盖木屋');
  expect(f.service.status().text).toContain('星期天一起盖木屋');
  expect(recentForDestination(f.repo.snapshot(), 'remote', f.now())?.text).toBe(exam);
});

it('drops a remember, correct and forget exchange once its memory is deleted, and keeps a request that found nothing', async () => {
  const f = await fixture();
  const chat = new ChatService(f.repo), memory = new MemoryService(f.repo);
  const session = await chat.createSession('Synthetic fixture', 'normal', new Date(f.now()));
  await f.repo.transaction(state => { state.chatSessions.find(item => item.id === session.id)!.companionScope = 'owner'; });
  const turn = async (content: string, handle: (assistantId: string) => Promise<unknown>) => {
    const user = await chat.addMessage({ sessionId: session.id, role: 'user', content, status: 'complete', errorCode: null }, new Date(f.now()));
    const reply = await chat.addMessage({ sessionId: session.id, role: 'assistant', content: '好的。', status: 'complete', errorCode: null }, new Date(f.now()));
    await handle(reply.id);
    await f.service.note('desktop', session.id, [user.id]);
  };
  await turn('请记住：我住在 SYNTHETIC_CITY', id => memory.saveFromChat(id, '我住在 SYNTHETIC_CITY'));
  await turn('把“SYNTHETIC_CITY”改成“SYNTHETIC_TOWN”', id => memory.editFromChat(id, 'SYNTHETIC_CITY', 'SYNTHETIC_TOWN'));
  await turn('忘记：SYNTHETIC_TOWN', id => memory.forgetFromChat(id, 'SYNTHETIC_TOWN'));
  await turn('忘记带伞了', id => memory.forgetFromChat(id, '带伞了'));
  expect(f.repo.snapshot().memoryTombstones.map(guard => guard.kind)).toEqual(['corrected', 'deleted']);
  await f.service.tick();
  const sent = JSON.stringify(f.requests.at(-1)!.messages);
  expect(sent).not.toContain('SYNTHETIC_');
  expect(sent).toContain('忘记带伞了');
});

it('drops an ordinary message once the memory taken from it is deleted, and withdraws the summary built on it', async () => {
  const f = await fixture();
  const session = await f.note('desktop', exam);
  await f.service.tick();
  const summary = currentRecent(f.repo.snapshot(), f.now())!;
  expect(summary.text).toBe(exam);
  const messageId = f.repo.snapshot().chatMessages.find(item => item.sessionId === session.id)!.id;
  await f.repo.transaction(state => {
    state.memoryTombstones.push({ id: randomUUID(), memoryId: randomUUID(), textDigest: 'a'.repeat(64),
      sourceEventIds: [createHash('sha256').update(`chat:${session.id}:${messageId}`).digest('hex')],
      identityKey: null, scope: { kind: 'global' }, deletedAt: new Date(f.now()).toISOString(), kind: 'deleted' });
  });
  expect(currentRecent(f.repo.snapshot(), f.now())).toBeNull();
  expect(recentTraceAllowed(f.repo.snapshot(), summary.revision, 'remote')).toBe(false);
  expect(recentForDestination(f.repo.snapshot(), 'local')).toBeNull();
});

it('pairs a reply with its follow-ups, reads offered choices, and does not pass a mark on to later replies', async () => {
  const sessionId = randomUUID(), at = new Date().toISOString(), deletedId = randomUUID();
  const message = (role: 'user' | 'assistant', extra: Partial<ChatMessage> = {}): ChatMessage =>
    ({ id: randomUUID(), sessionId, role, content: 'x', createdAt: at, status: 'complete', errorCode: null, ...extra });
  const request = message('user'), followup = message('user', { followupToMessageId: 'reply' });
  const choices = message('assistant', { memoryForget: { kind: 'choices', query: 'SYNTHETIC', totalMatches: 2,
    candidates: [{ id: deletedId, text: 'a', updatedAt: at }, { id: randomUUID(), text: 'b', updatedAt: at }] } });
  const later = message('assistant');
  const marked = supersededChat({ chatMessages: [request, followup, choices, later], memoryTombstones: [{ id: randomUUID(), memoryId: deletedId,
    textDigest: 'e'.repeat(64), sourceEventIds: [], identityKey: null, scope: { kind: 'global' }, deletedAt: at, kind: 'deleted' }] });
  expect([...marked.keys()].sort()).toEqual([request.id, followup.id, choices.id].sort());
});
