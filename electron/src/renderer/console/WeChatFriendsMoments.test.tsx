import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultWeChatFriendsMomentsSettings, wechatFriendsMomentsSettingsSchema } from '../../shared/wechat-digests';
import type { WeChatDigestsAPI, WeChatFriendsMomentsState } from '../../shared/wechat-digests';
import { WeChatFriendsMomentsSettingsPanel } from './WeChatFriendsMoments';

const defaults = defaultWeChatFriendsMomentsSettings();
const provider = { id: '00000000-0000-4000-8000-000000000001', name: 'Fixture service', model: 'fixture-model' };

const fixture = (patch: Partial<WeChatFriendsMomentsState> = {}) => ({
  getFriendsMomentsSettings: vi.fn<WeChatDigestsAPI['getFriendsMomentsSettings']>(async () => ({
    settings: defaults, providers: [provider], available: true, ...patch,
  })),
  setFriendsMomentsSettings: vi.fn<WeChatDigestsAPI['setFriendsMomentsSettings']>(async () => undefined),
});

afterEach(cleanup);

it('defaults off with daily 20:00 delivery and a separate default-on cloud preference', () => {
  expect(wechatFriendsMomentsSettingsSchema.parse({})).toEqual({
    enabled: false, cloud: true, time: '20:00', cadence: 'daily', weekday: 0, provider: null,
  });
  expect(wechatFriendsMomentsSettingsSchema.safeParse({ weekday: 7 }).success).toBe(false);
  expect(wechatFriendsMomentsSettingsSchema.safeParse({ time: '24:00' }).success).toBe(false);
  expect(wechatFriendsMomentsSettingsSchema.safeParse({ cadence: 'hourly' }).success).toBe(false);
  expect(wechatFriendsMomentsSettingsSchema.safeParse({ refreshFeed: true }).success).toBe(false);
});

it('shows the scope on first use and saves a weekly schedule using the local model', async () => {
  const api = fixture();
  render(<WeChatFriendsMomentsSettingsPanel api={api} locale="zh-CN" />);
  const enabled = await screen.findByRole('checkbox', { name: '发送好友朋友圈摘要' });
  const cloud = screen.getByRole('checkbox', { name: '允许将好友朋友圈内容发给云端模型' });
  expect(enabled).not.toBeChecked();
  expect(cloud).toBeChecked();
  expect(cloud).toHaveAccessibleDescription(/云端模型可收到动态文字.*在本机加上作者显示名和图片数量/u);
  expect(screen.getByText(/独立的微信号，只读取该账号自己好友已经同步到本机缓存/u)).toBeVisible();
  expect(screen.getByLabelText('发送时间（本机时间）')).toHaveValue('20:00');
  expect(screen.queryByRole('combobox', { name: '星期' })).toBeNull();

  fireEvent.click(enabled);
  fireEvent.click(cloud);
  fireEvent.change(screen.getByRole('combobox', { name: '发送频率' }), { target: { value: 'weekly' } });
  expect(screen.getByRole('combobox', { name: '星期' })).toHaveValue('0');
  fireEvent.change(screen.getByRole('combobox', { name: '星期' }), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('发送时间（本机时间）'), { target: { value: '19:15' } });
  fireEvent.click(screen.getByRole('button', { name: '保存好友朋友圈摘要设置' }));

  await waitFor(() => expect(api.setFriendsMomentsSettings).toHaveBeenCalledExactlyOnceWith({
    enabled: true, cloud: false, cadence: 'weekly', weekday: 3, time: '19:15', provider: null,
  }));
  expect(await screen.findByText('好友朋友圈摘要设置已保存。')).toHaveAttribute('role', 'status');
});

it('uses an explicit cloud provider only when the owner selects it', async () => {
  const api = fixture();
  render(<WeChatFriendsMomentsSettingsPanel api={api} locale="en" />);
  const route = await screen.findByRole('combobox', { name: 'Cloud service for the digest' });
  expect(route).toHaveValue('');
  fireEvent.change(route, { target: { value: `${provider.id}\n${provider.model}` } });
  fireEvent.click(screen.getByRole('button', { name: 'Save friends’ Moments digest settings' }));
  await waitFor(() => expect(api.setFriendsMomentsSettings).toHaveBeenCalledExactlyOnceWith({
    ...defaults, provider: { providerId: provider.id, model: provider.model },
  }));
});

it('can turn off both permissions when the cache is unavailable', async () => {
  const api = fixture({ available: false, providers: [], settings: { ...defaults, enabled: true, cloud: true } });
  render(<WeChatFriendsMomentsSettingsPanel api={api} locale="zh-CN" />);
  expect(await screen.findByText('暂时无法读取该账号的朋友圈缓存，仍可关闭摘要或撤回云端权限。')).toBeVisible();
  fireEvent.click(screen.getByRole('checkbox', { name: '允许将好友朋友圈内容发给云端模型' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '发送好友朋友圈摘要' }));
  fireEvent.click(screen.getByRole('button', { name: '保存好友朋友圈摘要设置' }));
  await waitFor(() => expect(api.setFriendsMomentsSettings).toHaveBeenCalledExactlyOnceWith({ ...defaults, cloud: false }));
});
