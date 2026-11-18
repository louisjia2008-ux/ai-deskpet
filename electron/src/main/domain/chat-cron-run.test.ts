import { describe, expect, it } from 'vitest';
import { cronNotificationBody, previousCronResults, privateCronPrompt, privateCronText, traceCronResults } from './chat-cron-run';
import { stickerReply } from '../../shared/qq-sticker-reply';
import type { ChatMessage, ContextTrace } from '../../shared';
import type { ChatCronRun } from '../../shared/chat-cron';
import { buildChatContext } from './chat-context';

describe('cronNotificationBody', () => {
  it('collapses whitespace and leaves short replies intact', () => {
    expect(cronNotificationBody('  早安！\n\n今天 12°C，\t记得加外套。 ')).toBe('早安！ 今天 12°C， 记得加外套。');
  });
  it('is empty for a blank reply so the caller can use its fallback', () => {
    expect(cronNotificationBody(' \n ')).toBe('');
  });
  it('truncates long replies without splitting a surrogate pair', () => {
    const body = cronNotificationBody('😀'.repeat(300));
    expect(Array.from(body)).toHaveLength(200);
    expect(body.endsWith('😀…')).toBe(true);
  });
  it.each(['none', 'with-text:greeting', 'only:thanks', 'invalid'])('does not leak the reserved sticker prefix in notifications: %s', hint => {
    expect(cronNotificationBody(`[sticker:${hint}]\n早安，13~19°C。`)).toBe('早安，13~19°C。');
  });
  it('projects private delivery only, preserving facts and the complete original', () => {
    const original = '[sticker:with-text:greeting]\n今天上海阴转多云，13~19°C，下午有雨。来源：中国天气网今早05:30更新 https://weather.example/today';
    expect(privateCronText(original)).toBe('今天上海阴转多云，13~19°C，下午有雨。（中国天气网说的）');
    // Real model output sometimes drops the "来源：" label.
    expect(privateCronText('记得带伞呀。\n\n合成天气台 06:00 更新 https://weather.example.invalid/day-1')).toBe('记得带伞呀。\n\n（合成天气台说的）');
    expect(privateCronText('记得带伞呀。\n\n合成天气台 06:00 更新 · https://weather.example.invalid/day-2')).toBe('记得带伞呀。\n\n（合成天气台说的）');
    expect(privateCronText('这篇文章不错 https://example.invalid/post')).toBe('这篇文章不错');
    expect(original).toContain('https://weather.example/today');
    expect(stickerReply(original).decision).toEqual({ mode: 'with-text', scene: 'greeting' });
    expect(privateCronPrompt(Array.from({ length: 10 }, (_, n) => `result ${n}`))).not.toContain('result 2"');
    expect(privateCronPrompt(['old opening'])).toContain('old opening');
  });
  it('takes seven allowed results of the same schedule, not seven runs before privacy filtering, and traces their complete lineage', () => {
    const runs: ChatCronRun[] = [], history: ChatMessage[] = [];
    const trace: ContextTrace = { version: 1, lineage: 'complete', privacy: 'cloud-allowed', scope: { kind: 'global' }, memoryReferences: [], historyMessageIds: [] };
    for (let n = 0; n < 12; n++) {
      const stamp = `2026-11-${String(n + 1).padStart(2, '0')}T08:00:00Z`, id = `run-${n}`;
      runs.push({ id, key: id, scheduleId: 'weather', sessionId: 'owner', scheduleRevision: 1, dueAt: stamp, status: 'succeeded', createdAt: stamp, startedAt: stamp, finishedAt: stamp, errorCode: null });
      history.push({ id: `answer-${n}`, sessionId: 'owner', role: 'assistant', status: 'complete', errorCode: null, createdAt: stamp, content: `result ${n}`,
        contextTrace: { ...trace, memoryReferences: [{ id: `memory-${n}`, revision: 1 }] }, requestReceipts: [{ runId: id }] as ChatMessage['requestReceipts'] });
    }
    // Results 9–11 were revoked by the caller's current-privacy projection.
    const selected = previousCronResults(runs, history.slice(0, 9), 'weather', 'current');
    expect(selected.map(message => message.id)).toEqual(history.slice(2, 9).map(message => message.id));
    expect(previousCronResults(runs, history, 'another-task', 'current')).toEqual([]);
    const lineage = traceCronResults(trace, selected);
    expect(lineage.historyMessageIds).toEqual(selected.map(message => message.id));
    expect(lineage.memoryReferences).toHaveLength(7); expect(lineage.summaryReferences).toHaveLength(7);
  });
  it('keeps the complete cited result available to the next owner source-follow-up, not the private presentation', () => {
    const original = '合成地点13~19°C，下午有雨。来源：天气网 https://weather.example.invalid/today';
    const answer: ChatMessage = { id: 'source-answer', sessionId: 'owner', role: 'assistant', status: 'complete', content: original, createdAt: '2026-11-15T08:00:00Z', errorCode: null,
      contextTrace: { version: 1, lineage: 'complete', privacy: 'cloud-allowed', scope: { kind: 'global' }, memoryReferences: [], historyMessageIds: [] } };
    const next = buildChatContext({ sessionId: 'owner', history: [answer], memories: [], query: '哪看的？给我链接', locale: 'zh-CN',
      binding: { providerId: 'fixture', model: 'fixture', kind: 'openai', baseUrl: 'https://fixture.invalid/v1' } });
    expect(JSON.stringify(next)).toContain('https://weather.example.invalid/today'); expect(privateCronText(original)).not.toContain('https://');
  });
});
