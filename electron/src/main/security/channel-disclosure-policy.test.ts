import { createDefaultState } from '../domain/schemas';
import { describe, expect, it } from 'vitest';

import type { ChatMessage, ChatSession, ContextTrace, MemoryItem } from '../../shared';
import { prepareChatContext } from '../domain/chat-context';
import { historyLookupReference } from '../domain/chat-history-lineage';
import { defaultCompanionRecent, recentDigest } from '../domain/companion-recent-state';
import { telegramResultNeedsApproval, assertDeliverableToQq, qqMemoryAllowed } from './channel-disclosure-policy';

const metadata = (patch: Record<string, unknown>) => ({
  version: 1, trust: 'host-confirmed', origin: 'manual-user', scope: { kind: 'global' }, privacy: 'cloud-allowed',
  revision: 1, sourceReferences: [{ kind: 'manual-user', actionId: '0b8a1c26-9d34-4d8f-9e6d-3f1c4a5b7e90' }], sentCount: 0, lastSentAt: null,
  ...patch,
});
const memory = (patch: Record<string, unknown>): MemoryItem => ({ contextMetadata: metadata(patch) }) as unknown as MemoryItem;

describe('qq memory gate', () => {
  it('allows only host-confirmed global cloud-allowed memories explicitly marked for qq', () => {
    expect(qqMemoryAllowed(memory({ qqAllowed: true }))).toBe(true);
  });

  it('rejects every default and unqualified shape', () => {
    expect(qqMemoryAllowed(memory({}))).toBe(false); // not opted in
    expect(qqMemoryAllowed(memory({ qqAllowed: true, trust: 'unverified' }))).toBe(false);
    expect(qqMemoryAllowed(memory({ qqAllowed: true, privacy: 'local-only' }))).toBe(false);
    expect(qqMemoryAllowed(memory({ qqAllowed: true, scope: { kind: 'session', sessionId: '0b8a1c26-9d34-4d8f-9e6d-3f1c4a5b7e90' } }))).toBe(false);
    expect(qqMemoryAllowed(memory({ qqAllowed: true, expiresAt: '2000-01-01T00:00:00.000Z' }))).toBe(false);
    expect(qqMemoryAllowed({} as MemoryItem)).toBe(false); // no metadata at all
  });
});

describe('qq delivery disclosure gate', () => {
  const trace = (privacy: ContextTrace['privacy']): ContextTrace =>
    ({ version: 1, memoryReferences: [], historyMessageIds: [], privacy, scope: { kind: 'global' }, lineage: 'complete' });

  it('delivers only turns whose verified trace is cloud-allowed', () => {
    expect(() => assertDeliverableToQq({ contextTrace: trace('cloud-allowed') })).not.toThrow();
    expect(() => assertDeliverableToQq({ contextTrace: trace('local-only') })).toThrow('qq.disclosureBlocked');
    expect(() => assertDeliverableToQq({})).toThrow('qq.disclosureBlocked');
  });

  it('rejects unknown lineage, representations and history lookups even if cloud-allowed', () => {
    for (const patch of [
      { lineage: 'unknown' as const },
      { representationReferences: [{ batchId: 'batch', candidateVersion: 1 }] },
      { historyLookupReferences: [{ sessionId: 'desktop', messageId: 'private', contentSHA256: 'a'.repeat(64) }] },
    ]) expect(() => assertDeliverableToQq({ contextTrace: { ...trace('cloud-allowed'), ...patch } })).toThrow('qq.disclosureBlocked');
  });

  it('rechecks memory consent, revision and suppression at delivery time', () => {
    const shared = { ...memory({ qqAllowed: true }), id: 'memory' };
    const state = { chatSessions: [{ id: 'qq' } as ChatSession], chatMessages: [] as ChatMessage[], memories: [shared], memoryTombstones: [], memorySleep: createDefaultState().memorySleep };
    const message = { contextTrace: { ...trace('cloud-allowed'), memoryReferences: [{ id: shared.id, revision: 1 }] } };
    expect(() => assertDeliverableToQq(message, state, 'qq')).not.toThrow();
    expect(() => assertDeliverableToQq(message, state, 'qq', () => true)).toThrow();
    shared.contextMetadata!.revision = 2;
    expect(() => assertDeliverableToQq(message, state, 'qq')).toThrow();
    shared.contextMetadata!.revision = 1; shared.contextMetadata!.qqAllowed = false;
    expect(() => assertDeliverableToQq(message, state, 'qq')).toThrow();
  });

  it('rechecks a recent summary inherited through an ancestor before QQ delivery', () => {
    const at = new Date().toISOString(), revision = recentDigest('synthetic revision');
    const owner = { id: 'qq', companionScope: 'owner' } as ChatSession;
    const desktop = { id: 'desktop', companionScope: 'owner' } as ChatSession;
    const source: ChatMessage = { id: 'source', sessionId: desktop.id, role: 'user', content: 'Synthetic source', status: 'complete', errorCode: null, createdAt: at };
    const ancestor: ChatMessage = { id: 'ancestor', sessionId: owner.id, role: 'assistant', content: 'Synthetic descendant',
      status: 'complete', errorCode: null, createdAt: at, contextTrace: { ...trace('cloud-allowed'), recentRevision: revision } };
    const state = { chatSessions: [owner, desktop], chatMessages: [source, ancestor], memories: [], memoryTombstones: [], memorySleep: createDefaultState().memorySleep,
      companionRecent: { ...defaultCompanionRecent(),
        entries: [{ source: 'desktop' as const, id: source.id, sessionId: desktop.id, at, sha: recentDigest(source.content) }],
        summary: { revision, text: source.content, updatedAt: at, refs: [source.id], localOnly: false },
      },
    };
    const message = { contextTrace: { ...trace('cloud-allowed'), historyMessageIds: [ancestor.id] } };
    expect(() => assertDeliverableToQq(message, state, owner.id)).not.toThrow();
    expect(() => telegramResultNeedsApproval(message, state, owner.id, false, () => false)).toThrow('telegram.disclosureBlocked');
    owner.companionScope = 'group';
    expect(() => assertDeliverableToQq(message, state, owner.id)).toThrow('qq.disclosureBlocked');
    owner.companionScope = 'owner';
    desktop.historyPrivacy = 'local-only';
    expect(() => assertDeliverableToQq(message, state, owner.id)).toThrow('qq.disclosureBlocked');
  });

  it('walks ancestors and rejects cross-session, missing, cyclic or newly private history', () => {
    const ancestor: ChatMessage = { id: 'a', sessionId: 'qq', role: 'user', content: 'hello', status: 'complete', errorCode: null, createdAt: '', contextTrace: trace('cloud-allowed') };
    const session = { id: 'qq', historyPrivacy: 'cloud-allowed' } as ChatSession;
    const state = { chatSessions: [session], chatMessages: [ancestor], memories: [], memoryTombstones: [], memorySleep: createDefaultState().memorySleep };
    const message = { contextTrace: { ...trace('cloud-allowed'), historyMessageIds: ['a'] } };
    expect(() => assertDeliverableToQq(message, state, 'qq')).not.toThrow();
    ancestor.sessionId = 'desktop'; expect(() => assertDeliverableToQq(message, state, 'qq')).toThrow();
    ancestor.sessionId = 'qq'; ancestor.contextTrace!.historyMessageIds = ['a'];
    expect(() => assertDeliverableToQq(message, state, 'qq')).toThrow();
    ancestor.contextTrace!.historyMessageIds = []; session.historyPrivacy = 'local-only';
    expect(() => assertDeliverableToQq(message, state, 'qq')).toThrow();
    session.historyPrivacy = 'cloud-allowed'; state.chatMessages = [];
    expect(() => assertDeliverableToQq(message, state, 'qq')).toThrow();
  });
});

describe('qq context exclusion', () => {
  it('a qq-remote binding excludes private and non-qq memories from the prepared context', () => {
    const shared = memory({ qqAllowed: true });
    // Test objects carry the marker in their text via a cast the projection reads literally.
    const sharedMemory = { ...shared, text: 'QQ_SHARED_MARKER', tags: [] } as unknown as MemoryItem;
    sharedMemory.contextMetadata!.qqAllowed = true;
    const privateMemory = { ...memory({ privacy: 'local-only' }), text: 'QQ_PRIVATE_MARKER', tags: [] } as unknown as MemoryItem;
    const unmarkedMemory = { ...memory({}), text: 'QQ_UNMARKED_MARKER', tags: [] } as unknown as MemoryItem;
    const prepared = prepareChatContext({
      sessionId: '4a2f5f66-52aa-4c2e-8b6e-1a2b3c4d5e6f',
      history: [],
      memories: [sharedMemory, privateMemory, unmarkedMemory].filter(qqMemoryAllowed),
      query: 'QQ_SHARED_MARKER',
      locale: 'en',
      binding: { providerId: '8f6d3f0e-6a52-4d0e-9c58-2f5c6d7e8f9a', kind: 'openai', baseUrl: 'https://api.example.com', model: 'model-x', serviceExecution: 'remote' },
      requiredMessages: [{ role: 'user', content: 'Summarize my shared facts.' }],
      maxOutputTokens: 512,
      contextBudget: { contextWindowTokens: 100_000, safetyMarginTokens: 256, capacitySource: 'application-limit' },
    });
    const serialized = JSON.stringify(prepared.messages);
    expect(serialized).toContain('QQ_SHARED_MARKER');
    expect(serialized).not.toContain('QQ_PRIVATE_MARKER');
    expect(serialized).not.toContain('QQ_UNMARKED_MARKER');
    expect(prepared.destination).toBe('remote');
  });
});

describe('Telegram result disclosure', () => {
  const privateTrace: ContextTrace = { version: 1, privacy: 'local-only', scope: {kind:'global'}, lineage: 'complete', memoryReferences: [], historyMessageIds: [] };
  const needs = (trace: ContextTrace, state: { chatSessions: ChatSession[]; chatMessages: ChatMessage[]; memories: MemoryItem[] }, memoryEnabled = true) =>
    telegramResultNeedsApproval({contextTrace:trace}, { ...state, memoryTombstones: [], memorySleep: createDefaultState().memorySleep }, 'phone', memoryEnabled, () => false);
  const session = {id:'phone'} as ChatSession;

  it('permits one local-result decision only with complete lineage and current per-memory consent', () => {
    const shared = { ...memory({telegramAllowed:true}), id:'fact' };
    const state = { chatSessions:[session], chatMessages:[], memories:[shared] };
    const trace = { ...privateTrace, memoryReferences:[{id:'fact',revision:1}] };
    expect(needs(trace,state)).toBe(true);
    expect(needs({...trace,privacy:'cloud-allowed'},state)).toBe(false);
    expect(() => needs(trace,state,false)).toThrow('telegram.disclosureBlocked');
    shared.contextMetadata!.revision++;
    expect(() => needs(trace,state)).toThrow('telegram.disclosureBlocked');
    expect(() => needs({...privateTrace,lineage:'unknown'},state)).toThrow('telegram.disclosureBlocked');
  });

  it('rechecks the content digest and lineage of an earlier task before sharing its result', () => {
    const message: ChatMessage = { id:'answer', sessionId:'phone', content:'task result', status:'complete', role:'assistant', createdAt:'', errorCode:null, contextTrace:privateTrace };
    const lookup = historyLookupReference(message);
    const state = { chatSessions:[session], chatMessages:[message], memories:[] };
    const trace = { ...privateTrace, historyLookupReferences:[lookup] };
    expect(needs(trace,state)).toBe(true);
    message.content = 'changed';
    expect(() => needs(trace,state)).toThrow('telegram.disclosureBlocked');
    message.content = 'task result'; message.sessionId = 'desktop';
    expect(() => needs(trace,state)).toThrow('telegram.disclosureBlocked');
  });
});

it('revalidates the knowledge sharing revision at QQ and Telegram delivery', () => {
  const state = { chatSessions: [{ id: 'channel' } as ChatSession], chatMessages: [], memories: [], memoryTombstones: [], memorySleep: createDefaultState().memorySleep };
  const token = 'a'.repeat(64);
  const suppress = () => false;
  const message: { contextTrace: ContextTrace } = { contextTrace: { version: 1, memoryReferences: [], historyMessageIds: [],
    privacy: 'cloud-allowed', scope: { kind: 'global' }, lineage: 'complete', knowledgePolicyToken: token } };
  expect(() => assertDeliverableToQq(message, state, 'channel', suppress, token)).not.toThrow();
  expect(telegramResultNeedsApproval(message, state, 'channel', false, suppress, token)).toBe(false);
  expect(() => assertDeliverableToQq(message, state, 'channel', suppress, 'b'.repeat(64))).toThrow('qq.disclosureBlocked');
  expect(() => telegramResultNeedsApproval(message, state, 'channel', false, suppress, null)).toThrow('telegram.disclosureBlocked');
  message.contextTrace.privacy = 'local-only';
  expect(() => telegramResultNeedsApproval(message, state, 'channel', false, suppress, token)).toThrow('telegram.disclosureBlocked');
});
