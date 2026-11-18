import { expect, it } from 'vitest';
import { explicitNoteSaveRequest } from './note-save-intent';

it('accepts a current owner imperative with optional note material', () => {
  for (const text of [
    '存一下', '请帮我记到笔记里。', '请存一下：一段合成内容', '新建一篇笔记\n标题：测试', 'Please save this to my notes.',
    '记一下明天交IB作业', '帮我把刚才的调研存到笔记里', '把上面的内容整理一下存到笔记', '帮我新建一篇笔记，标题叫xx', '这个记下来',
    '把这个存起来', '请把“示例：活动安排”存进笔记库', '请在笔记库写一段活动摘要', '帮我记一下不要迟到',
    '记录一下：今天跑了5公里', '把今天聊的整理成笔记', '这个想法不错，帮我存到笔记',
  ]) {
    expect(explicitNoteSaveRequest(text), text).toBe(true);
  }
});

it('does not take quoted, negated, hypothetical or similarly worded text as save authorization', () => {
  for (const text of [
    '“存一下”', '存一下怎么翻译？', '不要存一下', '如果我说存一下', '请复述：存一下', 'Can you translate “save this to my notes”?',
    '《把活动保存到笔记里》', '“写在笔记里。”这是引用', "'存到笔记里。'", '只需复述“保存到笔记”', '> 帮我保存到笔记', '转发：记一下',
    '先别写进笔记', '我没让你把这个存到笔记里', '假如以后要存到笔记里', '要是需要就写进笔记', '是否要写进笔记', '要不要写进笔记',
    '我记得你说过不要存到笔记里', '我写了一段调研，别存到笔记里', '我写完了调研，请在笔记里别存起来', '帮我记得别存到笔记',
    '帮我存到笔记里吗', '把这个存起来么！', '新建一篇笔记？', '帮我看看笔记里有什么', '你好。帮我新建一篇笔记',
    '甲'.repeat(80) + '保存到笔记里',
  ]) {
    expect(explicitNoteSaveRequest(text), text).toBe(false);
  }
});
