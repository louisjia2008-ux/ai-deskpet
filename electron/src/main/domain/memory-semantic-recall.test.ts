import { describe, expect, it, vi } from 'vitest';
import type { MemoryItem } from '../../shared';
import type { ChatContextBinding } from './chat-context-policy';
import { prepareChatContext } from './chat-context';
import { LocalMemoryRecall, MEMORY_RECALL_LIMITS, memoryRecallSearchResult } from './memory-semantic-recall';
import { rankRelevantMemories } from './memory-retrieval';

const binding: ChatContextBinding = { providerId: 'local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', localExecutionConfirmed: true };
const memory = (text: string, patch: Partial<NonNullable<MemoryItem['contextMetadata']>> = {}): MemoryItem => ({
  id: crypto.randomUUID(), text, tags: [], source: 'user', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z',
  contextMetadata: { version: 1, trust: 'host-confirmed', origin: 'manual-user', scope: { kind: 'global' }, privacy: 'local-only', revision: 1, sourceReferences: [], sentCount: 0, lastSentAt: null, ...patch },
});
const input = (query: string, memories: MemoryItem[]) => ({ sessionId: 'session', destination: 'local' as const, query, memories, signal: new AbortController().signal });
const prepare = (query: string, memories: MemoryItem[], memoryRecall?: ReturnType<LocalMemoryRecall['retrieve']>, overrideBinding = binding) => prepareChatContext({
  sessionId: 'session', locale: 'zh-CN', query, history: [], memories, binding: overrideBinding,
  ...(memoryRecall ? { memoryRecall } : {}), requiredMessages: [{ role: 'user', content: query }], maxOutputTokens: 512,
  contextBudget: { contextWindowTokens: 16384, safetyMarginTokens: 256, capacitySource: 'configured' },
});
const fixture = (vectors: Record<string, number[]>) => {
  const embed = vi.fn(async (texts: string[]) => texts.map(text => vectors[text.replace(/^search_(?:query|document): /u, '')] ?? [0, 0, 1]));
  return { embed, service: new LocalMemoryRecall({ embed }) };
};

describe('bounded local semantic memory recall', () => {
  it('keeps foreground retrieval immediate with no model requests or background jobs', () => {
    const f = fixture({});
    expect(f.service.retrieve(input('A previously unseen question', [memory('A saved note')]))).toMatchObject({ mode: 'lexical', reason: 'unavailable', matches: [] });
    expect(f.embed).not.toHaveBeenCalled();
  });

  it('uses keywords and standing style for a new chat question without claiming a prepared semantic result', async () => {
    const style = memory('我偏好简洁直接的回答，先给结论，再解释理由。');
    const walk = memory('周末徒步路线须避开陡峭山坡。');
    const preparedQuery = 'Choose a gentle hiking trail for Saturday.', nextQuery = 'Explain how photosynthesis works.';
    const f = fixture({ [preparedQuery]: [1, 0, 0], [walk.text]: [1, 0, 0] });
    await f.service.warm(input(preparedQuery, [style, walk]));
    const hints = f.service.retrieve(input(nextQuery, [style, walk]));
    expect(hints).toMatchObject({ mode: 'lexical', reason: 'unavailable', consideredCount: 0, matches: [] });
    expect(prepare(nextQuery, [style, walk], hints).projection.memoryReferences).toEqual([{ id: style.id, revision: 1 }]);
    expect(f.embed).toHaveBeenCalledOnce();
  });

  it.each([
    ['周末徒步路线须避开陡峭山坡。', 'Choose a gentle hiking trail for Saturday.'],
    ['我喜欢优先乘高铁出行。', 'Which transport should I book for my next trip?'],
  ])('uses controlled bilingual embeddings without adding a topic alias: %s', async (text, query) => {
    const note = memory(text), unrelated = memory('The project codename is Quartz.');
    expect(rankRelevantMemories([note, unrelated], query)).not.toContain(note);
    const f = fixture({ [query]: [1, 0, 0], [text]: [0.99, 0.01, 0] });
    const hints = await f.service.warm(input(query, [note, unrelated]));
    expect(hints).toMatchObject({ mode: 'semantic', consideredCount: 2 });
    const result = prepare(query, [note, unrelated], f.service.retrieve(input(query, [note, unrelated])));
    expect(result.projection.memoryReferences).toEqual([{ id: note.id, revision: 1 }]);
    expect(result.projection.privacy).toBe('local-only');
    expect(JSON.stringify(result.messages)).toContain(text);
    expect(JSON.stringify(hints)).not.toContain(text);
    expect(f.embed).toHaveBeenCalledTimes(1);
  });

  it('reuses prepared query/document vectors, but not changed or expired entries', async () => {
    let now = 1_000;
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
    const service = new LocalMemoryRecall({ embed }, () => now);
    const note = memory('Old approved fact.'), request = input('A paraphrase', [note]);
    await service.warm(request); await service.warm(request);
    expect(embed).toHaveBeenCalledTimes(1);
    note.contextMetadata!.sentCount++;
    expect(service.retrieve(request).matches).toHaveLength(1);
    note.text = 'Corrected approved fact.'; note.contextMetadata!.revision++;
    expect(service.retrieve(request).matches).toEqual([]);
    await service.warm(request);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed.mock.calls[1]![0]).toEqual(['search_document: Corrected approved fact.']);
    now += MEMORY_RECALL_LIMITS.cacheLifetimeMs + 1;
    expect(service.retrieve(request).mode).toBe('lexical');
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it('filters authorization before embedding and rechecks revisions/deletion before projection', async () => {
    const note = memory('A permitted record.'), unconfirmed = memory('UNCONFIRMED', { trust: 'unverified' });
    const expired = memory('EXPIRED', { expiresAt: '2000-01-01T00:00:00Z' });
    const foreign = memory('OTHER_SESSION', { scope: { kind: 'session', sessionId: 'other' } });
    const query = 'A paraphrase', f = fixture({ [query]: [1, 0, 0], [note.text]: [1, 0, 0] });
    const hints = await f.service.warm(input(query, [note, unconfirmed, expired, foreign]));
    expect(f.embed.mock.calls.flat(2).join(' ')).not.toMatch(/UNCONFIRMED|EXPIRED|OTHER_SESSION/u);
    expect(prepare(query, [], hints).projection.memoryReferences).toEqual([]);
    expect(prepare('Different query', [note], hints).projection.memoryReferences).toEqual([]);
    const changed = { ...note, text: 'Changed content without a stale version bump.' };
    expect(prepare(query, [changed], hints).projection.memoryReferences).toEqual([]);
    expect(memoryRecallSearchResult(input(query, []), hints).matches).toEqual([]);
    expect(memoryRecallSearchResult(input(query, [changed]), hints).matches).toEqual([]);
    note.contextMetadata!.revision++;
    expect(prepare(query, [note], hints).projection.memoryReferences).toEqual([]);
  });

  it('does not send local-only memories to a remote destination or revive foreign hints', async () => {
    const local = memory('LOCAL_SECRET'), cloud = memory('CLOUD_ALLOWED', { privacy: 'cloud-allowed' });
    const query = 'A paraphrase', f = fixture({ [query]: [1, 0, 0], [local.text]: [1, 0, 0], [cloud.text]: [1, 0, 0] });
    const hints = await f.service.warm({ ...input(query, [local, cloud]), destination: 'remote' });
    expect(f.embed.mock.calls.flat(2).join(' ')).not.toContain('LOCAL_SECRET');
    const remote: ChatContextBinding = { ...binding, kind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' };
    expect(prepare(query, [local, cloud], hints, remote).projection.memoryReferences).toEqual([{ id: cloud.id, revision: 1 }]);
    expect(prepare(query, [local, cloud], { ...hints, sessionId: 'different' }, remote).projection.memoryReferences).toEqual([]);
  });

  it('does not use semantic proximity to inject private preferences into public research', async () => {
    const tea = memory('I like jasmine tea.'), style = memory('I prefer concise answers.');
    const query = 'Search official tea industry news.', f = fixture({ [query]: [1, 0, 0], [tea.text]: [1, 0, 0], [style.text]: [1, 0, 0] });
    expect(await f.service.warm(input(query, [tea, style]))).toMatchObject({ reason: 'empty', matches: [] });
    expect(f.embed).not.toHaveBeenCalled();
    expect(prepare(query, [tea, style]).projection.privacy).toBe('cloud-allowed');
  });

  it('returns lexical fallback on invalid, absent or busy embedding services with bounded retry', async () => {
    let now = 0;
    const embed = vi.fn(async () => { throw new Error('knowledge.localModelBusy'); });
    const service = new LocalMemoryRecall({ embed }, () => now), request = input('tea', [memory('I like tea.')]);
    expect(await service.warm(request)).toMatchObject({ mode: 'lexical', reason: 'unavailable' });
    expect(await service.warm(request)).toMatchObject({ reason: 'backoff' });
    expect(embed).toHaveBeenCalledTimes(1);
    now += MEMORY_RECALL_LIMITS.failureBackoffMs;
    await service.warm(request); expect(embed).toHaveBeenCalledTimes(2);
    expect(prepare(request.query, request.memories, service.retrieve(request)).projection.memoryReferences).toHaveLength(1);
    const invalid = new LocalMemoryRecall({ embed: async () => [[Number.NaN], [0]] });
    expect(await invalid.warm(request)).toMatchObject({ mode: 'lexical', matches: [] });
  });

  it('discards in-flight vectors on invalidation and honors cancellation without orphaning work', async () => {
    let finish: ((vectors: number[][]) => void) | undefined;
    const service = new LocalMemoryRecall({ embed: () => new Promise(resolve => { finish = resolve; }) });
    const request = input('A paraphrase', [memory('A saved note')]);
    const pending = service.warm(request);
    service.clear(); finish!([[1, 0], [1, 0]]);
    expect(await pending).toMatchObject({ mode: 'lexical', matches: [] });
    expect(service.retrieve(request).mode).toBe('lexical');
    const abort = new AbortController(); abort.abort();
    await expect(service.warm({ ...request, signal: abort.signal })).rejects.toThrow();
  });

  it('bounds cold batches and explicitly reports partial coverage', async () => {
    const notes = Array.from({ length: MEMORY_RECALL_LIMITS.maxCandidates + 3 }, (_, index) => memory('Record ' + index));
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const service = new LocalMemoryRecall({ embed });
    const result = await service.warm(input('A paraphrase', notes));
    expect(result).toMatchObject({ mode: 'partial', reason: 'limit', consideredCount: MEMORY_RECALL_LIMITS.maxCandidates, eligibleCount: notes.length });
    expect(result.matches).toHaveLength(MEMORY_RECALL_LIMITS.maxMatches);
    expect(embed.mock.calls.every(([texts]) => texts.length <= MEMORY_RECALL_LIMITS.batchSize)).toBe(true);
    expect(service.retrieve(input('A paraphrase', notes)).mode).toBe('partial');
    expect(await service.warm(input('A paraphrase', notes))).toMatchObject({ mode: 'semantic', consideredCount: notes.length });
  });

  it('does not publish partially prepared cache entries after cancellation', async () => {
    const abort = new AbortController();
    let count = 0;
    const embed = vi.fn(async (texts: string[]) => { if (++count === 2) abort.abort(); return texts.map(() => [1, 0]); });
    const service = new LocalMemoryRecall({ embed });
    const request = input('A paraphrase', Array.from({ length: 20 }, () => memory('A saved note')));
    await expect(service.warm({ ...request, signal: abort.signal })).rejects.toThrow();
    expect(service.retrieve(request)).toMatchObject({ mode: 'lexical', matches: [] });
  });
});

describe('stable communication preferences', () => {
  it.each(['以后说重点，别绕弯子', 'Please keep replies brief and get to the point.', '解释一下光合作用'])('retains a verified standing preference for %s without an embedding request', query => {
    const style = memory('我偏好简洁直接的回答，先给结论，再解释理由。'), tea = memory('我喜欢茉莉花茶。');
    expect(prepare(query, [style, tea]).projection.memoryReferences).toEqual([{ id: style.id, revision: 1 }]);
  });
  it('does not turn qualified preferences or foreign/private records into a global style', () => {
    const conditional = memory('如果我累了，我偏好简洁回答。');
    const temporary = memory('我希望这次回答简短。');
    const foreign = memory('I prefer detailed answers.', { scope: { kind: 'session', sessionId: 'other' } });
    expect(prepare('解释一下光合作用', [conditional, temporary, foreign]).projection.memoryReferences).toEqual([]);
  });
});
