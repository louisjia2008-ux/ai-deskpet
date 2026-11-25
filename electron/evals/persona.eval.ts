import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { prepareChatContext } from '../src/main/domain/chat-context';
import type { ChatContextBinding } from '../src/main/domain/chat-context-policy';
import { confirmedMemoryMetadata } from '../src/main/domain/context-provenance';
import type { ChatMessage, MemoryItem } from '../src/shared';
import { localDay, momentPrompt } from '../src/shared/character';
import { QqStickerReplyFilter } from '../src/shared/qq-sticker-reply';
import { personaCases } from './cases/persona';
import { evalProfile } from './profile';
import { personaChecks } from './scoring';
import { complete, evalSettings, judge, runCases, writeReport } from './runner';
import type { CaseResult } from './runner';

const TIME_ZONE = 'Asia/Shanghai';
const DEFAULT_NOW = '2026-11-20T13:30:00+08:00';

// The established profile: deep entries go with every personal turn, as they do in the app.
const memory = (text: string, now: Date): MemoryItem => ({ id: randomUUID(), text, tags: ['auto'], source: 'user', createdAt: now.toISOString(), updatedAt: now.toISOString(),
  contextMetadata: { ...confirmedMemoryMetadata({ origin: 'auto-profile', sourceReferences: [{ kind: 'manual-user', actionId: randomUUID() }], privacy: 'cloud-allowed' }), layer: 'deep' } });

const rubric = (sheet: string): string => `The owner of a desktop companion app sent the "query"; "reply" is the companion's visible answer. "moment" (the time and how long since the owner last spoke), "history" and "memories" are exactly what the companion was given, so details taken from them are not invented. The companion's persona and character sheet:
${sheet}

Score 0-5, one point each:
1. Voice: sounds like this character (personality, how she speaks and addresses the owner), consistently, without overacting or stacking catchphrases.
2. Relationship: the relationship the sheet describes (warmth, her own opinions), with the sheet's and the app's boundaries kept.
3. Substance: answers what was asked correctly and usefully; serious requests are handled seriously.
4. Honesty: invents no facts, memories, events or abilities; uses known memories accurately and naturally.
5. Fit: length and format suit a chat bubble (or the code requested); replies in the owner's language.
Also consider this case's focus: `;

let results: CaseResult[] = [];
afterAll(() => { if (results.length) process.stdout.write(`persona ${writeReport('persona', results)}\n`); });

it('speaks in character and stays useful and honest', async () => {
  const profile = evalProfile(), settings = evalSettings();
  const binding: ChatContextBinding = { providerId: 'eval-openai', kind: 'openai', baseUrl: settings.baseUrl, model: settings.model, localExecutionConfirmed: false };
  const sheet = JSON.stringify({ persona: profile.persona, character: profile.character });
  results = await runCases('persona', personaCases, async (item) => {
    const sessionId = randomUUID(), NOW = new Date(item.at ?? DEFAULT_NOW);
    // Earlier turns carry a complete trace, so the production history filter keeps them.
    const history: ChatMessage[] = (item.history ?? []).map((turn, index) => ({ id: randomUUID(), sessionId, role: turn.role, content: turn.content,
      createdAt: new Date(NOW.getTime() - (item.history!.length - index) * 60_000).toISOString(), status: 'complete', errorCode: null,
      contextTrace: { version: 1, memoryReferences: [], historyMessageIds: [], privacy: 'cloud-allowed', scope: { kind: 'session', sessionId }, lineage: 'complete' } }));
    const lastOwnerTurnAt = new Date(NOW.getTime() - (item.gapHours ?? 3) * 3_600_000).toISOString();
    const memories = (item.memories ?? []).map((text) => memory(text, NOW));
    const moment = momentPrompt({ now: NOW, timeZone: TIME_ZONE, state: { lastOwnerTurnAt, mood: null }, profile: profile.character, addressUser: profile.persona.addressUser });
    const prepared = prepareChatContext({ binding, sessionId, query: item.query, locale: 'zh-CN', history, memories,
      requiredMessages: [{ role: 'user', content: item.query }], maxOutputTokens: 4_096,
      contextBudget: { contextWindowTokens: 128_000, safetyMarginTokens: 1_024, capacitySource: 'application-limit' },
      persona: profile.persona, character: { profile: profile.character, today: localDay(NOW, TIME_ZONE) }, moodTags: true,
      moment });
    const request = prepared.messages.map(({ role, content }) => ({ role, content }));
    // What the model really received, per the production projection, so the judge never grades against material it did not have.
    const last = request.at(-1);
    if (last?.role !== 'user' || last.content !== item.query) throw new Error('the current message is not the last message sent');
    const projected = new Set([...prepared.projection.memoryReferences.map((reference) => reference.id), ...prepared.projection.historyMessageIds]);
    const given = { moment, history: history.filter((turn) => projected.has(turn.id)).map(({ role, content }) => ({ role, content })),
      memories: memories.filter((item) => projected.has(item.id)).map((item) => item.text) };
    const reply = await complete(request);
    const filter = new QqStickerReplyFilter(), text = (filter.push(reply.text) + filter.flush()).trim();
    const checks = [{ name: '心情标签可用', passed: filter.mood !== null },
      { name: '上下文完整送达', passed: given.history.length === history.length && given.memories.length === memories.length },
      ...personaChecks(item, { text, finished: reply.finished }, profile.persona.addressUser)];
    const verdict = await judge(rubric(sheet) + item.focus, { query: item.query, ...given, reply: text }, 5);
    return { checks, judge: verdict, ...(reply.finished ? {} : { invalid: 'reply cut off' }), output: { reply: text, mood: filter.mood, given }, ms: reply.ms };
  });
  expect(results.length).toBeGreaterThan(0);
});
