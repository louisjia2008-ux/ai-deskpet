import type { ChatMessage } from '../../shared';
import { CHAT_MEMORY_MAX_CHARACTERS } from './chat-memory-command';

export type ChatEditCommand = { kind: 'edit'; query: string; replacement: string } | { kind: 'clarify' };
const unquote = (text: string): string => text.trim().replace(/[。.!！]+$/u, '').trim().replace(/^[“「『"']([\s\S]*)[”」』"']$/u, '$1').trim();

// Only the current user's literal instruction is interpreted here; imported
// messages and model output never enter this command path.
export const parseChatEditCommand = (input: string, history: readonly ChatMessage[] = []): ChatEditCommand | null => {
  const text = input.trim().replace(/^(?:Kitty|桌宠|伙伴)\s*[，,:：]\s*/iu, '');
  const match = text.match(/^(?:请)?(?:(?:帮我|替我)\s*)?(?:把|将)\s*(?:长期记忆[里中]的|记忆[里中]的|(?:这条)?记忆[：:]?)?\s*([\s\S]+?)\s*(?:这条(?:长期)?记忆)?\s*(?:改成|改为|修改为|更新为)\s*([\s\S]*)$/u)
    ?? text.match(/^(?:please\s+)?(?:change|update)\s+(?:the\s+)?(?:memory\s+)?([\s\S]+?)\s+to\s+([\s\S]*)$/iu);
  if (!match || /[?？]\s*$/u.test(text)) return null;
  if (/(?:不要|不用|不需要|别)(?:真的|实际|再)?(?:修改|更改|保存|执行)|(?:仅|只是)(?:引用|示例|演示|举例|翻译)|\b(?:example|translate|do not|don't)\b/iu.test(text)) return null;
  const previous = history.filter((item) => item.role === 'user' && item.status === 'complete').at(-1)?.content ?? '';
  if (/(?:下一(?:句|条|个)|接下来)/u.test(previous) && /(?:翻译|示例|演示|引用|不要执行)/u.test(previous)) return { kind: 'clarify' };
  const query = unquote(match[1]!); const replacement = unquote(match[2]!);
  if (query.length < 2 || query.length > CHAT_MEMORY_MAX_CHARACTERS || !replacement || replacement.length > CHAT_MEMORY_MAX_CHARACTERS
    || /^(?:全部|所有|所有记忆|全部记忆|它|这个|那个|这些|那些|刚才的|everything|all(?: memories)?|it|this|that)$/iu.test(query)
    || /(?:然后|顺便|同时|另外|如果|假如|当我)/u.test(`${query} ${replacement}`)) return { kind: 'clarify' };
  return { kind: 'edit', query, replacement };
};
