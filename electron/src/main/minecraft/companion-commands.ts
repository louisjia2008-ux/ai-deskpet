import type { MinecraftCompanionSnapshot } from '../../shared/minecraft-companion';

/** Only an explicit, complete local-user stop command. General chat stop and
 * quoted, conditional or instructional text never target the game. */
export const isMinecraftCancelCommand = (text: string): boolean => {
  if (text.length > 100 || /[\r\n]/u.test(text)) return false;
  const value = text.trim().replace(/^Kitty\s*[，,]\s*/iu, '').replace(/[。.!！]$/u, '').trim();
  return /^(?:请)?(?:帮我)?(?:取消|停止|停下)(?:当前(?:的)?|正在进行的)?\s*(?:Minecraft|MC|我的世界)(?:的)?\s*(?:任务|工作|机器人)?(?:吧)?$/iu.test(value)
    || /^(?:Minecraft|MC|我的世界)(?:任务|机器人)?\s*(?:停一下|停止|停下)(?:吧)?$/iu.test(value)
    || /^(?:please\s+)?(?:stop|cancel)\s+(?:the\s+)?(?:current\s+)?(?:minecraft|mc)(?:\s+(?:task|bot))?$/iu.test(value);
};

export const minecraftCancellationSummary = (state: MinecraftCompanionSnapshot, chinese: boolean): string => {
  if (state.task?.status === 'cancelled') return chinese ? 'Minecraft 任务已取消。旧任务的动作已结束，机器人不会继续执行该任务。' : 'The Minecraft task is cancelled. Its previous actions have retired.';
  if (!state.task || ['completed', 'failed'].includes(state.task.status)) return chinese ? '当前没有正在执行的 Minecraft 任务需要取消。' : 'There is no active Minecraft task to cancel.';
  return chinese ? 'Minecraft 取消尚未确认。请查看聊天中的游戏状态；必要时在 Minecraft 页面断开连接。' : 'Minecraft cancellation is not yet confirmed. Check the game status or disconnect from the Minecraft page.';
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Game chat counts only when it starts by naming the bot ("DeskPetCore，…", "@DeskPetCore …"). Returns the instruction, or null. */
export const minecraftGameInstruction = (message: string, botName: string): string | null => {
  const match = new RegExp(`^@?${escapeRegExp(botName)}(?:[\\s,，:：、]+|$)`, 'iu').exec(message.trim());
  if (!match) return null;
  const instruction = message.trim().slice(match[0].length).trim();
  return instruction.length > 0 ? instruction : null;
};

/** A model reply as at most two plain game-chat lines. */
export const minecraftGameReplyLines = (reply: string): string[] => {
  const plain = reply
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/\[(?:mood:)?[a-z_-]{2,24}\]/giu, ' ')
    .replace(/[*_`#>]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^\/+/u, '');
  const lines: string[] = [];
  for (let rest = plain; rest && lines.length < 2; rest = rest.slice(200).trim()) lines.push(rest.slice(0, 200));
  if (plain.length > 400 && lines[1]) lines[1] = lines[1].slice(0, 197) + '…';
  return lines;
};
