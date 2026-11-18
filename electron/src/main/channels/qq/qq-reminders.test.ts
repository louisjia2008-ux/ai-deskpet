import { expect, it } from 'vitest';
import { parseQqReminder } from './qq-reminders';

it('resolves the paired owner’s specified clock time on the desktop and refuses elapsed or hypothetical times', () => {
  const now = new Date(2026, 10, 4, 15, 30);
  expect(parseQqReminder('明早八点半提醒我出门', now)).toEqual({
    kind: 'create', due: new Date(2026, 10, 5, 8, 30).getTime(), label: '出门',
  });
  expect(parseQqReminder('今晚九点提醒我读书', now)).toEqual({
    kind: 'create', due: new Date(2026, 10, 4, 21).getTime(), label: '读书',
  });
  expect(parseQqReminder('明天 09:45 提醒我喝水', now)).toEqual({
    kind: 'create', due: new Date(2026, 10, 5, 9, 45).getTime(), label: '喝水',
  });
  expect(parseQqReminder('今天 09:45 提醒我喝水', now)).toEqual({ kind:'invalid-time' });
  expect(parseQqReminder('明天 29:00 提醒我喝水', now)).toEqual({ kind:'invalid-time' });
  expect(parseQqReminder('明天 09:45 提醒我喝水吗？', now)).toBeNull();
  expect(parseQqReminder('比如，十分钟后提醒我喝水', now)).toBeNull();
});
