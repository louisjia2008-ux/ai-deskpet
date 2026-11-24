import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TelegramChannelAPI, TelegramChannelStatus } from '../../shared/telegram-channel';
import type { QqChannelStatus } from '../../shared/qq-channel';
import type { ChatSession } from '../../shared';
import type { ChatCronSchedule } from '../../shared/chat-cron';
import type { ChatWorkPanelApi } from '../../shared/chat-work-api';
import { describeCron, ScheduleOverview } from './ScheduleOverview';

afterEach(cleanup);
const schedule = { id: 'c1', title: '上海每日早安与穿衣建议', expression: '0 7 * * *', timezone: 'Asia/Shanghai', enabled: true, nextRunAt: '2026-11-04T23:00:00.000Z', instruction: '查天气', allowedCapabilities: ['web.search'], revision: 3, cancelledAt: null } as unknown as ChatCronSchedule;
const setup = (cron: Record<string, ChatCronSchedule[]>, telegram?: Pick<TelegramChannelAPI, 'setCronDelivery' | 'getState'>) => {
  const api = { listCron: vi.fn(async (id: string) => cron[id] ?? []), pauseCron: vi.fn(async () => undefined), resumeCron: vi.fn(async () => undefined), cancelCron: vi.fn(async () => undefined), onChanged: () => () => undefined } as unknown as ChatWorkPanelApi;
  const sessions = [{ id: 's1', title: '早安' }, { id: 's2', title: '别的对话' }, { id: 's3', title: '已删除', deletedAt: '2026-11-01T00:00:00.000Z' }] as unknown as ChatSession[];
  const open = vi.fn();
  render(<ScheduleOverview api={api} {...(telegram ? { telegram } : {})} sessions={sessions} locale="zh-CN" onOpenSession={open}><p>TEXT_SCHEDULES</p></ScheduleOverview>);
  return { api, open };
};

it('lists schedules made in any conversation, which the old page never showed', async () => {
  const f = setup({ s1: [schedule], s2: [{ ...schedule, id: 'c2', title: '已取消', cancelledAt: '2026-11-02T00:00:00.000Z' } as ChatCronSchedule] });
  expect(await screen.findByRole('heading', { name: '上海每日早安与穿衣建议' })).toBeTruthy();
  // The time zone is named only when it differs from this computer's.
  expect(screen.getByText(/^每天 07:00( · Asia\/Shanghai)?$/u)).toBeTruthy();
  expect(screen.queryByText('已取消')).toBeNull();
  expect(f.api.listCron).not.toHaveBeenCalledWith('s3');
  fireEvent.click(screen.getByRole('button', { name: '打开对话' }));
  expect(f.open).toHaveBeenCalledWith('s1');
});

it('pauses, and asks before cancelling', async () => {
  const f = setup({ s1: [schedule] });
  fireEvent.click(await screen.findByRole('button', { name: '暂停' }));
  await waitFor(() => expect(f.api.pauseCron).toHaveBeenCalledWith({ sessionId: 's1', id: 'c1' }));
  await screen.findByRole('button', { name: '取消任务' });
  fireEvent.click(screen.getByRole('button', { name: '取消任务' }));
  expect(f.api.cancelCron).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认取消' }));
  await waitFor(() => expect(f.api.cancelCron).toHaveBeenCalledWith({ sessionId: 's1', id: 'c1' }));
});

it('explains how to make one when there are none', async () => {
  setup({});
  expect(await screen.findByText(/在聊天里说一句就行/u)).toBeTruthy();
});

it('describes common cron shapes and leaves the rest as written', () => {
  expect(describeCron('0 7 * * *', 'zh-CN')).toBe('每天 07:00');
  expect(describeCron('30 21 * * 1', 'zh-CN')).toBe('每周一 21:30');
  expect(describeCron('5 * * * *', 'en')).toBe('Every hour at :05');
  expect(describeCron('*/15 * * * *', 'zh-CN')).toBe('*/15 * * * *');
  expect(describeCron('0 7 1 * *', 'zh-CN')).toBe('0 7 1 * *');
});

it('ties delivery to the displayed account and schedule revision, including after re-pairing', async () => {
  const bindingId = 'new-binding';
  const telegram = {
    getState: vi.fn(async () => ({ enabled: true, bound: true, bindingId, bindingDisplayName: 'Phone owner' }) as TelegramChannelStatus),
    setCronDelivery: vi.fn(async () => undefined),
  };
  setup({ s1: [{ ...schedule, telegramDelivery: { bindingId: 'old-binding', revision: schedule.revision, grantedAt: '2026-11-03T23:00:00Z' } }] }, telegram);
  const toggle = await screen.findByRole('checkbox', { name: /Telegram.*Phone owner/u });
  expect(toggle).not.toBeChecked(); expect(telegram.setCronDelivery).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  await waitFor(() => expect(telegram.setCronDelivery).toHaveBeenCalledExactlyOnceWith({
    scheduleId: schedule.id, expectedRevision: schedule.revision, expectedBindingId: bindingId, enabled: true,
  }));
});

it('offers the bound QQ private chat as a destination and shows a stale grant as off', async () => {
  const qq = {
    getState: vi.fn(async () => ({ enabled: true, stopped: false, privateBindingId: 'qq-binding', bindingDisplayName: '我' }) as QqChannelStatus),
    setCronDelivery: vi.fn(async () => undefined),
  };
  const api = { listCron: vi.fn(async (id: string) => id === 's1' ? [{ ...schedule, qqDelivery: { bindingId: 'qq-binding', revision: schedule.revision - 1, grantedAt: '2026-11-03T23:00:00Z' } }] : []), onChanged: () => () => undefined } as unknown as ChatWorkPanelApi;
  render(<ScheduleOverview api={api} qq={qq} sessions={[{ id: 's1', title: '早安' }] as unknown as ChatSession[]} locale="zh-CN" onOpenSession={vi.fn()}><p /></ScheduleOverview>);
  const toggle = await screen.findByRole('checkbox', { name: /QQ 私聊.*我/u });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() => expect(qq.setCronDelivery).toHaveBeenCalledExactlyOnceWith({
    scheduleId: schedule.id, expectedRevision: schedule.revision, expectedBindingId: 'qq-binding', enabled: true,
  }));
});
