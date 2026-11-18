import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { wechatCloudSettingsSchema } from '../../shared/wechat-channel';
import type { WeChatChannelAPI, WeChatChannelState, WeChatCloudState, WeChatReplyFriend } from '../../shared/wechat-channel';
import { WeChatCloudSettingsPanel } from './WeChatCloudSettings';

afterEach(cleanup);

const provider = { id: '00000000-0000-4000-8000-000000000001', name: '合成云端服务', model: 'fixture-model' };
const groupId = 'a'.repeat(32);
const group: WeChatChannelState['groups'][number] = {
  id: groupId, title: '合成测试群', policy: { mode: 'mentions', sender: null }, status: 'ready', pending: 0, uncertain: 0,
};
const cloudRoute = { providerId: provider.id, model: provider.model };

function fixture(state: WeChatCloudState, friends: WeChatReplyFriend[] = []) {
  const api = {
    getCloud: vi.fn<WeChatChannelAPI['getCloud']>(async () => state),
    configureCloud: vi.fn<WeChatChannelAPI['configureCloud']>(async settings => {
      state = { ...state, settings };
      return state;
    }),
    configureFriendCloud: vi.fn<WeChatChannelAPI['configureFriendCloud']>(async ({ friendId, route }) => {
      const friends = { ...state.settings.friends };
      if (route) friends[friendId] = route;
      else delete friends[friendId];
      state = { ...state, settings: { ...state.settings, friends } };
      return state;
    }),
    configureAssistant: vi.fn<WeChatChannelAPI['configureAssistant']>(async assistant => {
      state = { ...state, assistant };
      return state;
    }),
    configureGroupRule: vi.fn<WeChatChannelAPI['configureGroupRule']>(async ({ groupId, rule }) => {
      state = { ...state, groupRules: { ...state.groupRules, [groupId]: rule } };
      return state;
    }),
  };
  render(<WeChatCloudSettingsPanel api={api} groups={[group]} friends={friends} localModel="qwen3.5:0.8b" locale="zh-CN" disabled={false} />);
  return api;
}

it('starts each friend local and requires independent consent for that friend’s cloud route', async () => {
  const a = { id: 'b'.repeat(32), title: '合成好友甲' };
  const b = { id: 'c'.repeat(32), title: '合成好友乙' };
  const api = fixture({ available: true, assistant: { enabled: true, memories: 'all', moments: false }, groupRules: {}, providers: [provider],
    settings: { private: cloudRoute, groups: { [groupId]: cloudRoute }, friends: {} } }, [a, b]);
  const first = within(await screen.findByRole('article', { name: a.title }));
  const second = within(screen.getByRole('article', { name: b.title }));
  const source = first.getByRole('combobox', { name: '回复服务' });
  const save = first.getByRole('button', { name: '保存这位好友的回复来源' });
  const route = first.getByRole('option', { name: '合成云端服务 · fixture-model' }).getAttribute('value');
  expect(source).toHaveValue('');
  fireEvent.change(source, { target: { value: route } });
  fireEvent.change(second.getByRole('combobox'), { target: { value: route } });
  expect(save).toBeDisabled();
  expect(first.getByText(/这位好友的当前消息/u)).toBeVisible();
  fireEvent.click(first.getByRole('checkbox'));
  expect(second.getByRole('button', { name: '保存这位好友的回复来源' })).toBeDisabled();
  fireEvent.click(save);
  expect(await first.findByText('好友回复来源已保存。')).toBeVisible();
  expect(api.configureFriendCloud).toHaveBeenCalledExactlyOnceWith({ friendId: a.id, route: cloudRoute });
  expect(api.configureCloud).not.toHaveBeenCalled();
  expect(second.getByText('本机 · qwen3.5:0.8b')).toBeVisible();
  fireEvent.change(source, { target: { value: '' } });
  fireEvent.click(save);
  await waitFor(() => expect(api.configureFriendCloud).toHaveBeenLastCalledWith({ friendId: a.id, route: null }));
});

it('requires independent consent for private and group cloud routes before saving', async () => {
  const api = fixture({ available: true, assistant: { enabled: true, memories: 'all', moments: false }, groupRules: {}, providers: [provider], settings: { private: null, groups: {} } });
  const owner = within(await screen.findByRole('group', { name: '主人私聊' }));
  const member = within(screen.getByRole('group', { name: group.title }));
  const ownerService = owner.getByRole('combobox', { name: '回复服务' });
  const groupService = member.getByRole('combobox', { name: '回复服务' });
  const save = screen.getByRole('button', { name: '保存云端回复设置' });
  expect(ownerService).toHaveValue('');
  expect(groupService).toHaveValue('');
  expect(owner.getByText('本机 · qwen3.5:0.8b')).toBeVisible();
  expect(member.getByText('本机 · qwen3.5:0.8b')).toBeVisible();
  expect(save).toBeDisabled();

  const route = owner.getByRole('option', { name: '合成云端服务 · fixture-model' }).getAttribute('value');
  fireEvent.change(ownerService, { target: { value: route } });
  fireEvent.change(groupService, { target: { value: route } });
  expect(owner.getByText('本机 · qwen3.5:0.8b')).toBeVisible();
  expect(owner.queryByText('云端 · 合成云端服务 · fixture-model')).not.toBeInTheDocument();
  expect(owner.getByText(/同一会话的少量近期记录/u)).toBeVisible();
  fireEvent.click(owner.getByRole('checkbox'));
  expect(save).toBeDisabled();
  expect(api.configureCloud).not.toHaveBeenCalled();
  fireEvent.click(member.getByRole('checkbox'));
  fireEvent.click(save);
  await waitFor(() => expect(api.configureCloud).toHaveBeenCalledExactlyOnceWith({ private: cloudRoute, groups: { [groupId]: cloudRoute } }));
  expect(await screen.findByText('云端回复设置已保存。')).toBeVisible();
  expect(owner.getByText('云端 · 合成云端服务 · fixture-model')).toBeVisible();
  expect(member.getByText('云端 · 合成云端服务 · fixture-model')).toBeVisible();

  fireEvent.change(ownerService, { target: { value: '' } });
  expect(owner.getByText('云端 · 合成云端服务 · fixture-model')).toBeVisible();
  expect(owner.queryByRole('checkbox')).not.toBeInTheDocument();
  fireEvent.click(save);
  await waitFor(() => expect(api.configureCloud).toHaveBeenNthCalledWith(2, { private: null, groups: { [groupId]: cloudRoute } }));
  expect(await owner.findByText('本机 · qwen3.5:0.8b')).toBeVisible();
  expect(member.getByText('云端 · 合成云端服务 · fixture-model')).toBeVisible();
});

it('allows an unavailable saved cloud model to be turned off without offering new unlisted services', async () => {
  const api = fixture({ available: true, assistant: { enabled: true, memories: 'all', moments: false }, groupRules: {}, providers: [], settings: { private: cloudRoute, groups: {} } });
  const owner = within(await screen.findByRole('group', { name: '主人私聊' }));
  expect(owner.getByRole('option', { name: 'fixture-model · 云端模型不可用' })).toBeVisible();
  expect(owner.getByText('云端 · fixture-model · 云端模型不可用')).toBeVisible();
  expect(owner.getAllByRole('option')).toHaveLength(2);
  fireEvent.change(owner.getByRole('combobox'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '保存云端回复设置' }));
  await waitFor(() => expect(api.configureCloud).toHaveBeenCalledExactlyOnceWith({ private: null, groups: {} }));
});

it('rejects arbitrary cloud-route keys and credentials in IPC input', () => {
  expect(wechatCloudSettingsSchema.safeParse({ private: null, groups: { [groupId]: cloudRoute } }).success).toBe(true);
  expect(wechatCloudSettingsSchema.safeParse({ private: null, groups: { arbitrary: cloudRoute } }).success).toBe(false);
  expect(wechatCloudSettingsSchema.safeParse({ private: { ...cloudRoute, apiKey: 'fixture' }, groups: {} }).success).toBe(false);
});

it('offers the private-chat assistant only with a saved cloud route and saves each switch at once', async () => {
  const api = fixture({ available: true, assistant: { enabled: true, memories: 'all', moments: false }, groupRules: {}, providers: [provider], settings: { private: cloudRoute, groups: {} } });
  const assistant = within(await screen.findByRole('group', { name: '主人私聊助手' }));
  const enabled = assistant.getByRole('checkbox', { name: /联网搜索、定时任务和记忆/u });
  const memories = assistant.getByRole('checkbox', { name: /可使用全部记忆/u });
  expect(enabled).toBeChecked();
  expect(memories).toBeChecked();
  fireEvent.click(memories);
  await waitFor(() => expect(api.configureAssistant).toHaveBeenCalledExactlyOnceWith({ enabled: true, memories: 'selected', moments: false }));
  await waitFor(() => expect(memories).not.toBeChecked());
  const moments = assistant.getByRole('checkbox', { name: /朋友圈草稿/u });
  expect(moments).not.toBeChecked();
  fireEvent.click(moments);
  await waitFor(() => expect(api.configureAssistant).toHaveBeenLastCalledWith({ enabled: true, memories: 'selected', moments: true }));
  await waitFor(() => expect(moments).toBeChecked());
  fireEvent.click(enabled);
  await waitFor(() => expect(api.configureAssistant).toHaveBeenLastCalledWith({ enabled: false, memories: 'selected', moments: true }));
  await waitFor(() => expect(memories).toBeDisabled());
});

it('hides the assistant while the owner chat uses the local model', async () => {
  fixture({ available: true, assistant: { enabled: true, memories: 'all', moments: false }, groupRules: {}, providers: [provider], settings: { private: null, groups: {} } });
  await screen.findByRole('group', { name: '主人私聊' });
  expect(screen.queryByRole('group', { name: '主人私聊助手' })).not.toBeInTheDocument();
});

it('requires explicit rich content consent and keeps the other assistant settings', async () => {
  const assistant = { enabled: false, memories: 'all', moments: true } as const;
  const api = fixture({ available: true, assistant, groupRules: {}, providers: [provider],
    settings: { private: null, groups: { [groupId]: cloudRoute } } });
  const rich = await screen.findByRole('checkbox', { name: '允许将详细消息内容发送给云端模型。' });
  expect(rich).not.toBeChecked();
  expect(api.configureAssistant).not.toHaveBeenCalled();
  expect(rich).toHaveAccessibleDescription(/只对已允许云端回复的会话生效/u);
  fireEvent.click(rich);
  await waitFor(() => expect(rich).toBeChecked());
  await waitFor(() => expect(rich).toBeEnabled());
  expect(api.configureAssistant).toHaveBeenCalledExactlyOnceWith({ ...assistant, richCloud: true });
  fireEvent.click(rich);
  await waitFor(() => expect(rich).not.toBeChecked());
  expect(api.configureAssistant).toHaveBeenLastCalledWith({ ...assistant, richCloud: false });
  expect(api.configureCloud).not.toHaveBeenCalled();
});

it('leaves consent off when saving fails', async () => {
  const api = fixture({ available: true, assistant: { enabled: true, memories: 'selected', moments: false, richCloud: false },
    groupRules: {}, providers: [provider], settings: { private: cloudRoute, groups: {} } });
  api.configureAssistant.mockRejectedValueOnce(new Error('synthetic failure'));
  const rich = await screen.findByRole('checkbox', { name: '允许将详细消息内容发送给云端模型。' });
  fireEvent.click(rich);
  expect(await screen.findByRole('alert')).toHaveTextContent('未能保存详细消息的云端权限。');
  expect(rich).not.toBeChecked();
});

it('saves one group strictness and own lines without touching its reply source', async () => {
  const api = fixture({ available: true, assistant: { enabled: true, memories: 'all', moments: false }, groupRules: {}, providers: [provider],
    settings: { private: null, groups: { [groupId]: cloudRoute } } });
  const rules = within(await screen.findByRole('group', { name: '合成测试群的回复规则' }));
  const save = rules.getByRole('button', { name: '保存规则' });
  expect(rules.getByRole('combobox', { name: '严格程度' })).toHaveValue('standard');
  expect(save).toBeDisabled();
  fireEvent.change(rules.getByRole('combobox', { name: '严格程度' }), { target: { value: 'strict' } });
  fireEvent.change(rules.getByRole('textbox', { name: /补充的规则/u }), { target: { value: ' 不聊考试 ' } });
  fireEvent.click(save);
  await waitFor(() => expect(api.configureGroupRule).toHaveBeenCalledExactlyOnceWith({ groupId, rule: { level: 'strict', extra: '不聊考试', web: false } }));
  expect(await rules.findByText('群聊规则已保存。')).toBeVisible();
  expect(api.configureCloud).not.toHaveBeenCalled();
});
