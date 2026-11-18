import { z } from 'zod';

const opaqueId = z.string().regex(/^[0-9a-f]{64}$/u);
const common = { id: opaqueId, at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  text: z.string().min(1).max(320).refine(value => value === printable(value) && value.length > 0) };
const member = z.strictObject({ ...common, role: z.literal('member'), author: opaqueId, mentionsOwner: z.literal(true) });
const owner = z.strictObject({ ...common, role: z.literal('owner'), quoteId: opaqueId.optional() });
const evidenceRow = z.discriminatedUnion('role', [member, owner]);
export const wechatFollowupEvidenceReadSchema = z.strictObject({ rows: z.array(evidenceRow).max(256), truncated: z.boolean() });
export type WeChatFollowupEvidenceRow = z.infer<typeof evidenceRow>;

export interface WeChatFollowupClassification {
  id: string;
  at: number;
  summary: string;
  detail: string;
  dueText?: string;
  answered: boolean;
  aliases: string[];
}

const day = '(?:\\d{4}[-年]\\d{1,2}[-月]\\d{1,2}日?|\\d{1,2}月\\d{1,2}[日号]|(?:(?:本|这|下)周|周)[一二三四五六日]|今[天早晚]|明[天早晚]|后天)';
const period = '(?:早上|上午|中午|下午|傍晚|晚上|夜里)';
const clock = '(?:[0-2]?\\d[点时](?:半|[0-5]?\\d分?)?|[0-2]?\\d:[0-5]\\d)';
const time = `(?:${day}(?:${period})?(?:${clock})?|${period}?${clock})`;
const defer = /^(?:(?:再)?问一下|再提醒一下|再确认一下|提醒一下|再问一遍|打扰一下)[：:，,、\s]*/u;
const activeQuestion = /[?？]|(?:是否|到底|能不能|可不可以|行不行|好不好|有没有|吗|么|嘛|呢)[。！!]*$/u;
const otherTask = /(?:另一个|另一份|另外一份|另外一件|换个话题|说件别的|顺便问)/u;
const directive = /(?:请你|请把|请发|你记得|记得把|麻烦你|别忘了|你务必)/u;
const attendanceRequest = /能来|可以来|能到|方便来|参加|到场|出席|能去|来不来|去不去|去吗|来吗/u;
const attendanceAnswer = /^(?:我|我们|这边)?(?:可以|行|能来|能到|没问题|可以来|可以去|参加|到场|会来|会去|会参加|会到场|来不了|去不了|到不了|不行|没空|不能参加|不能来|不能去|不参加)(?:的|啦|了|哈|哦)?$/u;
const artifacts = /报名表|登记表|签到表|选手名单|出场名单|名单|赛程|时间表|照片|发票|报价|合同|稿件|文档|表格|材料|资料|报告|文件|链接|地址|成绩单/gu;
const taskVerbs = [
  { request: /发|给|上传|转给|传给|分享/u, answer: /(?:已|已经|刚|会|可以)(?:经)?(?:发|上传|转发|分享)|发了|传了|发给[^，。？！!?]{1,15}了|发不了/u },
  { request: /交|提交|上交|递交/u, answer: /(?:已|已经|刚|会|可以)(?:经)?(?:交|提交|递交)|(?:交|提交)了|交不了/u },
  { request: /确认|查|核对/u, answer: /(?:已|已经|刚|会|可以)(?:经)?(?:确认|查|核对)|确认了|核对过|确认不了/u },
  { request: /改|更新|补/u, answer: /(?:已|已经|刚|会|可以)(?:经)?(?:改|更新|补)|改好了|已修改|改不了/u },
];

function printable(value: string): string {
  return value.replace(/[\p{C}\p{Z}]+/gu, ' ').trim();
}

function bounded(value: string, limit: number): string {
  return value.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '').trimEnd();
}

function explicitDeadline(value: string): string | undefined {
  const normalized = normalizeTime(value);
  const prefixed = new RegExp(`(?:截止(?:时间)?(?:为|到|于|是|:)?|最晚(?:在)?|最后期限(?:为|是|:)?)${time}`, 'u').exec(normalized)?.[0];
  const before = new RegExp(`${time}(?:之前|以前|前)(?=(?:请|能|可以|务必|把|要|记得)*(?:回|回复|答复|确认|提交|上交|交|发|给|报名|完成|办好))`, 'u').exec(normalized)?.[0];
  const result = prefixed ?? before;
  return result === undefined ? undefined : bounded(result, 60);
}

function normalizeTime(value: string): string {
  return value.normalize('NFKC').replace(/星期|礼拜/gu, '周').replace(/周天/gu, '周日').replace(/\s+/gu, '');
}

function withoutMention(value: string): string {
  return value.replace(/^(?:\s*[@＠][^\s\u2005]{1,64}[\s\u2005]+)+/u, '').trim();
}

function compact(value: string): string {
  return normalizeTime(value).replace(/[\p{P}\p{Z}]+/gu, '');
}

function repeats(value: string): string {
  return compact(withoutMention(value).replace(defer, '')).replace(/能不能|可不可以|可以(?=来|到|去)/gu, '能');
}

function sharedTime(request: string, reply: string): string | undefined {
  const requested = request.match(new RegExp(time, 'gu')) ?? [];
  const provided = reply.match(new RegExp(time, 'gu')) ?? [];
  if (requested.length !== 1 || provided.length !== 1) return undefined;
  const [left] = requested;
  const [right] = provided;
  return left === undefined || right === undefined || !(left.startsWith(right) || right.startsWith(left)) ? undefined : right;
}

function clearUnquotedReply(request: string, reply: string): boolean {
  if (activeQuestion.test(reply) || otherTask.test(reply) || directive.test(reply)) return false;
  const asked = normalizeTime(withoutMention(request));
  const said = normalizeTime(reply);
  const date = sharedTime(asked, said);
  if (date !== undefined && attendanceRequest.test(asked) && attendanceAnswer.test(compact(said.replace(date, '')))) return true;
  const subjects = asked.match(artifacts) ?? [];
  const answeredSubjects = said.match(artifacts) ?? [];
  if (subjects.length !== 1 || answeredSubjects.length !== 1 || subjects[0] !== answeredSubjects[0]) return false;
  // When both sides say a time, an unrelated appointment cannot resolve this request.
  const hasTime = new RegExp(time, 'u');
  if (date === undefined && hasTime.test(asked) && hasTime.test(said)) return false;
  return taskVerbs.some(verb => verb.request.test(asked) && verb.answer.test(said));
}

/** Pair only owner-authored answers with evidenced @s in this one group. */
export function classifyWeChatFollowup(rows: readonly WeChatFollowupEvidenceRow[]): WeChatFollowupClassification[] {
  const ordered = [...rows].sort((left, right) => left.at - right.at);
  const questions: Array<{ request: string; view: WeChatFollowupClassification }> = [];
  const byId = new Map<string, WeChatFollowupClassification>();
  const byRequest = new Map<string, WeChatFollowupClassification>();
  for (const row of ordered) {
    if (row.role === 'owner') {
      if (row.quoteId !== undefined) {
        const quoted = byId.get(row.quoteId);
        if (quoted && row.at >= quoted.at) quoted.answered = true;
        continue;
      }
      const matches = questions.filter(({ request, view }) => !view.answered && row.at > view.at && clearUnquotedReply(request, row.text));
      if (matches.length === 1) matches[0]!.view.answered = true;
      continue;
    }
    if (byId.has(row.id)) continue;
    const content = printable(row.text);
    const subject = withoutMention(content) || content;
    const requestKey = repeats(content);
    const key = requestKey.length >= 4 ? `${row.author}\0${requestKey}` : '';
    const earlier = key ? byRequest.get(key) : undefined;
    if (earlier && !earlier.answered) {
      earlier.aliases.push(row.id);
      byId.set(row.id, earlier);
      continue;
    }
    const dueText = explicitDeadline(subject);
    const view: WeChatFollowupClassification = { id: row.id, at: row.at, detail: bounded(content, 240), summary: bounded(subject, 96),
      answered: false, aliases: [row.id], ...(dueText === undefined ? {} : { dueText }) };
    questions.push({ request: content, view });
    byId.set(row.id, view);
    if (key) byRequest.set(key, view);
  }
  // Separate shards can place a reply before its quoted question in the same second.
  for (const row of ordered) if (row.role === 'owner' && row.quoteId !== undefined) {
    const question = byId.get(row.quoteId);
    if (question && row.at >= question.at) question.answered = true;
  }
  return questions.map(({ view }) => view);
}
