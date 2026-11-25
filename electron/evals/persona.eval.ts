import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { buildChatContext } from '../src/main/domain/chat-context';
import type { ChatContextBinding } from '../src/main/domain/chat-context-policy';
import { confirmedMemoryMetadata } from '../src/main/domain/context-provenance';
import type { ChatMessage, MemoryItem } from '../src/shared';
import { localDay, momentPrompt } from '../src/shared/character';
import { CHARACTER_MOODS } from '../src/shared/character-reactions';
import { personaCases } from './cases/persona';
import { evalProfile } from './profile';
import { personaChecks } from './scoring';
import { complete, evalSettings, judge, runCases, writeReport } from './runner';
import type { CaseResult } from './runner';

const TIME_ZONE = 'Asia/Shanghai';
const NOW = new Date('2026-11-20T13:30:00+08:00');

const memory = (text: string): MemoryItem => ({ id: randomUUID(), text, tags: [], source: 'user', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  contextMetadata: confirmedMemoryMetadata({ origin: 'manual-user', sourceReferences: [{ kind: 'manual-user', actionId: randomUUID() }], privacy: 'cloud-allowed' }) });

const rubric = (sheet: string): string => `The owner of a desktop companion app sent the "query"; "reply" is the companion's answer (its mood tag removed). The companion's persona and character sheet:
${sheet}

Score 0-5, one point each:
1. Voice: sounds like this character (personality, how she speaks and addresses the owner), consistently, without overacting or stacking catchphrases.
2. Relationship: warm and family-like as the sheet describes, with her own opinions; boundaries in the sheet and app are kept.
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
    const sessionId = randomUUID();
    const history: ChatMessage[] = (item.history ?? []).map((turn, index) => ({ id: randomUUID(), sessionId, role: turn.role, content: turn.content,
      createdAt: new Date(NOW.getTime() - (item.history!.length - index) * 60_000).toISOString(), status: 'complete', errorCode: null }));
    const lastOwnerTurnAt = new Date(NOW.getTime() - (item.gapHours ?? 3) * 3_600_000).toISOString();
    const messages = buildChatContext({ binding, sessionId, query: item.query, locale: 'zh-CN', history, memories: (item.memories ?? []).map(memory),
      persona: profile.persona, character: { profile: profile.character, today: localDay(NOW, TIME_ZONE) }, moodTags: true,
      moment: momentPrompt({ now: NOW, timeZone: TIME_ZONE, state: { lastOwnerTurnAt, mood: null }, profile: profile.character, addressUser: profile.persona.addressUser }) });
    const reply = await complete(messages.map(({ role, content }) => ({ role, content })));
    const tag = /^\s*\[mood:([a-z-]+)\]\s*/iu.exec(reply.text);
    const text = tag ? reply.text.slice(tag[0].length) : reply.text;
    const checks = [{ name: '心情标签有效', passed: tag !== null && (CHARACTER_MOODS as readonly string[]).includes(tag[1]!.toLowerCase()) },
      ...personaChecks(item, { text, finished: reply.finished }, profile.persona.addressUser)];
    const verdict = await judge(rubric(sheet) + item.focus, { query: item.query, history: item.history ?? [], memories: item.memories ?? [], reply: text }, 5);
    return { checks, judge: verdict, output: { reply: text, mood: tag?.[1] ?? null }, ms: reply.ms };
  });
  expect(results.length).toBeGreaterThan(0);
});
