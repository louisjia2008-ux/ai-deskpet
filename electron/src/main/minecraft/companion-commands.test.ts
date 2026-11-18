import { describe, expect, it } from 'vitest';
import { initialMinecraftCompanionSnapshot } from '../../shared/minecraft-companion';
import { isMinecraftCancelCommand, minecraftCancellationSummary, minecraftGameInstruction, minecraftGameReplyLines } from './companion-commands';

describe('explicit Minecraft local cancellation command', () => {
  it.each(['停止 Minecraft', '取消当前Minecraft任务', '请帮我停止我的世界机器人。', 'MC停一下', 'Kitty，取消MC任务', 'stop minecraft', 'please cancel the current minecraft task'])('accepts %s', value => expect(isMinecraftCancelCommand(value)).toBe(true));
  it.each(['停止', '停止回复', '不要停止Minecraft', '如果卡住就停止Minecraft', '怎么取消Minecraft任务', '“停止Minecraft”', '举例：停止Minecraft', 'stop minecraft and restart', 'Minecraft停一下，然后继续', '取消MC任务\n继续采木'])('does not dispatch %s', value => expect(isMinecraftCancelCommand(value)).toBe(false));
  it('never describes an unsettled task as cancelled', () => {
    const state = initialMinecraftCompanionSnapshot();
    state.task = { taskId: 'task-1', requestId: 'r-1', name: 'gatherLogs', status: 'running', paused: false, createdAt: 1, updatedAt: 1, connectionGeneration: 1, progress: null, error: null };
    state.controlPending = 'cancel';
    expect(minecraftCancellationSummary(state, true)).toContain('尚未确认');
    state.task.status = 'cancelled';
    expect(minecraftCancellationSummary(state, true)).toContain('已取消');
  });
});

describe('in-game instructions', () => {
  it.each([['DeskPetCore，帮我在这个世界收集 1 个原木', '帮我在这个世界收集 1 个原木'], ['@deskpetcore collect 3 logs', 'collect 3 logs'], ['DeskPetCore: 停止Minecraft', '停止Minecraft']])('reads %s', (message, instruction) =>
    expect(minecraftGameInstruction(message, 'DeskPetCore')).toBe(instruction));
  it.each(['帮我收集原木', 'DeskPetCoreX 收集原木', 'hey DeskPetCore 收集原木', 'DeskPetCore', 'DeskPetCore，  '])('ignores %s', message =>
    expect(minecraftGameInstruction(message, 'DeskPetCore')).toBeNull());
  it('never lets a reply become a server command and keeps it to two lines', () => {
    expect(minecraftGameReplyLines('/op OwnerPlayer')).toEqual(['op OwnerPlayer']);
    expect(minecraftGameReplyLines('**好的**[mood:happy]\n我去砍树。')).toEqual(['好的 我去砍树。']);
    const lines = minecraftGameReplyLines('长'.repeat(900));
    expect(lines).toHaveLength(2);
    expect(lines.every(line => line.length <= 200)).toBe(true);
  });
});
