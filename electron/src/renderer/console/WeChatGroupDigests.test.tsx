import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultWeChatDigestGroupSettings, wechatDigestGroupSettingsSchema } from '../../shared/wechat-digests';
import type { WeChatDigestGroupState, WeChatDigestsAPI } from '../../shared/wechat-digests';
import { WeChatGroupDigestResults, WeChatGroupDigestSettings } from './WeChatGroupDigests';

const first = { id: 'a'.repeat(64), title: '合成群一' };
const second = { id: 'b'.repeat(64), title: '合成群二', replying: true as const };
const provider = { id: '00000000-0000-4000-8000-000000000001', name: 'Fixture service', model: 'fixture-model' };

const fixture = (patch: Partial<WeChatDigestGroupState> = {}) => ({
  getGroupSettings: vi.fn<WeChatDigestsAPI['getGroupSettings']>(async () => ({
    settings: defaultWeChatDigestGroupSettings(), groups: [first, second], providers: [provider], available: true, ...patch,
  })),
  setGroupSettings: vi.fn<WeChatDigestsAPI['setGroupSettings']>(async () => undefined),
});

afterEach(cleanup);

it('bounds the schedule and group selection while enabling cloud processing for new selected groups', () => {
  const state = defaultWeChatDigestGroupSettings();
  expect(state).toEqual({ time: '21:30', groups: [], provider: null, keywords: [] });
  expect(wechatDigestGroupSettingsSchema.parse({ ...state, groups: [{ id: first.id }] }).groups).toEqual([{ id: first.id, cloud: true }]);
  expect(wechatDigestGroupSettingsSchema.safeParse({ ...state, time: '24:00' }).success).toBe(false);
  expect(wechatDigestGroupSettingsSchema.safeParse({ ...state, groups: [{ id: first.id }, { id: first.id }] }).success).toBe(false);
  expect(wechatDigestGroupSettingsSchema.safeParse({ ...state, keywords: Array(17).fill('fixture') }).success).toBe(false);
});

it('sets cloud access independently for selected groups, marks reply groups and keeps the provider and schedule', async () => {
  const api = fixture();
  render(<WeChatGroupDigestSettings api={api} locale="zh-CN" />);
  const pickFirst = await screen.findByRole('checkbox', { name: first.title });
  const pickSecond = screen.getByRole('checkbox', { name: second.title + '（她会回复的群）' });
  expect(pickFirst).not.toBeChecked();
  expect(screen.getByText(/她本来会回复的群照常按群规则回复/u)).toBeVisible();
  expect(screen.getByLabelText('每天发送时间（本机时间）')).toHaveValue('21:30');
  expect(screen.getByRole('combobox', { name: '精华使用的云端服务' })).toHaveValue('');
  fireEvent.click(pickFirst);
  fireEvent.click(pickSecond);
  const firstCloud = screen.getByRole('checkbox', { name: '允许发送给云端模型 · 合成群一' });
  const secondCloud = screen.getByRole('checkbox', { name: '允许发送给云端模型 · 合成群二' });
  expect(firstCloud).toBeChecked();
  expect(secondCloud).toBeChecked();
  fireEvent.click(firstCloud);
  expect(firstCloud).not.toBeChecked();
  expect(secondCloud).toBeChecked();
  fireEvent.change(screen.getByLabelText('每天发送时间（本机时间）'), { target: { value: '18:05' } });
  fireEvent.change(screen.getByRole('combobox', { name: '精华使用的云端服务' }), { target: { value: `${provider.id}\n${provider.model}` } });
  fireEvent.change(screen.getByRole('textbox', { name: '关注关键词（每行一个）' }), { target: { value: '  合成关键词\n\n第二个词\n 合成关键词 ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存群聊精华设置' }));
  await waitFor(() => expect(api.setGroupSettings).toHaveBeenCalledExactlyOnceWith({
    time: '18:05', groups: [{ id: first.id, cloud: false }, { id: second.id, cloud: true }],
    provider: { providerId: provider.id, model: provider.model }, keywords: ['合成关键词', '第二个词'],
  }));
  expect(await screen.findByText('群聊精华设置已保存。')).toHaveAttribute('role', 'status');
});

it('explains an unavailable reader and lets the owner retry without changing any setting', async () => {
  const api = fixture({ available: false });
  render(<WeChatGroupDigestSettings api={api} locale="zh-CN" />);
  expect(await screen.findByText('暂时读不到微信里的群列表，请刷新后重试。')).toBeVisible();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await waitFor(() => expect(api.getGroupSettings).toHaveBeenCalledTimes(2));
  expect(api.setGroupSettings).not.toHaveBeenCalled();
});

it('shows generated summaries and details even when private delivery is uncertain', async () => {
  const api = { groupResults: vi.fn<WeChatDigestsAPI['groupResults']>(async () => [{
    at: Date.UTC(2026, 0, 1), delivery: 'uncertain',
    entries: [{ title: '合成群一', summary: '合成摘要', detail: '合成细节' }],
  }]) };
  render(<WeChatGroupDigestResults api={api} locale="zh-CN" />);
  expect(await screen.findByText('合成摘要')).toBeVisible();
  expect(screen.getByText('未能确认是否送达')).toBeVisible();
  expect(screen.getByText('合成细节').closest('details')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('查看详细版'));
  expect(screen.getByText('合成细节').closest('details')).toHaveAttribute('open');
});
