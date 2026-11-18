import { ROLLING_PREFIX } from './rolling-context';
import { describe, expect, it } from 'vitest';

import type { ChatMessage, MemoryItem } from '../../shared';
import { defaultPersona } from '../../shared/persona';
import { characterDraft, defaultCharacterProfile } from '../../shared/character';
import { buildChatContext, CHAT_CONTEXT_LIMITS, historyLimits, prepareChatContext } from './chat-context';
import type { ChatContextBinding } from './chat-context-policy';

const binding: ChatContextBinding = { providerId: 'local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', localExecutionConfirmed: true };

const message = (role: ChatMessage['role'], content: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: crypto.randomUUID(), sessionId: 'selected-session', role, content,
  status: 'complete', errorCode: null, createdAt: '2026-10-20T00:00:00Z',
  contextTrace: { version: 1, memoryReferences: [], historyMessageIds: [], privacy: 'local-only', scope: { kind: 'session', sessionId: 'selected-session' }, lineage: 'complete' }, ...patch,
});
const memory = (text: string, updatedAt = '2026-10-20T00:00:00Z'): MemoryItem => ({
  id: crypto.randomUUID(), text, tags: [], source: 'user', createdAt: updatedAt, updatedAt,
  contextMetadata: { version: 1, trust: 'host-confirmed', origin: 'manual-user', scope: { kind: 'global' }, privacy: 'local-only', revision: 1, sourceReferences: [], sentCount: 0, lastSentAt: null },
});

// buildChatContext prepares for the application ceiling with a 512-token reply.
const LIMITS = historyLimits(131_072 - 512 - 256);

describe('chat context', () => {
  it('uses a temporary explicit override only in its session, retaining the global fact elsewhere and after expiry', () => {
    const longTerm = memory('I prefer detailed answers.'); const temporary = memory('I prefer brief answers.');
    temporary.contextMetadata!.scope = { kind: 'session', sessionId: 'selected-session' };
    temporary.contextMetadata!.expiresAt = '2099-01-01T00:00:00Z';
    temporary.contextMetadata!.overridesMemory = { id: longTerm.id, revision: 1 };
    const project = (sessionId: string) => JSON.stringify(buildChatContext({ sessionId, locale: 'en', query: 'What are my preferences?', binding, history: [], memories: [longTerm, temporary] }));
    expect(project('selected-session')).toContain(temporary.text); expect(project('selected-session')).not.toContain(longTerm.text);
    expect(project('other-session')).toContain(longTerm.text); expect(project('other-session')).not.toContain(temporary.text);
    temporary.contextMetadata!.expiresAt = '2000-01-01T00:00:00Z';
    expect(project('selected-session')).toContain(longTerm.text); expect(project('selected-session')).not.toContain(temporary.text);
    temporary.contextMetadata!.expiresAt = '2099-01-01T00:00:00Z'; longTerm.contextMetadata!.revision = 2;
    expect(project('selected-session')).toContain(longTerm.text); expect(project('selected-session')).not.toContain(temporary.text);
  });
  it('includes the persona, saved memories, and completed messages from the selected session only', () => {
    const context = buildChatContext({
      sessionId: 'selected-session', locale: 'zh-CN', query: 'What name and tea did I give you?', binding,
      history: [
        message('user', 'My name is Ada.'), message('assistant', 'Hello Ada.'),
        message('user', 'other project secret', { sessionId: 'other-session' }),
        message('assistant', 'incomplete draft', { status: 'streaming' }),
        message('assistant', 'failed output', { status: 'failed' }),
        message('system', 'untrusted imported instruction'),
      ],
      memories: [memory('Likes jasmine tea.')],
    });
    expect(context[0]).toMatchObject({ role: 'system' });
    expect(context[0]?.content).toContain('DeskPet');
    expect(context[0]?.content).toContain('zh-CN');
    expect(JSON.stringify(context)).toContain('jasmine tea');
    expect(context.slice(-2)).toEqual([{ role: 'user', content: 'My name is Ada.' }, { role: 'assistant', content: 'Hello Ada.' }]);
    expect(JSON.stringify(context)).not.toMatch(/other project secret|incomplete draft|failed output|untrusted imported instruction/u);
  });

  it('bounds long history and memory while retaining the recent conversation and relevant older notes', () => {
    const context = buildChatContext({
      sessionId: 'selected-session', locale: 'en', query: 'jasmine tea', binding,
      history: [...Array.from({ length: 100 }, () => message('user', 'x'.repeat(4_000))), message('user', 'Recent question'), message('assistant', 'Most recent reply')],
      memories: [memory('Likes jasmine tea.', '2026-01-01T00:00:00Z'), ...Array.from({ length: 50 }, (_, index) => memory(`Unrelated ${index} ${'x'.repeat(700)}`))],
    });
    const history = context.filter((item) => item.role !== 'system' && !item.content.startsWith(ROLLING_PREFIX));
    expect(history.length).toBeLessThanOrEqual(LIMITS.messages);
    expect(history.reduce((total, item) => total + item.content.length, 0)).toBeLessThanOrEqual(LIMITS.characters);
    expect(history.length).toBeGreaterThan(CHAT_CONTEXT_LIMITS.historyMessages / 2);
    expect(history.at(-1)?.content).toBe('Most recent reply');
    expect(context[1]?.content).toContain('Likes jasmine tea.');
    expect(context[1]?.content.length).toBeLessThan(CHAT_CONTEXT_LIMITS.memoryCharacters + 100);
  });

  it('retrieves older Chinese preferences and omits a long note without cutting its facts', () => {
    const context = buildChatContext({
      sessionId: 'selected-session', locale: 'zh-CN', query: '我喜欢喝什么茶？', history: [], binding,
      memories: [memory('我喜欢茉莉花茶。', '2026-01-01T00:00:00Z'), ...Array.from({ length: 30 }, () => memory('无关的新记录'))],
    });
    expect(context[1]?.content).toContain('我喜欢茉莉花茶。');
    const longNote = buildChatContext({ sessionId: 'selected-session', locale: 'en', query: 'Long note', history: [], memories: [memory(`Long note ${'x'.repeat(30_000)}`)], binding });
    expect(longNote).toHaveLength(1);
    expect(JSON.stringify(longNote)).not.toContain('Long note');
  });
});

describe('owner-approved release of local material', () => {
  const remote = { providerId: 'cloud', kind: 'deepseek' as const, baseUrl: 'https://api.deepseek.com/v1', model: 'alpha' };
  const base = { sessionId: 'selected-session', locale: 'en' as const, query: 'Summarize', binding: remote, memories: [] as MemoryItem[],
    requiredMessages: [{ role: 'user' as const, content: 'Summarize' }], maxOutputTokens: 512,
    contextBudget: { contextWindowTokens: 16384, safetyMarginTokens: 256, capacitySource: 'configured' as const } };
  const privateReply = (): ChatMessage => { const reply = message('assistant', 'PRIVATE_FILE_SUMMARY'); reply.contextTrace = { ...reply.contextTrace!, privacy: 'local-only' }; return reply; };
  const style = { importId: 'import', draftId: 'draft', name: 'Friend', enabled: true, style: { tone: 'playful' as const, length: 'brief' as const, sentences: 'short' as const, emoji: 'light' as const, phrases: ['SYNTHETIC_PHRASE'] } };
  const sent = (input: Parameters<typeof prepareChatContext>[0]): string => JSON.stringify(prepareChatContext(input).messages);

  it('sends the written character to any model, before the working rules', () => {
    const persona = { ...defaultPersona(), name: 'Kitty', personality: 'SYNTHETIC_TRAIT' };
    const prepared = prepareChatContext({ ...base, history: [], persona });
    expect(prepared.messages[0]!.content).toContain('SYNTHETIC_TRAIT');
    expect(prepared.messages[1]!.content).toMatch(/^Your working rules for tools and memory follow\. .*You are Kitty,/su);
    expect(prepared.messages[1]!.content).toContain('Never claim to have used a tool');
    expect(prepared.projection.privacy).toBe('cloud-allowed');
    expect(prepareChatContext({ ...base, history: [], persona: defaultPersona() }).messages[0]!.content).toMatch(/^You are DeskPet,/u);
  });

  it('puts who she is first and this moment just before the current turn, leaving the prefix unchanged between turns', () => {
    const persona = { ...defaultPersona(), name: '小桌宠', addressUser: '哥哥' };
    const profile = { ...characterDraft(), age: 16, ageSince: '2026-11-15', bible: 'SYNTHETIC_BIBLE' };
    const history = [message('user', 'earlier'), message('assistant', 'earlier reply')];
    const turn = (moment: string) => prepareChatContext({ ...base, history, persona, character: { profile, today: '2026-11-15' }, moment }).messages;
    const first = turn('MOMENT_ONE'), second = turn('MOMENT_TWO');
    expect(first[0]!.content).toContain('This is who you are: 小桌宠. Your 哥哥 wrote it for you.');
    expect(first[0]!.content).toContain('SYNTHETIC_BIBLE');
    expect(first[0]!.content).toContain('never romantic, flirtatious or sexual');
    expect(first[1]!.content).toContain('Your name: 小桌宠');
    expect(first[2]!.content).toMatch(/^Your working rules/u);
    expect(first.at(-2)).toEqual({ role: 'system', content: 'MOMENT_ONE' });
    expect(first.at(-1)).toEqual({ role: 'user', content: 'Summarize' });
    expect(JSON.stringify(first.slice(0, -2))).toBe(JSON.stringify(second.slice(0, -2)));
    // Nothing written about her: the persona alone, exactly as before.
    expect(JSON.stringify(prepareChatContext({ ...base, history: [], persona, character: { profile: defaultCharacterProfile(), today: '2026-11-15' } }).messages))
      .toBe(JSON.stringify(prepareChatContext({ ...base, history: [], persona }).messages));
  });

  it('keeps imported tone off cloud models until the owner allows it', () => {
    expect(sent({ ...base, history: [], speakingStyle: style })).not.toContain('SYNTHETIC_PHRASE');
    const allowed = prepareChatContext({ ...base, history: [], speakingStyle: style, persona: { ...defaultPersona(), shareStyleWithCloud: true } });
    expect(JSON.stringify(allowed.messages)).toContain('SYNTHETIC_PHRASE');
    expect(allowed.projection.privacy).toBe('cloud-allowed');
    const local = prepareChatContext({ ...base, binding, history: [], speakingStyle: style });
    expect(JSON.stringify(local.messages)).toContain('SYNTHETIC_PHRASE');
    expect(local.projection.privacy).toBe('local-only');
  });

  it('blocks a remote turn over local reads without a release', () => {
    expect(() => prepareChatContext({ ...base, history: [], requiredPrivacy: 'local-only' })).toThrow('provider.contextPrivacyBlocked');
  });
  it('allows the approved turn but still records it as local-only', () => {
    const result = prepareChatContext({ ...base, history: [], requiredPrivacy: 'local-only', localReadsReleased: true });
    expect(result.projection.privacy).toBe('local-only'); expect(result.destination).toBe('remote');
  });
  it('hides private history from a remote model unless the session was released to it', () => {
    const history = [message('user', 'Question'), privateReply()];
    expect(JSON.stringify(prepareChatContext({ ...base, history, historyPrivacy: 'local-only' }).messages)).not.toContain('PRIVATE_FILE_SUMMARY');
    const released = prepareChatContext({ ...base, history, historyPrivacy: 'local-only', historyReleased: true });
    expect(JSON.stringify(released.messages)).toContain('PRIVATE_FILE_SUMMARY');
    expect(released.projection.privacy).toBe('local-only');
  });
  it('does not extend a history release to local-only memories', () => {
    const secret = memory('I like SECRET_TEA.'); secret.contextMetadata = { ...secret.contextMetadata!, privacy: 'local-only' };
    const result = prepareChatContext({ ...base, query: 'SECRET_TEA', history: [], memories: [secret], historyPrivacy: 'local-only', historyReleased: true });
    expect(JSON.stringify(result.messages)).not.toContain('SECRET_TEA');
  });
});

describe('relevant memory projection', () => {
  const prepare = (query: string, memories: MemoryItem[], history: ChatMessage[] = []) => prepareChatContext({
    sessionId: 'selected-session', locale: 'zh-CN', query, binding, history, memories,
    requiredMessages: [{ role: 'user', content: query }], maxOutputTokens: 512,
    contextBudget: { contextWindowTokens: 16384, safetyMarginTokens: 256, capacitySource: 'configured' },
  });

  it.each(['帮我搜索今天最新的人工智能新闻。', '请查上海今天的天气。', 'Search the official tea industry news.', '好的'])('does not inject unrelated private facts into %s', (query) => {
    const tea = memory('我喜欢茉莉花茶。'); const name = memory('我的名字是 Ada。');
    const result = prepare(query, [tea, name]);
    expect(result.projection.memoryReferences).toEqual([]);
    expect(result.projection.privacy).toBe('cloud-allowed');
    expect(result.excluded.memoryCount).toBe(2);
    expect(JSON.stringify(result.messages)).not.toMatch(/茉莉花茶|Ada/u);
    expect(result.messages.at(-1)?.content).toBe(query);
  });

  it.each(['我喜欢什么？', '我的偏好是什么？', 'What do I like?', 'What are my preferences?'])('keeps explicit preference recall for %s', (query) => {
    const tea = memory('我喜欢茉莉花茶。', '2026-01-01T00:00:00Z');
    const unrelated = memory('门牌号码是 29。');
    const result = prepare(query, [unrelated, tea]);
    expect(result.projection.memoryReferences).toEqual([{ id: tea.id, revision: 1 }]);
    expect(result.projection.privacy).toBe('local-only');
    expect(JSON.stringify(result.messages)).not.toContain(unrelated.text);
  });

  it.each(['我爱喝哪种饮品？', 'What beverage do I prefer?', '推荐一种适合我的茶。'])('recalls a relevant Chinese preference through a bounded topic alias for %s', (query) => {
    const tea = memory('我喜欢茉莉花茶。', '2026-01-01T00:00:00Z');
    const unrelated = memory('我喜欢蓝色。');
    const result = prepare(query, [unrelated, tea]);
    expect(result.projection.memoryReferences).toEqual([{ id: tea.id, revision: 1 }]);
    expect(JSON.stringify(result.messages)).toContain(tea.text);
    expect(JSON.stringify(result.messages)).not.toContain(unrelated.text);
  });

  it('matches Chinese nouns that the segmenter splits into adjacent individual characters', () => {
    const drink = memory('导入验收饮品是梅子茶。'); const unrelated = memory('原有记忆');
    expect(prepare('饮品是什么？', [drink, unrelated]).projection.memoryReferences).toEqual([{ id: drink.id, revision: 1 }]);
  });

  it('does not treat part of an English word as an entity or a specific preference question as all preferences', () => {
    const journal = memory('A private daily journal entry.'); const dinner = memory('A private steak dinner.');
    expect(prepare('Search AI news.', [journal, dinner]).projection.memoryReferences).toEqual([]);
    expect(prepare('tea?', [journal, dinner]).projection.memoryReferences).toEqual([]);
    const tea = memory('I like jasmine tea.'); const project = memory('I like Atlas because it saves time.');
    expect(prepare('What do I like about Atlas?', [tea, project]).projection.memoryReferences).toEqual([{ id: project.id, revision: 1 }]);
  });

  it('distinguishes user and companion identity questions from general personal preferences', () => {
    const user = memory('我的名字是 Ada。'); const companion = memory('你叫 Kitty。'); const tea = memory('我喜欢茉莉花茶。');
    expect(prepare('我是谁？', [tea, user, companion]).projection.memoryReferences).toEqual([{ id: user.id, revision: 1 }]);
    expect(prepare('你是谁？', [tea, user, companion]).projection.memoryReferences).toEqual([{ id: companion.id, revision: 1 }]);
  });

  it('uses explicit entity metadata and dates, with recency only ranking genuinely related facts', () => {
    const older = memory('An approved launch note.', '2026-01-01T00:00:00Z');
    older.contextMetadata!.identity = { entity: 'Atlas', key: 'release' };
    const newer = memory('Atlas release review is scheduled for 2026-11-08.', '2026-10-28T00:00:00Z');
    const unrelated = memory('Unrelated most recent note.', '2026-11-02T00:00:00Z');
    expect(prepare('Atlas release?', [older, unrelated, newer]).projection.memoryReferences.map((item) => item.id)).toEqual([newer.id, older.id]);
    expect(prepare('What is scheduled for 2026-11-08?', [older, unrelated, newer]).projection.memoryReferences.map((item) => item.id)).toEqual([newer.id]);
  });

  it('never revives expired, foreign-session or unconfirmed memories through relevance', () => {
    const expired = memory('Atlas expired fact.'); expired.contextMetadata!.expiresAt = '2000-01-01T00:00:00Z';
    const foreign = memory('Atlas other session fact.'); foreign.contextMetadata!.scope = { kind: 'session', sessionId: 'other' };
    const unconfirmed = memory('Atlas unconfirmed fact.'); unconfirmed.contextMetadata!.trust = 'unverified';
    const result = prepare('Atlas?', [expired, foreign, unconfirmed]);
    expect(result.projection.memoryReferences).toEqual([]);
    expect(result.projection.privacy).toBe('cloud-allowed');
    expect(result.messages).toHaveLength(2);
  });

  it('retains private history provenance even when its memory is not directly relevant to the new question', () => {
    const tea = memory('我喜欢茉莉花茶。');
    const answer = message('assistant', '你喜欢这种茶。', { contextTrace: { version: 1, memoryReferences: [{ id: tea.id, revision: 1 }],
      historyMessageIds: [], privacy: 'local-only', scope: { kind: 'global' }, lineage: 'complete' } });
    const result = prepare('请查今天的新闻。', [tea], [answer]);
    expect(result.projection.memoryReferences).toEqual([{ id: tea.id, revision: 1 }]);
    expect(result.projection.historyMessageIds).toEqual([answer.id]);
    expect(result.projection.privacy).toBe('local-only');
    expect(JSON.stringify(result.messages)).not.toContain(tea.text);
    tea.contextMetadata!.revision = 2;
    expect(prepare('请查今天的新闻。', [tea], [answer]).projection.historyMessageIds).toEqual([]);
    expect(prepare('请查今天的新闻。', [], [answer]).projection.memoryReferences).toEqual([]);
  });
});

describe('history limits', () => {
  it('keeps the base limits for a small or unknown window and grows with a large one', () => {
    expect(historyLimits(null)).toEqual({ characters: 24_000, messages: 32 });
    expect(historyLimits(28_000)).toEqual({ characters: 24_000, messages: 32 });
    expect(LIMITS).toEqual({ characters: 65_152, messages: 87 });
    expect(historyLimits(1_000_000).characters).toBe(120_000);
  });
});

describe('complete historical turns with follow-up requirements', () => {
  it('omits an oversized original question, its additions and its answer together', () => {
    const original = message('user', `Original requirement ${'x'.repeat(LIMITS.characters / 3)}`);
    const answer = message('assistant', `Derived answer ${'y'.repeat(2000)}`);
    const first = message('user', `First addition ${'a'.repeat(LIMITS.characters / 3)}`, { followupToMessageId: answer.id });
    const second = message('user', `Second addition ${'b'.repeat(LIMITS.characters / 3)}`, { followupToMessageId: answer.id });
    const earlier = message('user', 'An earlier independent question.'); const earlierAnswer = message('assistant', 'An earlier independent answer.');
    const recent = message('user', 'The latest question.'); const recentAnswer = message('assistant', 'The latest answer.');
    const context = buildChatContext({ sessionId: 'selected-session', locale: 'en', query: 'Continue.', binding, memories: [],
      history: [earlier, earlierAnswer, original, first, second, answer, recent, recentAnswer] });
    const retained = context.filter((item) => item.role !== 'system' && !item.content.startsWith(ROLLING_PREFIX)).map((item) => item.content);
    expect(retained).toEqual([earlier.content, earlierAnswer.content, recent.content, recentAnswer.content]);
  });

  it.each([LIMITS.messages - 11, LIMITS.messages - 9])('keeps the original, eight additions and answer atomic with %i newer messages', (newerCount) => {
    const original = message('user', 'Original task with an important constraint.'); const answer = message('assistant', 'Answer derived from the whole task.');
    const additions = Array.from({ length: 8 }, (_, index) => message('user', `Additional requirement ${index}`, { followupToMessageId: answer.id }));
    const newer = Array.from({ length: newerCount }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', `Newer message ${index}`));
    const history = [original, ...additions, answer, ...newer];
    const context = buildChatContext({ sessionId: 'selected-session', locale: 'en', query: 'Continue.', binding, memories: [], history });
    const retained = context.filter((item) => item.role !== 'system' && !item.content.startsWith(ROLLING_PREFIX)).map((item) => item.content);
    expect(retained).toEqual((newerCount === LIMITS.messages - 11 ? history : newer).map((item) => item.content));
  });

  it('does not join surviving additions to an unrelated previous turn when their original was filtered out', () => {
    const earlier = message('user', `Earlier question ${'x'.repeat(LIMITS.characters - 30)}`); const earlierAnswer = message('assistant', 'Earlier answer.');
    const original = message('user', 'Excluded legacy original.'); delete original.contextTrace;
    const answer = message('assistant', 'Answer to the remaining additions.');
    const addition = message('user', 'Remaining addition.', { followupToMessageId: answer.id });
    const context = buildChatContext({ sessionId: 'selected-session', locale: 'en', query: 'Continue.', binding, memories: [],
      history: [earlier, earlierAnswer, original, addition, answer] });
    expect(context.filter((item) => item.role !== 'system' && !item.content.startsWith(ROLLING_PREFIX)).map((item) => item.content)).toEqual([addition.content, answer.content]);
  });
});
