import { createHash } from 'node:crypto';
import { privateCronText } from '../../domain/chat-cron-run';

/** The listener keeps each reply in its history, which it caps at 500 characters. */
export const WECHAT_ASSISTANT_REPLY_LIMIT = 480;
/** A group reply stays short; the prompt asks for 120. */
export const WECHAT_GROUP_REPLY_LIMIT = 160;
const suffix = { 'zh-CN': '…（完整回复在桌宠里）', en: '… (full reply in DeskPet)' } as const;

/** One WeChat bubble: no Markdown, no line breaks (the listener pastes and
 * verifies a single line), only characters the listener accepts as printable. */
export function wechatAssistantText(content: string, locale: 'en' | 'zh-CN', limit = WECHAT_ASSISTANT_REPLY_LIMIT): string {
  const lines = content
    .replace(/```[^\n]*\n?/gu, '')
    .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]{1,500})\)/gu, '$1 $2')
    .split(/\r?\n/u)
    .map(line => line
      .replace(/^\s{0,3}#{1,6}\s+/u, '')
      .replace(/^\s*[-*+]\s+/u, '· ')
      .replace(/\*\*([^*]+)\*\*|__([^_]+)__/gu, '$1$2')
      .replace(/`([^`]+)`/gu, '$1')
      .trim())
    .filter(Boolean);
  const text = lines.join(' ')
    .replace(/[\p{Zs}]/gu, ' ')
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '')
    .replace(/ {2,}/gu, ' ')
    .trim();
  const chars = [...text];
  if (chars.length <= limit) return text;
  const tail = suffix[locale];
  const room = chars.slice(0, limit - [...tail].length).join('');
  const sentence = Math.max(...['。', '！', '？', '. ', '! ', '? ', '；'].map(mark => room.lastIndexOf(mark)));
  return (sentence >= room.length / 2 ? room.slice(0, sentence + 1).trim() : room.trimEnd()) + tail;
}

export const wechatScheduledReplyText = (content: string, locale: 'en' | 'zh-CN'): string =>
  wechatAssistantText(privateCronText(content), locale);

export const wechatAssistantDeliveryId = (runId: string): string =>
  createHash('sha256').update(`deskpet/wechat/assistant-cron/v1\0${runId}`).digest('hex');
