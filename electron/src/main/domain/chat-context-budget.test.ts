import { describe, expect, it } from 'vitest';
import type { ChatMessage, ContextTrace, MemoryItem } from '../../shared';
import type { ActiveSpeakingStyle } from '../../shared/conversation-import';
import type { ModelTurnMessage } from '../runtime';
import { estimateProviderRequestInputTokens, ProviderRequestBudgetError } from '../providers/request-budget';
import { buildChatContext, prepareChatContext } from './chat-context';
import type { PrepareChatContextInput } from './chat-context';

const trace = (patch: Partial<ContextTrace> = {}): ContextTrace => ({ version: 1, memoryReferences: [], historyMessageIds: [], privacy: 'cloud-allowed', scope: { kind: 'global' }, lineage: 'complete', ...patch });
const message = (id: string, role: 'user' | 'assistant', content: string): ChatMessage => ({
  id, sessionId: 'session', role, content, createdAt: '2026-10-26T00:00:00Z', status: 'complete', errorCode: null, contextTrace: trace(),
});
const memory = (id: string, text: string): MemoryItem => ({
  id, text, tags: [], source: 'user', createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z',
  contextMetadata: { version: 1, trust: 'host-confirmed', origin: 'manual-user', scope: { kind: 'global' }, privacy: 'local-only', revision: 1, sourceReferences: [], sentCount: 7, lastSentAt: null },
});
const input = (patch: Partial<PrepareChatContextInput> = {}): PrepareChatContextInput => ({
  sessionId: 'session', locale: 'en', query: 'Synthetic current question', history: [], memories: [],
  binding: { providerId: 'local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', localExecutionConfirmed: true },
  requiredMessages: [{ role: 'user', content: 'Synthetic current question' }], maxOutputTokens: 512,
  contextBudget: { contextWindowTokens: 16_384, safetyMarginTokens: 256, capacitySource: 'configured' }, ...patch,
});

describe('chat request budget and consumption projection', () => {
  it('uses the final wire estimator, including tool names, schemas and generation parameters', () => {
    const options = input({
      tools: [{ name: 'synthetic.lookup', description: 'Read a synthetic reference.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }],
      temperature: 0.2, reasoningEffort: 'none', outputTokenParameter: 'max_completion_tokens',
    });
    const result = prepareChatContext(options);
    expect(result.budget.inputEstimate).toBe(estimateProviderRequestInputTokens({
      model: options.binding.model, messages: result.messages, tools: [...options.tools!],
      maxOutputTokens: options.maxOutputTokens, contextBudget: options.contextBudget,
      outputTokenParameter: options.outputTokenParameter!, temperature: options.temperature!, reasoningEffort: options.reasoningEffort!,
    }));
    expect(result.messages.at(-1)).toEqual(options.requiredMessages[0]);
    expect(result.budget.maxInputTokens).toBe(16_384 - 512 - 256);
    expect(result.budget.capacitySource).toBe('configured');
  });

  it('retains a complete required tool exchange and rejects an oversized later round', () => {
    const required: ModelTurnMessage[] = [
      { role: 'user', content: 'Read the synthetic reference.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'synthetic.lookup', argumentsJson: '{"query":"fixture"}' }] },
      { role: 'tool', toolCallId: 'call', content: '{"answer":"amber"}' },
    ];
    const options = input({ requiredMessages: required });
    expect(prepareChatContext(options).messages.slice(-3)).toEqual(required);
    const later = structuredClone(required);
    later[2]!.content = 'full result '.repeat(12000);
    expect(() => prepareChatContext({ ...options, requiredMessages: later })).toThrow(ProviderRequestBudgetError);
    expect(later[2]!.content).toBe('full result '.repeat(12000));
    expect(required[2]!.content).toBe('{"answer":"amber"}');
  });

  it('blocks a local-only required tool result on remote or unknown destinations and taints local output', () => {
    const required: ModelTurnMessage[] = [
      { role: 'user', content: 'Read the selected synthetic workspace file.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'workspace.read', argumentsJson: '{"path":"fixture.txt"}' }] },
      { role: 'tool', toolCallId: 'read', content: 'LOCAL_TOOL_RESULT_MARKER' },
    ];
    const options = input({ requiredMessages: required, requiredPrivacy: 'local-only' });
    for (const binding of [{ ...options.binding, serviceExecution: 'remote' as const }, { ...options.binding, localExecutionConfirmed: false }]) {
      expect(() => prepareChatContext({ ...options, binding })).toThrow('provider.contextPrivacyBlocked');
    }
    const local = prepareChatContext(options);
    expect(local.messages.slice(-3)).toEqual(required);
    expect(local.projection.privacy).toBe('local-only');
    expect(required[2]!.content).toBe('LOCAL_TOOL_RESULT_MARKER');
  });

  it('rejects a required tool schema that exceeds the budget without silently hiding tools', () => {
    const options = input({ tools: [{ name: 'synthetic.lookup', description: 'schema'.repeat(30000), parameters: { type: 'object' } }] });
    expect(() => prepareChatContext(options)).toThrow(ProviderRequestBudgetError);
    expect(options.tools).toHaveLength(1);
  });

  it('prioritizes complete recent history over optional memory and projects only retained sources', () => {
    const recent = [message('recent-user', 'user', 'A recent question.'), message('recent-reply', 'assistant', 'A recent answer.')];
    const baseline = prepareChatContext(input({ history: recent, query: 'remembered fact' }));
    const item = memory('optional', 'An optional remembered fact.');
    const result = prepareChatContext(input({
      history: [message('large-old', 'user', 'large'.repeat(5000)), ...recent], memories: [item], query: 'remembered fact',
      contextBudget: { contextWindowTokens: baseline.budget.inputEstimate + 512 + 256, safetyMarginTokens: 256, capacitySource: 'configured' },
    }));
    expect(result.projection.historyMessageIds).toEqual(['recent-user', 'recent-reply']);
    expect(result.projection.memoryReferences).toEqual([]);
    expect(result.messages.some((entry) => entry.content.includes('optional remembered'))).toBe(false);
    expect(result.excluded).toEqual({ memoryCount: 1, historyCount: 1 });
    expect(item.contextMetadata!.sentCount).toBe(7);
    expect(item.contextMetadata!.lastSentAt).toBeNull();
  });

  it('keeps an optional past user exchange whole when only its reply would fit', () => {
    const baseline = prepareChatContext(input());
    const result = prepareChatContext(input({
      history: [message('large-user', 'user', 'private fact '.repeat(500)), message('small-reply', 'assistant', 'Yes.')],
      contextBudget: { contextWindowTokens: baseline.budget.inputEstimate + 512 + 256 + 200, safetyMarginTokens: 256, capacitySource: 'configured' },
    }));
    expect(result.projection.historyMessageIds).toEqual(result.excluded.summarizedCount ? ['large-user', 'small-reply'] : []);
    expect(result.messages.some((entry) => entry.content === 'Yes.')).toBe(false);
  });

  it('omits oversized memories rather than changing the retained facts', () => {
    const small = memory('small', 'The synthetic beacon is amber; only at night.');
    const large = memory('large', `An entire synthetic fact ${'x'.repeat(7000)}`);
    const result = prepareChatContext(input({ memories: [large, small], query: 'beacon' }));
    expect(result.projection.memoryReferences).toEqual([{ id: 'small', revision: 1 }]);
    expect(JSON.stringify(result.messages)).toContain(small.text);
    expect(JSON.stringify(result.messages)).not.toContain('An entire synthetic fact');
    expect(result.projection.privacy).toBe('local-only');
  });

  it('retains indirect memory provenance when a selected historical answer used it', () => {
    const item = memory('source', 'The synthetic beacon is amber.');
    const answer = message('derived', 'assistant', 'It is amber.');
    answer.contextTrace = trace({ privacy: 'local-only', memoryReferences: [{ id: item.id, revision: 1 }] });
    const result = prepareChatContext(input({ history: [answer], memories: [item] }));
    expect(result.projection.memoryReferences).toEqual([{ id: 'source', revision: 1 }]);
    expect(result.projection.historyMessageIds).toEqual(['derived']);
    expect(result.projection.privacy).toBe('local-only');
  });

  it('preserves ancestor provenance when the old source messages are too large to resend', () => {
    const item = memory('source', 'fact'.repeat(2000));
    const original = message('original', 'assistant', 'An earlier derived fact.');
    original.contextTrace = trace({ privacy: 'local-only', memoryReferences: [{ id: item.id, revision: 1 }] });
    const descendant = message('descendant', 'assistant', 'A short paraphrase of the fact.');
    descendant.contextTrace = trace({ historyMessageIds: [original.id] });
    const history = [message('old-user', 'user', 'old'.repeat(20000)), original, message('recent-user', 'user', 'Repeat the fact.'), descendant];
    const result = prepareChatContext(input({ history, memories:[item] }));
    expect(result.projection.historyMessageIds).toEqual(['old-user', 'original', 'recent-user', 'descendant']);
    expect(result.projection.summaryReferences?.map(ref => ref.messageId)).toEqual(['old-user','original']);
    expect(result.messages.some(entry => entry.content === history[0]!.content)).toBe(false);
    expect(result.projection.memoryReferences).toEqual([{ id: 'source', revision: 1 }]);
    expect(result.projection.privacy).toBe('local-only');
    const changed = message('derived-reply','assistant','Prior derived answer');
    changed.contextTrace = result.projection;
    const noMemory = prepareChatContext(input({history:[...history,changed],memories:[]}));
    expect(noMemory.projection.historyMessageIds).not.toContain('derived-reply');
    expect(noMemory.projection.historyMessageIds).not.toContain('original');
    history[0]!.content = 'Changed source text';
    expect(prepareChatContext(input({history:[...history,changed],memories:[item]})).projection.historyMessageIds).not.toContain('derived-reply');
  });

  it('sends only explicitly cloud-allowed memory to remote or undeclared endpoints', () => {
    const restricted = memory('private', 'PRIVATE_SYNTHETIC_MARKER');
    const shared = memory('shared', 'SHARED_SYNTHETIC_MARKER'); shared.contextMetadata!.privacy = 'cloud-allowed';
    const legacy = memory('legacy', 'LEGACY_SYNTHETIC_MARKER'); delete legacy.contextMetadata;
    const options = input({ memories: [restricted, shared, legacy] });
    for (const binding of [{ ...options.binding, localExecutionConfirmed: false }, { ...options.binding, serviceExecution: 'remote' as const }]) {
      const result = prepareChatContext({ ...options, binding });
      expect(result.projection.memoryReferences).toEqual([{ id: 'shared', revision: 1 }]);
      expect(JSON.stringify(result.messages)).toContain('SHARED_SYNTHETIC_MARKER');
      expect(JSON.stringify(result.messages)).not.toMatch(/PRIVATE_SYNTHETIC_MARKER|LEGACY_SYNTHETIC_MARKER/u);
    }
  });

  it('can switch a private session to a remote binding without forwarding its history', () => {
    const shared = memory('shared', 'An explicitly shared synthetic preference.'); shared.contextMetadata!.privacy = 'cloud-allowed';
    const options = input({ history: [message('old', 'user', 'PRIVATE_HISTORY_MARKER')], historyPrivacy: 'local-only', memories: [shared] });
    const local = prepareChatContext(options);
    expect(local.projection.privacy).toBe('local-only');
    const remote = prepareChatContext({ ...options, binding: { ...options.binding, serviceExecution: 'remote' } });
    expect(remote.projection.historyMessageIds).toEqual([]);
    expect(remote.projection.privacy).toBe('cloud-allowed');
    expect(remote.projection.memoryReferences).toEqual([{ id: 'shared', revision: 1 }]);
    expect(remote.messages.at(-1)).toEqual(options.requiredMessages[0]);
    expect(JSON.stringify(remote.messages)).not.toContain('PRIVATE_HISTORY_MARKER');
  });

  it('keeps imported style local-only and joins its privacy into derived history', () => {
    const speakingStyle: ActiveSpeakingStyle = {
      importId: 'import', draftId: 'draft', name: 'Synthetic speaker', enabled: true,
      style: { tone: 'warm', length: 'brief', sentences: 'short', emoji: 'none', phrases: ['STYLE_MARKER'] },
    };
    const options = input({ speakingStyle });
    const local = prepareChatContext(options);
    expect(JSON.stringify(local.messages)).toContain('STYLE_MARKER');
    expect(local.projection.privacy).toBe('local-only');
    const remote = prepareChatContext({ ...options, binding: { ...options.binding, serviceExecution: 'remote' } });
    expect(JSON.stringify(remote.messages)).not.toContain('STYLE_MARKER');
    expect(remote.projection.privacy).toBe('cloud-allowed');
  });

  it('fails closed for the compatibility helper without an actual binding', () => {
    const result = buildChatContext({ sessionId: 'session', locale: 'en', query: 'Question', history: [message('past', 'user', 'HISTORY_MARKER')], memories: [memory('remembered', 'MEMORY_MARKER')] });
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe('system');
    expect(JSON.stringify(result)).not.toMatch(/HISTORY_MARKER|MEMORY_MARKER/u);
  });
});

describe('bounded conversation continuity', () => {
  it('summarizes only authorized overflow, records exact source revisions, and retains the newest raw turn', () => {
    const history = Array.from({length:48},(_,i) => message('m'+i, i%2 ? 'assistant':'user', 'Synthetic historical turn '+i));
    const privateSource = message('secret','user','PRIVATE_NEVER_RECAP');
    privateSource.contextTrace = trace({privacy:'local-only'});
    history.unshift(privateSource);
    const result = prepareChatContext(input({history, binding:{...input().binding,kind:'openai',serviceExecution:'remote'}}));
    const summary = result.messages.find(item => item.content.startsWith('Earlier conversation excerpts'));
    expect(summary?.role).toBe('assistant');
    expect(summary?.content).toContain('Synthetic historical turn 0');
    expect(JSON.stringify(result.messages)).not.toContain('PRIVATE_NEVER_RECAP');
    expect(result.messages.at(-2)?.content).toBe('Synthetic historical turn 47');
    expect(result.excluded.summarizedCount).toBeGreaterThan(0);
    expect(result.projection.summaryReferences?.some(ref => ref.messageId === 'm0' && /^[\da-f]{64}$/u.test(ref.contentSHA256))).toBe(true);
    expect(result.projection.historyMessageIds).not.toContain('secret');
  });

  it('reduces an older verified read page only when necessary, retaining the newest reply and write receipt', () => {
    const text = 'A synthetic reference with varied tokens. '.repeat(1900);
    const calls = (id:string,name:string,args:object):ModelTurnMessage => ({role:'assistant',content:'',toolCalls:[{id,name,argumentsJson:JSON.stringify(args)}]});
    const page = JSON.stringify({text,sourceSHA256:'a'.repeat(64),offset:0,totalCharacters:text.length,nextOffset:null});
    const latest = JSON.stringify({written:true,path:'result.txt',bytes:2,sha256:'b'.repeat(64)});
    const required:ModelTurnMessage[] = [
      {role:'user',content:'Read and write an answer.'},
      calls('read','web.read',{url:'https://example.org/page'}),
      {role:'tool',toolCallId:'read',hostToolResult:'success',content:page},
      calls('write','workspace.write',{path:'result.txt',content:'ok'}),
      {role:'tool',toolCallId:'write',hostToolResult:'success',content:latest},
    ];
    const full = prepareChatContext(input({requiredMessages:required,contextBudget:{contextWindowTokens:131072,safetyMarginTokens:256,capacitySource:'configured'}}));
    expect(full.excluded.compactedToolPages).toBeUndefined();
    const compact = prepareChatContext(input({requiredMessages:required,contextBudget:{contextWindowTokens:4000,safetyMarginTokens:256,capacitySource:'configured'}}));
    expect(compact.excluded.compactedToolPages).toBe(1);
    const old = compact.messages.find(item => item.toolCallId==='read')!;
    expect(JSON.parse(old.content)).toMatchObject({compressed:true,source:'https://example.org/page',offset:0,sourceSHA256:'a'.repeat(64)});
    expect(compact.messages.at(-1)).toEqual(required.at(-1));
    expect(required[2]?.content).toBe(page);
  });
});
