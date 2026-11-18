import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultWeChatFollowupSettings, wechatFollowupActionSchema, wechatFollowupSettingsSchema } from '../../shared/wechat-followup';
import type { WeChatFollowupAPI, WeChatFollowupItem } from '../../shared/wechat-followup';
import { WeChatFollowupList, WeChatFollowupSettingsPanel } from './WeChatFollowup';

const first = { id: 'a'.repeat(64), title: '合成群一' };
const second = { id: 'b'.repeat(64), title: '合成群二' };
const provider = { id: '00000000-0000-4000-8000-000000000001', name: 'Fixture service', model: 'fixture-model' };

afterEach(cleanup);

it('bounds settings and actions and defaults each new group to local processing', () => {
  const settings = defaultWeChatFollowupSettings();
  expect(settings).toEqual({ time: '21:30', waitMinutes: 60, groups: [], provider: null });
  expect(wechatFollowupSettingsSchema.parse({ ...settings, groups: [{ id: first.id }] }).groups).toEqual([{ id: first.id, cloud: false }]);
  expect(wechatFollowupSettingsSchema.safeParse({ ...settings, waitMinutes: 4 }).success).toBe(false);
  expect(wechatFollowupSettingsSchema.safeParse({ ...settings, time: '24:00' }).success).toBe(false);
  expect(wechatFollowupSettingsSchema.safeParse({ ...settings, groups: [{ id: first.id }, { id: first.id }] }).success).toBe(false);
  expect(wechatFollowupActionSchema.safeParse({ id: first.id, action: 'done', minutes: 60 }).success).toBe(false);
  expect(wechatFollowupActionSchema.safeParse({ id: first.id, action: 'snooze', minutes: 60 }).success).toBe(true);
});

it('changes waiting and delivery times while requiring independent cloud consent per group', async () => {
  const api = {
    getSettings: vi.fn<WeChatFollowupAPI['getSettings']>(async () => ({
      settings: defaultWeChatFollowupSettings(), groups: [first, second], providers: [provider], available: true,
    })),
    configure: vi.fn<WeChatFollowupAPI['configure']>(async () => undefined),
  };
  render(<WeChatFollowupSettingsPanel api={api} locale="zh-CN" />);
  fireEvent.click(await screen.findByRole('checkbox', { name: first.title }));
  fireEvent.click(screen.getByRole('checkbox', { name: second.title }));
  const firstCloud = screen.getByRole('checkbox', { name: `允许发送给云端模型 · ${first.title}` });
  const secondCloud = screen.getByRole('checkbox', { name: `允许发送给云端模型 · ${second.title}` });
  expect(firstCloud).not.toBeChecked();
  expect(secondCloud).not.toBeChecked();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  fireEvent.click(firstCloud);
  expect(secondCloud).not.toBeChecked();
  fireEvent.change(screen.getByLabelText('每天发送时间（本机时间）'), { target: { value: '18:05' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: '等待回复（分钟）' }), { target: { value: '90' } });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: `${provider.id}\n${provider.model}` } });
  fireEvent.click(screen.getByRole('button', { name: '保存跟进设置' }));
  await waitFor(() => expect(api.configure).toHaveBeenCalledExactlyOnceWith({
    time: '18:05', waitMinutes: 90, groups: [{ id: first.id, cloud: true }, { id: second.id, cloud: false }],
    provider: { providerId: provider.id, model: provider.model },
  }));
  expect(screen.getByText('跟进设置已保存。')).toHaveAttribute('role', 'status');
});

it('displays explicit deadlines and lets the owner expand, snooze, and handle an item', async () => {
  let items: WeChatFollowupItem[] = [{ id: 'c'.repeat(64), groupTitle: first.title, at: Date.UTC(2026, 0, 1),
    summary: '合成待跟进事项', detail: '合成消息上下文', deadline: '周五 17:00', snoozedUntil: null }];
  const api = {
    list: vi.fn<WeChatFollowupAPI['list']>(async () => items),
    act: vi.fn<WeChatFollowupAPI['act']>(async action => {
      items = action.action === 'done' ? [] : items.map(item => ({ ...item, snoozedUntil: item.at + action.minutes * 60_000 }));
    }),
  };
  render(<WeChatFollowupList api={api} locale="zh-CN" />);
  expect(await screen.findByText('合成待跟进事项')).toBeVisible();
  expect(screen.getByText(/周五 17:00/u)).toBeVisible();
  expect(screen.getByText('合成消息上下文').closest('details')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('展开上下文'));
  expect(screen.getByText('合成消息上下文').closest('details')).toHaveAttribute('open');
  fireEvent.click(screen.getByRole('button', { name: '延后 1 小时' }));
  expect(await screen.findByText('延后提醒至')).toBeVisible();
  expect(api.act).toHaveBeenNthCalledWith(1, { id: items[0]!.id, action: 'snooze', minutes: 60 });
  fireEvent.click(screen.getByRole('button', { name: '标为已处理' }));
  expect(await screen.findByText('暂时没有等待你处理的群消息。')).toBeVisible();
  expect(api.act).toHaveBeenNthCalledWith(2, { id: 'c'.repeat(64), action: 'done' });
});
