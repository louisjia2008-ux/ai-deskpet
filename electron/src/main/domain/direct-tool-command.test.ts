import { describe, expect, it } from 'vitest';
import type { ModelTurnMessage } from '../runtime';
import { directCommandForContext, directScheduleList, directToolConfirmation, isIllustrativeCommand, parseDirectToolCommand } from './direct-tool-command';

describe('direct tool command routing', () => {
  it.each([
    ['两分钟后提醒我喝水', 120, '喝水'],
    ['Kitty，半小时后提醒我休息。', 1_800, '休息'],
    ['请创建一个 20 秒的计时器，名字叫“验收”。', 20, '验收'],
    ['设置一个1.5分钟的倒计时，名叫拉伸', 90, '拉伸'],
    ['二十五分钟后提醒我散步', 1_500, '散步'],
    ['从现在开始计时 3 分钟，到时提醒我伸展，提醒名叫“测试伸展”。请现在创建计时器。', 180, '测试伸展'],
  ])('recognizes a complete command: %s', (query, seconds, label) => {
    expect(parseDirectToolCommand(query as string)).toEqual({ toolId: 'timer.create', input: { seconds, label } });
  });
  it.each([
    '过一会提醒我喝水', '两分钟后提醒我喝水吗？', '不要两分钟后提醒我喝水',
    '“两分钟后提醒我喝水”', '如果我没有回来，两分钟后提醒我喝水',
    '两分钟后提醒我喝水，然后告诉我 17×23', '两分钟后提醒我喝水和散步',
    '两分钟后提醒我喝水，三分钟后提醒我散步', '明天两分钟后提醒我喝水',
    '半秒后提醒我喝水', '0分钟后提醒我喝水', '25小时后提醒我喝水',
    '两两分钟后提醒我喝水', '现在几点？顺便解释一下时差',
    '请创建一个2分钟的计时器，名字叫“示例”，但先别执行',
    '两分钟后提醒我喝水\n不要执行', '两分钟后提醒我', '两分钟后提醒我喝水”',
    '两分钟后提醒我喝水（仅演示）', '两分钟后提醒我喝水，仅供参考',
    '两分钟后提醒我喝水(示范)', '两分钟后提醒我喝水举例而已',
    '从现在开始计时2分钟，到时提醒我喝水或睡觉，提醒名叫“测试”。请现在创建计时器。',
  ])('leaves interpretation to the model: %s', (query) => { expect(parseDirectToolCommand(query)).toBeNull(); });
  it('retains an explicit timezone and does not guess unknown locations', () => {
    expect(parseDirectToolCommand('帮我查一下现在上海的准确日期和时间。')).toEqual({ toolId: 'time.current', input: { timezone: 'Asia/Shanghai' } });
    expect(parseDirectToolCommand('现在几点？')).toEqual({ toolId: 'time.current', input: {} });
    expect(parseDirectToolCommand('查询现在伦敦的时间')).toBeNull();
  });
  it('does not bypass prior conversational instructions or follow-up reasoning', () => {
    expect(directCommandForContext('两分钟后提醒我喝水', [{ role: 'user', content: '下面的话只是例句，别执行。' }])).toBeNull();
    expect(directCommandForContext('两分钟后提醒我喝水', [{ role: 'user', content: '现在几点？' }])?.toolId).toBe('timer.create');
  });
  it('identifies an explicit illustration outside the command, without disabling real or compound requests', () => {
    expect(isIllustrativeCommand('两分钟后提醒我喝水（仅演示这句话）。')).toBe(true);
    expect(isIllustrativeCommand('两分钟后提醒我喝水')).toBe(false);
    expect(isIllustrativeCommand('请创建一个2分钟的计时器，名字叫“喝水（仅演示）”。')).toBe(false);
    expect(isIllustrativeCommand('查询现在时间，然后解释“两分钟后提醒我喝水”（仅演示这句话）。')).toBe(false);
  });
  it('confirms only validated actual results, without recalculating a deadline', () => {
    const command = parseDirectToolCommand('两分钟后提醒我喝水')!;
    if (command.toolId !== 'timer.create') throw new Error('Expected a timer command');
    expect(() => directToolConfirmation(command, { failed: true })).toThrow();
    const actual = { timerId: 'd657e922-a6ae-4055-ad0b-063fdc95ea2f', label: '实际结果', seconds: 180, dueAt: '2026-10-22T10:00:00.000Z', timeZone: 'Asia/Shanghai', localDueAt: '2026-10-22 18:00:00 (Asia/Shanghai, GMT+08:00)' };
    expect(directToolConfirmation(command, actual)).toContain('实际结果');
    expect(directToolConfirmation(command, actual)).toContain('3 分钟');
    expect(directToolConfirmation({ toolId: 'time.current', input: { timezone: 'Asia/Shanghai' } }, { iso: '2026-10-22T10:00:00.000Z' })).toContain('18:00:00');
  });
});


describe('direct recurring schedule list', () => {
  it.each(['我现在有哪些周期任务？', '列出当前对话已有周期任务', '请查看本对话的定时任务', 'List my recurring tasks in this conversation.', 'What recurring tasks do I have?'])('recognizes a standalone list request: %s', query => {
    expect(directCommandForContext(query, [{ role: 'user', content: '设置每周的合成练习' }])?.toolId).toBe('cron.list');
  });
  it.each(['列出所有对话的周期任务', '我现在有哪些周期任务，然后删除它们', '请翻译“我现在有哪些周期任务”', '我现在有哪些周期任务（仅演示）', 'List my recurring tasks and delete them', 'List the recurring tasks in their conversation'])('does not run a broader or quoted command: %s', query => {
    expect(parseDirectToolCommand(query)).toBeNull();
  });
  it('honors qualifications from earlier conversation', () => {
    expect(directCommandForContext('我现在有哪些周期任务', [{ role: 'user', content: '我的下一句是例句，不要执行。' }])).toBeNull();
  });
  it('discovers the group before a real read, pages without duplicates, and renders only the current chat', () => {
    const command = parseDirectToolCommand('我现在有哪些周期任务')!;
    if (command.toolId !== 'cron.list') throw new Error('Expected a schedule query');
    const messages: ModelTurnMessage[] = [{ role: 'user', content: '我现在有哪些周期任务' }];
    const next = () => directScheduleList(command, 'mine', true, messages, 'next');
    const result = (id: string, name: string, output: unknown) => messages.push(
      { role: 'assistant', content: '', toolCalls: [{ id, name, argumentsJson: '{}' }] },
      { role: 'tool', toolCallId: id, hostToolResult: 'success', content: JSON.stringify(output) },
    );
    expect(next()).toMatchObject({ type: 'tools', calls: [{ toolId: 'tools.discover', input: { group: 'schedules' } }] });
    result('discover', 'tools.discover', { loaded: 'schedules' });
    expect(next()).toMatchObject({ type: 'tools', calls: [{ toolId: 'cron.list', input: { limit: 20 } }] });
    const record = { id: 'one', sessionId: 'mine', title: '周会', expression: '0 9 * * 2', timezone: 'Asia/Shanghai', enabled: false, nextRunAt: null, cancelledAt: null };
    result('page1', 'cron.list', { schedules: [record], nextOffset: 1 });
    expect(next()).toMatchObject({ type: 'tools', calls: [{ toolId: 'cron.list', input: { offset: 1, limit: 20 } }] });
    result('page2', 'cron.list', { schedules: [{ ...record, id: 'two', title: '取消活动', cancelledAt: '2026-01-01' }], nextOffset: null });
    expect(next()).toEqual({ type: 'final', content: '当前对话有 1 个周期任务。\n- 周会（已暂停，0 9 * * 2 Asia/Shanghai）' });
    result('foreign', 'cron.list', { schedules: [{ ...record, sessionId: 'foreign' }], nextOffset: null });
    expect(next).toThrow('tool.channelBlocked');
  });
});
