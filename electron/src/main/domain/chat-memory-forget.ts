import type { ChatMessage, MemoryItem } from '../../shared';
import { CHAT_MEMORY_MAX_CHARACTERS } from './chat-memory-command';

// `explicit`: the user named memory or asked politely (请/帮我/…), so a miss is
// reported. A bare 「忘记X」 that matches nothing is ordinary chat instead.
export type ChatForgetCommand = { kind: 'forget'; query: string; explicit: boolean } | { kind: 'clarify' };
// 「忘记带伞了」 reports something the user forgot; it is not a request.
export const BARE_STATEMENT = /(?:了|啦|呢|呀|嘛|哈)[。.!！~～…]*$/u;
const POLITE = /^(?:请|帮我|替我|为我|帮忙)/u;

// Only an explicit current-user instruction can reach deletion. Matching stays
// literal: a model, retrieved page or inferred topic cannot choose a memory.
export const parseChatForgetCommand = (input: string, history: readonly ChatMessage[] = []): ChatForgetCommand | null => {
  const text = input.trim().replace(/^(?:Kitty|桌宠|伙伴)\s*[，,:：]\s*/iu, '');
  const prefix = text.match(/^(?:请)?(?:(?:帮我|替我|为我|帮忙)\s*)?(?:忘记|忘掉|遗忘|删除(?:掉)?(?:长期)?记忆(?:里|中)?(?:的)?)\s*[：:,，]?\s*([\s\S]*)$/u);
  const suffix = text.match(/^(?:请)?(?:(?:帮我|替我)\s*)?把\s*([\s\S]+?)\s*(?:从(?:长期)?记忆[里中])?(?:忘掉|忘记|删除|删掉)[。.!！]*$/u);
  const english = text.match(/^(?:please\s+)?forget\s+(?:that\s+)?([\s\S]+)$/iu);
  const match = prefix ?? suffix ?? english;
  if (!match || /[?？]\s*$/u.test(text)) return null;
  // A quoted target names a memory as plainly as 「请忘记X」.
  // Naming 记忆 in the command itself (「删除长期记忆：…」, 「把X从记忆里删掉」, 「…这条记忆」) counts whatever the target
  // says; 「关于X」 counts unless it ends like a report: 「忘记关于那段旅行的记忆了」.
  const target = match[1]!.trim(), framing = text.replace(match[1]!, '');
  const explicit = POLITE.test(text) || /^(?:please)\b/iu.test(text) || /^(?:关于\s*)?[“「『"']/u.test(target)
    || /记忆/u.test(framing) || /(?:这条|这段|的)(?:长期)?记忆[。.!！]*$/u.test(target)
    || (/^关于/u.test(target) && !BARE_STATEMENT.test(text));
  if (!explicit && BARE_STATEMENT.test(text)) return null;
  if (/(?:不要|不用|不需要|别)(?:真的|实际|再)?(?:删除|忘记|忘掉|执行)|(?:仅|只是)(?:引用|示例|演示|举例|翻译)|\b(?:example|translate|do not|don't)\b/iu.test(text)) return null;
  const previous = history.filter((item) => item.role === 'user' && item.status === 'complete').at(-1)?.content ?? '';
  if (/(?:下一(?:句|条|个)|接下来)/u.test(previous) && /(?:翻译|示例|演示|引用|不要执行)/u.test(previous)) return { kind: 'clarify' };
  let query = match[1]!.trim().replace(/^关于\s*/u, '').replace(/(?:这条|这段|的)(?:长期)?记忆[。.!！]*$/u, '').trim();
  query = query.replace(/[。.!！]+$/u, '').replace(/^[“「『"']([\s\S]*)[”」』"']$/u, '$1').trim();
  if (query.length < 2 || query.length > CHAT_MEMORY_MAX_CHARACTERS
    || /^(?:全部|所有|一切|所有的|全部的|所有长期记忆|全部长期记忆|所有记忆|全部记忆|记忆|它|这个|那个|这些|那些|刚才(?:的)?(?:话|内容)?|之前(?:的)?(?:话|内容)?|了吗|everything|all(?: memories)?|it|this|that|what I said)$/iu.test(query)
    || /(?:然后|顺便|同时|另外|如果|假如|当我)/u.test(query)) return { kind: 'clarify' };
  return { kind: 'forget', query, explicit };
};

const normalize = (text: string): string => text.trim().normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').replace(/[。.!！]+$/u, '');
export const matchingMemories = (memories: readonly MemoryItem[], query: string): MemoryItem[] => {
  const target = normalize(query);
  if (target.length < 2) return [];
  const exact = memories.filter((item) => normalize(item.text) === target);
  return exact.length > 0 ? exact : memories.filter((item) => normalize(item.text).includes(target));
};
