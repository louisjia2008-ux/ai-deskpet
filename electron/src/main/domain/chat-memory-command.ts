import type { ChatMessage } from '../../shared';

export type ChatMemoryCommand = { kind: 'save'; text: string } | { kind: 'clarify'; reason: 'content' | 'length' | 'context' };
export const CHAT_MEMORY_MAX_CHARACTERS = 2_000;

// Only the current user's explicit request can authorize a save. Model output,
// retrieved pages and quoted examples never enter this path. Keep the requested
// text verbatim rather than asking a model to invent or broaden a personal fact.
export const parseChatMemoryCommand = (query: string, history: readonly ChatMessage[] = []): ChatMemoryCommand | null => {
  const input = query.trim().replace(/^(?:Kitty|桌宠|伙伴)\s*[，,:：]\s*/iu, '');
  const prefix = input.match(/^(?:请)?(?:(?:帮我|替我|为我|帮忙)\s*)?(?:记下来|记住|记下|保存到(?:长期)?记忆[里中]?|保存为(?:长期)?记忆)\s*[：:,，]?\s*([\s\S]*)$/u);
  const english = input.match(/^(?:please\s+)?remember\s+(?:that\s+)?([\s\S]+)$/iu);
  const suffix = input.match(/^([\s\S]+?)[，,。.!！\n]\s*(?:请)?(?:(?:帮我|替我)\s*)?(?:记下来|记住|记下)(?:这些信息|这些内容|这两件事|这件事|这一点|这些|它)?[。.!！]*$/u);
  const match = prefix ?? english ?? suffix;
  if (match === null) return null;
  // 「记住了」「记下啦，谢谢」 acknowledge; they are not a request to save 「了」. Only a particle right after the
  // verb counts: 「记住：了不起的盖茨比…」 saves its text.
  const particle = prefix ? input.match(/^(?:请)?(?:(?:帮我|替我|为我|帮忙)\s*)?(?:记下来|记住|记下)\s*(?:了|啦|喽|咯)(\s*[：:])?/u) : null;
  if (particle && !particle[1]) return null;
  if (/[?？]\s*$/u.test(input)) return null;
  // Meta requests and an explicitly non-executing annotation are not consent.
  if (/^(?:请)?(?:翻译|解释|分析|改写|润色|举例|演示|示范|假设|比如|例如|如果我(?:说|写)|他(?:说|写)|她(?:说|写))/u.test(input)
    || /[（(](?:仅|只|只是)(?:演示|示范|举例|示例|翻译)(?:这句话|一下)?[）)]/u.test(input)
    || /(?:不要|不用|不需要|别)(?:真的|实际|再)?(?:保存|记住|记下|写入)|(?:仅|只是)(?:引用|示例|演示|举例)/u.test(input)) return null;
  const previous = history.filter((item) => item.role === 'user' && item.status === 'complete').at(-1)?.content ?? '';
  if (/(?:下一(?:句|条|个)|接下来)/u.test(previous) && /(?:翻译|示例|演示|引用|不要执行)/u.test(previous)) return { kind: 'clarify', reason: 'context' };
  const text = (particle ? input.slice(particle[0].length) : match[1]!).trim().replace(/^(?:以下(?:信息|内容))[：:]\s*/u, '');
  if (text.length > CHAT_MEMORY_MAX_CHARACTERS) return { kind: 'clarify', reason: 'length' };
  if (!text || /^(?:[：:,，。.!！?？\s]*|(?:这|那)(?:些|个|件事|两件事|一点)|(?:刚才|上面|之前|前面)(?:的)?(?:话|内容|信息)?|了吗|了吗[?？]|me|this|it|what I said)[。.!！?？\s]*$/iu.test(text)
    || /^(?:住|下|下来)?(?:了吗|什么|怎么|如何)/u.test(text)
    || /[，,。；;]\s*(?:然后|顺便|同时|再|另外)(?:请|帮我|告诉我|查|搜索|打开|创建|设置|提醒|删除|修改)/u.test(text)) return { kind: 'clarify', reason: 'content' };
  return { kind: 'save', text };
};
