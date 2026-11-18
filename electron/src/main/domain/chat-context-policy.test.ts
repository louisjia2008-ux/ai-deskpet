import { describe, expect, it } from 'vitest';
import type { ChatMessage, ContextTrace, MemoryItem } from '../../shared';
import { memoryAllowedForContext, resolveContextDestination, selectAllowedHistory } from './chat-context-policy';
import type { ChatContextBinding } from './chat-context-policy';

const local: ChatContextBinding = { providerId: 'local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', localExecutionConfirmed: true };
const trace = (patch: Partial<ContextTrace> = {}): ContextTrace => ({ version: 1, memoryReferences: [], historyMessageIds: [], privacy: 'cloud-allowed', scope: { kind: 'global' }, lineage: 'complete', ...patch });
const memory = (): MemoryItem => ({
  id: 'memory', text: 'Synthetic preference.', tags: [], source: 'user', createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z',
  contextMetadata: { version: 1, trust: 'host-confirmed', origin: 'manual-user', scope: { kind: 'global' }, privacy: 'local-only', revision: 1, sourceReferences: [], sentCount: 0, lastSentAt: null },
});
const message = (id: string, contextTrace = trace()): ChatMessage => ({
  id, sessionId: 'session', role: 'assistant', content: id, status: 'complete', errorCode: null, createdAt: '2026-10-26T00:00:00Z', contextTrace,
});

describe('actual binding context policy', () => {
  it.each([
    [{ localExecutionConfirmed: false }, 'unknown'],
    [{ serviceExecution: 'local', localExecutionConfirmed: false }, 'unknown'],
    [{ serviceExecution: 'remote' }, 'remote'],
    [{ kind: 'openai' }, 'remote'],
    [{ model:'qwen:16b-cloud', serviceExecution:'unknown', localExecutionConfirmed:true },'remote'],
    [{ baseUrl: 'https://example.test/v1' }, 'remote'],
    [{ baseUrl: 'http://localhost.evil.test/v1' }, 'remote'],
    [{ baseUrl: 'file:///private/tmp/example' }, 'unknown'],
    [{ baseUrl: 'http://user:password@localhost:11434/v1' }, 'unknown'],
    [{ baseUrl: 'http://[::1]:11434/v1' }, 'local'],
    [{ serviceExecution: 'unknown' }, 'local'],
  ] as const)('classifies endpoint and execution evidence %j as %s', (patch, expected) => {
    expect(resolveContextDestination({ ...local, ...patch })).toBe(expected);
  });

  it('does not infer a local destination from a missing binding or a loopback address alone', () => {
    expect(resolveContextDestination()).toBe('unknown');
    const undeclared = { ...local }; delete undeclared.localExecutionConfirmed;
    expect(resolveContextDestination(undeclared)).toBe('unknown');
  });

  it('requires host-confirmed metadata and the current session owner', () => {
    const item = memory();
    expect(memoryAllowedForContext(item, 'session', 'local')).toBe(true);
    expect(memoryAllowedForContext(item, 'session', 'remote')).toBe(false);
    expect(memoryAllowedForContext(item, 'session', 'unknown')).toBe(false);
    item.contextMetadata!.privacy = 'cloud-allowed';
    expect(memoryAllowedForContext(item, 'session', 'unknown')).toBe(true);
    item.contextMetadata!.scope = { kind: 'session', sessionId: 'other' };
    expect(memoryAllowedForContext(item, 'session', 'local')).toBe(false);
    item.contextMetadata!.scope = { kind: 'global' };
    item.contextMetadata!.trust = 'unverified';
    expect(memoryAllowedForContext(item, 'session', 'local')).toBe(false);
    delete item.contextMetadata;
    expect(memoryAllowedForContext(item, 'session', 'local')).toBe(false);
  });
});

describe('history provenance', () => {
  it('excludes stale knowledge results and their descendants from future context after sharing is revoked', () => {
    const token = 'a'.repeat(64);
    const original = message('source', trace({ knowledgePolicyToken: token }));
    const descendant = message('derived', trace({ historyMessageIds: [original.id] }));
    const eligible = { sessionId: 'session', history: [original, descendant], memories: [], destination: 'remote' } as const;
    expect(selectAllowedHistory({ ...eligible, knowledgePolicyToken: token })).toEqual([original, descendant]);
    expect(selectAllowedHistory({ ...eligible, knowledgePolicyToken: 'b'.repeat(64) })).toEqual([]);
    expect(selectAllowedHistory(eligible)).toEqual([]);
  });

  it('rejects an old assistant and its descendant after the memory is corrected or removed', () => {
    const item = memory();
    const original = message('original', trace({ privacy: 'local-only', memoryReferences: [{ id: item.id, revision: 1 }] }));
    const descendant = message('descendant', trace({ privacy: 'local-only', historyMessageIds: [original.id] }));
    const select = (memories: MemoryItem[]) => selectAllowedHistory({ sessionId: 'session', history: [original, descendant], memories, destination: 'local' });
    expect(select([item])).toHaveLength(2);
    item.contextMetadata!.revision = 2;
    expect(select([item])).toEqual([]);
    expect(select([])).toEqual([]);
  });

  it('keeps a restricted session history off remote requests even when a later user repeats a private fact', () => {
    const repeated = { ...message('repeat'), role: 'user' as const, content: 'A repeated synthetic private marker.' };
    expect(selectAllowedHistory({ sessionId: 'session', history: [repeated], memories: [], destination: 'remote', historyPrivacy: 'local-only' })).toEqual([]);
    expect(selectAllowedHistory({ sessionId: 'session', history: [repeated], memories: [], destination: 'local', historyPrivacy: 'local-only' })).toEqual([repeated]);
  });

  it('excludes unknown lineage, missing parents, cycles, foreign sessions and incomplete replies', () => {
    const legacy = message('legacy'); delete legacy.contextTrace;
    const candidates = [
      legacy, message('unknown', trace({ lineage: 'unknown' })), message('missing', trace({ historyMessageIds: ['absent'] })),
      message('a', trace({ historyMessageIds: ['b'] })), message('b', trace({ historyMessageIds: ['a'] })),
      { ...message('foreign'), sessionId: 'other' }, { ...message('unfinished'), status: 'streaming' as const },
      message('clean'),
    ];
    expect(selectAllowedHistory({ sessionId: 'session', history: candidates, memories: [], destination: 'local' }).map((item) => item.id)).toEqual(['clean']);
  });
});
