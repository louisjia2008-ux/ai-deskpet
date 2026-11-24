// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryItem } from '../../shared';
import type { MemoryRecallSearchInput } from '../../shared/memory-recall';
import type { PersistentState } from './schemas';
import { ChatService } from './chat-service';
import { MemoryRecallService, MEMORY_RECALL_OPERATION_LIMIT } from './memory-recall-service';
import { LocalMemoryRecall } from './memory-semantic-recall';
import { DomainRepository } from './repository';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const memory = (text: string, metadata: Partial<NonNullable<MemoryItem['contextMetadata']>> = {}): MemoryItem => ({
  id: randomUUID(), text, tags: ['fixture'], source: 'user', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z',
  contextMetadata: { version: 1, trust: 'host-confirmed', origin: 'manual-user', scope: { kind: 'global' }, privacy: 'local-only', revision: 1,
    sourceReferences: [{ kind: 'manual-user', actionId: randomUUID() }], sentCount: 0, lastSentAt: null, ...metadata },
});
const fixture = async (gate?: ReturnType<typeof deferred>) => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-memory-recall-')); roots.push(root);
  const repo = new DomainRepository(join(root, 'profile.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 19) });
  await repo.initialize();
  const session = await new ChatService(repo).createSession('Synthetic recall test', 'normal');
  const note = memory('A gentle walking route along the river.');
  await repo.transaction(state => { state.memories.push(note); });
  const embed = vi.fn(async (texts: string[]) => { await gate?.promise; return texts.map(() => [1, 0, 0]); });
  const recall = new LocalMemoryRecall({ embed });
  let available = true;
  const service = new MemoryRecallService(repo, recall, () => available);
  const input = (query = 'Saturday hiking plans'): MemoryRecallSearchInput => ({ operationId: randomUUID(), sessionId: session.id, query });
  return { repo, session, note, embed, recall, service, input, setAvailable: (value: boolean) => { available = value; } };
};

describe('desktop local memory recall service', () => {
  it('searches only general memories when no conversation is given, and creates nothing', async () => {
    const f = await fixture();
    const own = memory('SESSION_ONLY_VALUE', { scope: { kind: 'session', sessionId: f.session.id } });
    await f.repo.transaction(state => { state.memories.push(own); });
    const before = f.repo.snapshot();
    const { sessionId: _unused, ...withoutSession } = f.input(); void _unused;
    const result = await f.service.search(withoutSession);
    expect(result.matches.map(match => match.id)).toEqual([f.note.id]);
    expect(f.embed.mock.calls.flat(2).join(' ')).not.toContain('SESSION_ONLY_VALUE');
    expect(f.repo.snapshot()).toEqual(before);
  });

  it('uses only local, confirmed, in-scope, unsuppressed memories and returns host-built results', async () => {
    const f = await fixture();
    const own = memory('Only this session.', { scope: { kind: 'session', sessionId: f.session.id } });
    const suppressed = memory('SUPPRESSED_PRIVATE_VALUE');
    await f.repo.transaction(state => { state.memories.push(own, suppressed,
      memory('OTHER_SESSION_VALUE', { scope: { kind: 'session', sessionId: randomUUID() } }),
      memory('UNCONFIRMED_VALUE', { trust: 'unverified' }), memory('EXPIRED_VALUE', { expiresAt: '2000-01-01T00:00:00Z' })); });
    f.repo.suppressMemoryRecall([suppressed.id]);
    const before = f.repo.snapshot(), result = await f.service.search(f.input());
    expect(result).toMatchObject({ mode: 'semantic', reason: 'ready', consideredCount: 2, eligibleCount: 2 });
    expect(result.matches.map(match => match.id).sort()).toEqual([f.note.id, own.id].sort());
    expect(result.matches.every(match => match.privacy === 'local-only' && match.similarity === 1)).toBe(true);
    expect(f.embed.mock.calls.flat(2).join(' ')).not.toMatch(/SUPPRESSED|OTHER_SESSION|UNCONFIRMED|EXPIRED/u);
    expect(f.repo.snapshot()).toEqual(before);
    expect(f.service.active).toBe(false);
  });

  it('shares the same pending operation and refuses a conflicting payload or session', async () => {
    const gate = deferred(), f = await fixture(gate), input = f.input();
    const first = f.service.search(input), duplicate = f.service.search(input);
    expect(first).toBe(duplicate);
    await expect(f.service.search({ ...input, query: 'A different subject' })).rejects.toThrow('memory.recallOperationConflict');
    const other = await new ChatService(f.repo).createSession('Other synthetic session', 'project');
    await expect(f.service.search({ ...input, sessionId: other.id })).rejects.toThrow('memory.recallOperationConflict');
    gate.resolve(); await first;
    expect(f.embed).toHaveBeenCalledOnce();
  });

  it('re-reads current authority on a completed retry rather than replaying private text', async () => {
    const f = await fixture(), request = f.input();
    expect((await f.service.search(request)).matches).toHaveLength(1);
    f.repo.suppressMemoryRecall([f.note.id]);
    expect((await f.service.search(request)).matches).toEqual([]);
    expect(f.embed).toHaveBeenCalledOnce();
  });

  it.each(['missing', 'archived', 'deleted', 'channel', 'analysis'] as const)('refuses a %s session before preparing embeddings', async kind => {
    const f = await fixture();
    await f.repo.transaction(state => {
      const session = state.chatSessions[0]!;
      if (kind === 'missing') state.chatSessions = [];
      if (kind === 'archived') session.archivedAt = new Date().toISOString();
      if (kind === 'deleted') session.deletedAt = new Date().toISOString();
      if (kind === 'channel') session.channelBindingId = randomUUID();
      if (kind === 'analysis') session.analysisSource = 'rea-static';
    });
    await expect(f.service.search(f.input())).rejects.toThrow('chat.sessionUnavailable');
    expect(f.embed).not.toHaveBeenCalled();
  });

  it.each([
    { query: '' }, { query: 'x'.repeat(3201) }, { operationId: 'invalid' },
    { destination: 'remote' }, { memories: [] }, { signal: null },
  ])('rejects invalid or caller-selected authority: %j', async override => {
    const f = await fixture();
    await expect(f.service.search({ ...f.input(), ...override })).rejects.toThrow('memory.recallInvalidInput');
    expect(f.embed).not.toHaveBeenCalled();
  });

  it.each(['archived', 'deleted', 'channel', 'analysis', 'profile', 'unavailable'] as const)('rechecks %s changes after the embedding request', async kind => {
    const gate = deferred(), f = await fixture(gate), pending = f.service.search(f.input());
    const observed = expect(pending).rejects.toThrow(kind === 'profile' ? 'memory.recallInvalidated' : kind === 'unavailable' ? 'memory.recallUnavailable' : 'chat.sessionUnavailable');
    if (kind === 'unavailable') f.setAvailable(false);
    else await f.repo.transaction(state => {
      const session = state.chatSessions[0]!;
      if (kind === 'archived') session.archivedAt = new Date().toISOString();
      if (kind === 'deleted') session.deletedAt = new Date().toISOString();
      if (kind === 'channel') session.channelBindingId = randomUUID();
      if (kind === 'analysis') session.analysisSource = 'rea-static';
      if (kind === 'profile') state.profileId = randomUUID();
    });
    gate.resolve(); await observed;
    expect(f.service.active).toBe(false);
  });

  it.each(['deleted', 'suppressed', 'edited', 'expired', 'foreign-scope', 'unconfirmed'] as const)('never returns stale semantic text after a memory is %s', async kind => {
    const gate = deferred(), f = await fixture(gate), pending = f.service.search(f.input());
    if (kind === 'suppressed') f.repo.suppressMemoryRecall([f.note.id]);
    else await f.repo.transaction((state: PersistentState) => {
      const note = state.memories[0]!;
      if (kind === 'deleted') state.memories = [];
      if (kind === 'edited') { note.text = 'A revised record with different facts.'; note.contextMetadata!.revision++; }
      if (kind === 'expired') note.contextMetadata!.expiresAt = '2000-01-01T00:00:00Z';
      if (kind === 'foreign-scope') note.contextMetadata!.scope = { kind: 'session', sessionId: randomUUID() };
      if (kind === 'unconfirmed') note.contextMetadata!.trust = 'unverified';
    });
    gate.resolve();
    const result = await pending;
    expect(result.matches).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(f.note.text);
  });

  it('cancels without releasing active accounting early and ignores a noncooperative embedding result', async () => {
    const gate = deferred(), f = await fixture(gate), request = f.input();
    const pending = f.service.search(request), observed = expect(pending).rejects.toThrow('memory.recall.cancelled');
    await f.service.cancel({ operationId: request.operationId });
    expect(f.service.active).toBe(true);
    let finished = false;
    const stopped = f.service.shutdown().then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    gate.resolve(); await observed; await stopped;
    expect(f.service.active).toBe(false);
    const fresh = f.recall.retrieve({ sessionId: f.session.id, destination: 'local', query: request.query, memories: [f.note], signal: new AbortController().signal });
    expect(fresh).toMatchObject({ mode: 'lexical', matches: [] });
    await expect(f.service.search(f.input())).rejects.toThrow('memory.recallUnavailable');
  });

  it('invalidates pending work and cached vectors while allowing an explicit later retry', async () => {
    const gate = deferred(), f = await fixture(gate), pending = f.service.search(f.input());
    const observed = expect(pending).rejects.toThrow('memory.recall.cancelled');
    f.service.invalidate(); gate.resolve(); await observed;
    expect((await f.service.search(f.input())).mode).toBe('semantic');
    expect(f.embed).toHaveBeenCalledTimes(2);
    const clear = vi.spyOn(f.recall, 'clear'); await f.service.shutdown(); expect(clear).toHaveBeenCalled();
  });

  it('bounds outstanding requests even if a preparation adapter does not settle', async () => {
    const gate = deferred(), f = await fixture();
    vi.spyOn(f.recall, 'warm').mockImplementation(async input => { await gate.promise; return f.recall.retrieve(input); });
    const requests = Array.from({ length: MEMORY_RECALL_OPERATION_LIMIT }, () => f.input());
    const pending = requests.map(request => f.service.search(request));
    await expect(f.service.search(f.input())).rejects.toThrow('memory.recallBusy');
    expect(f.service.search(requests[0]!)).toBe(pending[0]);
    gate.resolve(); await Promise.all(pending);
    expect(f.service.active).toBe(false);
  });

  it('rejects work during maintenance and treats an unknown valid cancel as idempotent', async () => {
    const f = await fixture(); f.setAvailable(false);
    await expect(f.service.search(f.input())).rejects.toThrow('memory.recallUnavailable');
    await expect(f.service.cancel({ operationId: randomUUID() })).resolves.toBeUndefined();
    await expect(f.service.cancel({ operationId: 'invalid' })).rejects.toThrow('memory.recallInvalidInput');
    expect(f.embed).not.toHaveBeenCalled();
  });
});
