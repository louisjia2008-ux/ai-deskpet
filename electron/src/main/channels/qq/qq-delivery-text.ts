import { createHash } from 'node:crypto';
import { QQ_MAX_MESSAGE_CHARACTERS } from '../../../shared/qq-channel';
import { stickerReply } from '../../../shared/qq-sticker-reply';
import { privateCronText } from '../../domain/chat-cron-run';

// Keep the original assistant turn in desktop history. Bind an oversized
// mobile preview to the entire source, including the omitted suffix.
export function qqDeliveryText(original: string, privateCron = false): { content: string; sourceSHA256?: string } {
  const visible = privateCron ? privateCronText(original) : stickerReply(original).text;
  if (visible.length <= QQ_MAX_MESSAGE_CHARACTERS) return visible === original ? { content: original }
    : { content: visible, sourceSHA256: createHash('sha256').update(original).digest('hex') };
  const suffix = '\n\n（这条回复较长，剩余内容可在桌面会话查看。）';
  let end = QQ_MAX_MESSAGE_CHARACTERS - suffix.length;
  if (/[\uD800-\uDBFF]/u.test(visible[end - 1]!)) end--;
  return { content: visible.slice(0, end) + suffix, sourceSHA256: createHash('sha256').update(original).digest('hex') };
}
