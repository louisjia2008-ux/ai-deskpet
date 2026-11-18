import { expect, it } from 'vitest';
import { classifyWeChatFollowup, wechatFollowupEvidenceReadSchema, type WeChatFollowupEvidenceRow } from './wechat-followup-evidence';

const id = (number: number) => number.toString(16).padStart(64, '0');
const mention = (number: number, at: number, text: string, author = 100): WeChatFollowupEvidenceRow =>
  ({ id: id(number), at, text, role: 'member', author: id(author), mentionsOwner: true });
const reply = (number: number, at: number, text: string, quote?: number): WeChatFollowupEvidenceRow =>
  ({ id: id(number), at, text, role: 'owner', ...(quote === undefined ? {} : { quoteId: id(quote) }) });

it('rejects guesses from display names or synthetic member quote fields', () => {
  const source = { rows: [mention(1, 100, '@示例主人 周五能来吗？')], truncated: false };
  expect(wechatFollowupEvidenceReadSchema.safeParse(source).success).toBe(true);
  expect(wechatFollowupEvidenceReadSchema.safeParse({ ...source, rows: [{ ...source.rows[0], mentionsOwner: false }] }).success).toBe(false);
  expect(wechatFollowupEvidenceReadSchema.safeParse({ ...source, rows: [{ ...source.rows[0], quoteId: id(2) }] }).success).toBe(false);
});

it('merges an exact repeated request by the same sender and closes it on a reply to either source', () => {
  const rows = [mention(1, 100, '@甲 周五能来吗？'), mention(2, 101, '@甲 再问一下，周五能来吗？'),
    mention(3, 101, '@甲 周五能来吗？', 101), reply(4, 102, '周五可以。', 2)];
  expect(classifyWeChatFollowup(rows)).toEqual([
    { id: id(1), at: 100, summary: '周五能来吗？', detail: '@甲 周五能来吗？', answered: true, aliases: [id(1), id(2)] },
    { id: id(3), at: 101, summary: '周五能来吗？', detail: '@甲 周五能来吗？', answered: false, aliases: [id(3)] },
  ]);
});

it('only accepts an unquoted reply with an unambiguous explicit answer and shared task', () => {
  const request = mention(1, 100, '@甲 周五下午能来吗？');
  for (const text of ['我去买菜了', '周五下午可以去超市', '周五上午可以', '周五下午可以吗？', '可以']) {
    expect(classifyWeChatFollowup([request, reply(2, 101, text)])[0]?.answered, text).toBe(false);
  }
  expect(classifyWeChatFollowup([request, reply(2, 101, '星期五下午我可以。')])[0]?.answered).toBe(true);
  expect(classifyWeChatFollowup([request, reply(2, 101, '星期五下午我可以。', 90)])[0]?.answered).toBe(false);
  const ambiguous = [request, mention(3, 100, '周五晚餐要一起参加吗？'), reply(2, 101, '周五我可以。')];
  expect(classifyWeChatFollowup(ambiguous).every(row => !row.answered)).toBe(true);
  const task = mention(1, 100, '@甲 请把选手名单发给我。');
  expect(classifyWeChatFollowup([task, reply(2, 101, '选手名单我已经发了。')])[0]?.answered).toBe(true);
  expect(classifyWeChatFollowup([task, reply(2, 101, '另一份选手名单我已经发了。')])[0]?.answered).toBe(false);
  expect(classifyWeChatFollowup([task, reply(2, 101, '@示例乙 记得把选手名单发给我。')])[0]?.answered).toBe(false);
});

it('keeps only explicit deadline text and bounds the persisted source excerpt', () => {
  expect(classifyWeChatFollowup([mention(1, 100, '周五能来吗？')])[0]?.dueText).toBeUndefined();
  expect(classifyWeChatFollowup([mention(1, 100, '@甲 周四下午6点前确认一下')])[0]?.dueText).toBe('周四下午6点前');
  expect(classifyWeChatFollowup([mention(1, 100, '请把表格给我，截止时间为明天中午12点')])[0]?.dueText).toBe('截止时间为明天中午12点');
  expect(classifyWeChatFollowup([mention(1, 100, '我今天下午3点前下课，到时候能见你吗？')])[0]?.dueText).toBeUndefined();
  const [long] = classifyWeChatFollowup([mention(1, 100, '周五再见🪴'.repeat(75))]);
  expect(long?.detail.length).toBeLessThanOrEqual(240);
  expect(long?.summary.length).toBeLessThanOrEqual(96);
  expect(long?.detail).not.toMatch(/[\uD800-\uDBFF]$/u);
});
