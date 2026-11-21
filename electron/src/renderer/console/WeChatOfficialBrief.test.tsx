import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultWeChatOfficialBriefSettings, wechatOfficialBriefSettingsSchema } from '../../shared/wechat-digests';
import type { WeChatDigestsAPI, WeChatOfficialBriefState } from '../../shared/wechat-digests';
import { WeChatOfficialBriefSettingsPanel } from './WeChatOfficialBrief';

const first = { id: 'a'.repeat(64), title: '合成公众号一' };
const second = { id: 'b'.repeat(64), title: '合成公众号二' };
const provider = { id: '00000000-0000-4000-8000-000000000001', name: 'Fixture service', model: 'fixture-model' };
const defaults = defaultWeChatOfficialBriefSettings();

const fixture = (patch: Partial<WeChatOfficialBriefState> = {}) => ({
  getOfficialSettings: vi.fn<WeChatDigestsAPI['getOfficialSettings']>(async () => ({
    settings: defaults, accounts: [first, second], providers: [provider], available: true, ...patch,
  })),
  setOfficialSettings: vi.fn<WeChatDigestsAPI['setOfficialSettings']>(async () => undefined),
});

afterEach(cleanup);

it('defaults to a disabled 08:30 brief with five articles and no cloud model', () => {
  expect(wechatOfficialBriefSettingsSchema.parse({})).toEqual({
    enabled: false, time: '08:30', limit: 5, accountIds: null, keywords: [], cloud: false, provider: null,
  });
  expect(wechatOfficialBriefSettingsSchema.safeParse({ limit: 13 }).success).toBe(false);
  expect(wechatOfficialBriefSettingsSchema.safeParse({ enabled: true, accountIds: [] }).success).toBe(false);
  expect(wechatOfficialBriefSettingsSchema.safeParse({ accountIds: [first.id, first.id] }).success).toBe(false);
  expect(wechatOfficialBriefSettingsSchema.safeParse({ cloud: 'false' }).success).toBe(false);
});

it('saves selected accounts and interests without enabling cloud implicitly', async () => {
  const api = fixture();
  render(<WeChatOfficialBriefSettingsPanel api={api} locale="zh-CN" />);
  const enabled = await screen.findByRole('checkbox', { name: '每天发送公众号简报' });
  const cloud = screen.getByRole('checkbox', { name: '允许将文章内容发给云端模型' });
  expect(enabled).not.toBeChecked();
  expect(cloud).not.toBeChecked();
  expect(screen.getByLabelText('每天发送时间（本机时间）')).toHaveValue('08:30');
  expect(screen.getByRole('spinbutton', { name: '最多选取篇数' })).toHaveValue(5);
  expect(screen.getByRole('radio', { name: '全部公众号' })).toBeChecked();
  fireEvent.click(enabled);
  fireEvent.click(screen.getByRole('radio', { name: '仅选中的公众号' }));
  fireEvent.click(screen.getByRole('button', { name: '保存公众号简报设置' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/指定公众号时至少选一个/u);
  expect(api.setOfficialSettings).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('checkbox', { name: second.title }));
  fireEvent.change(screen.getByLabelText('每天发送时间（本机时间）'), { target: { value: '09:40' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: '最多选取篇数' }), { target: { value: '7' } });
  fireEvent.change(screen.getByRole('textbox', { name: '兴趣关键词（每行一个）' }), { target: { value: ' 合成兴趣\n测试\n合成兴趣 ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存公众号简报设置' }));
  await waitFor(() => expect(api.setOfficialSettings).toHaveBeenCalledExactlyOnceWith({
    enabled: true, time: '09:40', limit: 7, accountIds: [second.id], keywords: ['合成兴趣', '测试'], cloud: false, provider: null,
  }));
  expect(await screen.findByText('公众号简报设置已保存。')).toHaveAttribute('role', 'status');
});

it('requires a separate opt-in for cloud processing and saves the selected service', async () => {
  const api = fixture();
  render(<WeChatOfficialBriefSettingsPanel api={api} locale="en" />);
  const cloud = await screen.findByRole('checkbox', { name: 'Allow article content to be sent to cloud models' });
  expect(cloud).not.toBeChecked();
  expect(screen.queryByRole('combobox', { name: 'Cloud service for the brief' })).toBeNull();
  fireEvent.click(cloud);
  fireEvent.change(screen.getByRole('combobox', { name: 'Cloud service for the brief' }),
    { target: { value: provider.id } });
  fireEvent.click(screen.getByRole('button', { name: 'Save official account brief settings' }));
  await waitFor(() => expect(api.setOfficialSettings).toHaveBeenCalledExactlyOnceWith({
    ...defaults, cloud: true, provider: { providerId: provider.id, model: null },
  }));
});

it('can turn off the brief and cloud permission when account discovery is unavailable', async () => {
  const api = fixture({ available: false, accounts: [], providers: [], settings: { ...defaults, enabled: true, accountIds: [first.id], cloud: true } });
  render(<WeChatOfficialBriefSettingsPanel api={api} locale="zh-CN" />);
  expect(await screen.findByText('暂时读不到微信里的公众号列表，仍可关闭简报或撤回云端处理权限。')).toBeVisible();
  expect(screen.getByRole('radio', { name: '全部公众号' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: '每天发送公众号简报' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '允许将文章内容发给云端模型' }));
  fireEvent.click(screen.getByRole('button', { name: '保存公众号简报设置' }));
  await waitFor(() => expect(api.setOfficialSettings).toHaveBeenCalledExactlyOnceWith({
    ...defaults, accountIds: [first.id],
  }));
});
