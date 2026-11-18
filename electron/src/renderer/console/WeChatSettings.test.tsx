import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WeChatChannelAPI, WeChatChannelState, WeChatReplyFriend } from '../../shared/wechat-channel';
import { WeChatSettings } from './WeChatSettings';

afterEach(cleanup);

const group = (id: string, title: string): WeChatChannelState['groups'][number] => ({
  id, title, policy: { mode: 'mentions', sender: null }, status: 'ready', pending: 0, uncertain: 0,
});

function setup({ full = false, friendSupport = false } = {}) {
  const initial = group('a'.repeat(32), '合成测试群甲');
  const selected = group('b'.repeat(32), '合成测试群乙');
  let state: WeChatChannelState = {
    configured: true, groupName: initial.title, state: 'running', stale: false, paused: false,
    privateStatus: 'ready', groupStatus: 'ready', pending: 0, uncertain: 0, groupPolicy: initial.policy,
    groupBindingSupported: true, replyTargetBindingSupported: true, friendReplySupported: friendSupport,
    groups: full ? [initial, ...Array.from({ length: 11 }, (_, index) => group(String(index).padStart(32, '0'), `合成已绑群${index}`))] : [initial],
    reply: { model: 'fixture:small', split: false, stickers: false },
  };
  const snapshot = () => structuredClone(state);
  const rosterId = 'c'.repeat(64);
  const friend = { id: 'd'.repeat(32), title: '合成测试好友' };
  const friendRosterId = 'e'.repeat(64);
  let friends: WeChatReplyFriend[] = [];
  const api = {
    getState: vi.fn<WeChatChannelAPI['getState']>(async () => snapshot()),
    setPaused: vi.fn<WeChatChannelAPI['setPaused']>(async paused => {
      state = { ...state, paused, state: paused ? 'paused' : 'running' };
      return snapshot();
    }),
    bindSelectedGroup: vi.fn<WeChatChannelAPI['bindSelectedGroup']>(async () => {
      state = { ...state, groups: [...state.groups, selected] };
      return snapshot();
    }),
    listReplyGroups: vi.fn<WeChatChannelAPI['listReplyGroups']>(async () =>
      state.groups.some(item => item.id === selected.id) ? [] : [{ id: rosterId, title: selected.title }]),
    addReplyGroup: vi.fn<WeChatChannelAPI['addReplyGroup']>(async id => {
      if (id !== rosterId) throw new Error('wechat.groupNotFound');
      state = { ...state, groups: [...state.groups, selected] };
      return snapshot();
    }),
    getReplyFriends: vi.fn<WeChatChannelAPI['getReplyFriends']>(async () => friends),
    listReplyFriends: vi.fn<WeChatChannelAPI['listReplyFriends']>(async () => friends.length ? [] : [{ ...friend, id: friendRosterId }]),
    addReplyFriend: vi.fn<WeChatChannelAPI['addReplyFriend']>(async id => {
      if (id !== friendRosterId) throw new Error('wechat.friendNotFound');
      friends = [friend];
      return friends;
    }),
    removeReplyFriend: vi.fn<WeChatChannelAPI['removeReplyFriend']>(async id => {
      friends = friends.filter(item => item.id !== id);
      return friends;
    }),
    configureGroup: vi.fn<WeChatChannelAPI['configureGroup']>(async ({ groupId, policy }) => {
      state = { ...state, groups: state.groups.map(item => item.id === groupId ? { ...item, policy } : item) };
      return snapshot();
    }),
    removeGroup: vi.fn<WeChatChannelAPI['removeGroup']>(async id => {
      state = { ...state, groups: state.groups.filter(item => item.id !== id) };
      return snapshot();
    }),
    getModels: vi.fn<WeChatChannelAPI['getModels']>(async () => ['fixture:small', 'fixture:large']),
    configureReply: vi.fn<WeChatChannelAPI['configureReply']>(async reply => {
      state = { ...state, reply };
      return snapshot();
    }),
    getCloud: vi.fn<WeChatChannelAPI['getCloud']>(async () => ({ available: false, assistant: { enabled: true, memories: 'all' as const, moments: false }, groupRules: {}, providers: [], settings: { private: null, groups: {} } })),
    configureCloud: vi.fn<WeChatChannelAPI['configureCloud']>(),
    configureFriendCloud: vi.fn<WeChatChannelAPI['configureFriendCloud']>(),
    configureAssistant: vi.fn<WeChatChannelAPI['configureAssistant']>(),
    configureGroupRule: vi.fn<WeChatChannelAPI['configureGroupRule']>(),
    recoverWindow: vi.fn<WeChatChannelAPI['recoverWindow']>(async () => ({ outcome: 'restored' })),
    openVirtualMachine: vi.fn<WeChatChannelAPI['openVirtualMachine']>(async () => undefined),
  };
  render(<WeChatSettings api={api} locale="zh-CN" />);
  return { api, initial, selected, rosterId, friend, friendRosterId };
}

it('lists friends by roster ID and removes the bound friend by local ID', async () => {
  const { api, friend, friendRosterId } = setup({ friendSupport: true });
  const settings = within(await screen.findByRole('region', { name: '可以回复的好友' }));
  expect(await settings.findByText('还没有添加好友。')).toBeVisible();
  expect(settings.getByText(/每分钟最多 4 条、每天最多 60 条/u)).toHaveTextContent('每小时最多 120 条');
  fireEvent.click(settings.getByRole('button', { name: '添加好友' }));
  fireEvent.click(await settings.findByRole('button', { name: `添加 ${friend.title}` }));
  expect(await settings.findByRole('heading', { name: friend.title })).toBeVisible();
  expect(api.addReplyFriend).toHaveBeenCalledExactlyOnceWith(friendRosterId);
  expect(api.setPaused).not.toHaveBeenCalled();
  fireEvent.click(settings.getByRole('button', { name: '移除好友' }));
  expect(api.removeReplyFriend).not.toHaveBeenCalled();
  fireEvent.click(within(settings.getByRole('group', { name: '停止回复这位好友？' })).getByRole('button', { name: '移除好友' }));
  expect(await settings.findByText('还没有添加好友。')).toBeVisible();
  expect(api.removeReplyFriend).toHaveBeenCalledExactlyOnceWith(friend.id);
});

it('adds a group by its roster ID while running and refreshes the eligible list', async () => {
  const { api, initial, selected, rosterId } = setup();
  const addGroup = await screen.findByRole('button', { name: '添加群聊' });
  expect(api.listReplyGroups).not.toHaveBeenCalled();
  fireEvent.click(addGroup);
  const list = within(screen.getByRole('region', { name: '添加群聊' }));
  const add = await list.findByRole('button', { name: `添加 ${selected.title}` });
  expect(list.queryByText(initial.title)).toBeNull();
  fireEvent.click(add);
  const added = await screen.findByRole('heading', { name: selected.title });
  expect(api.addReplyGroup).toHaveBeenCalledExactlyOnceWith(rosterId);
  expect(api.setPaused).not.toHaveBeenCalled();
  expect(api.bindSelectedGroup).not.toHaveBeenCalled();
  expect(within(added.closest('article')!).getByRole('combobox')).toHaveValue('mentions');
  expect(screen.getByText(/确认它的回复方式和回复来源/u)).toBeVisible();
  expect(await list.findByText('没有其他可添加的群聊。')).toBeVisible();
});

it('shows a rejected conversation match without claiming a binding succeeded', async () => {
  const { api, selected } = setup();
  api.addReplyGroup.mockRejectedValueOnce(new Error('wechat.groupConversationMismatch'));
  fireEvent.click(await screen.findByRole('button', { name: '添加群聊' }));
  fireEvent.click(await screen.findByRole('button', { name: `添加 ${selected.title}` }));
  expect(await screen.findByRole('alert')).toHaveTextContent('打开的微信会话与所选群聊不一致。');
  expect(screen.queryByRole('heading', { name: selected.title })).toBeNull();
  expect(screen.getByRole('button', { name: '暂停自动回复' })).toBeEnabled();
});

it('shows the capacity limit and disables adding while retaining the candidates', async () => {
  const { api, selected } = setup({ full: true });
  fireEvent.click(await screen.findByRole('button', { name: '添加群聊' }));
  const add = await screen.findByRole('button', { name: `添加 ${selected.title}` });
  expect(add).toBeDisabled();
  expect(screen.getByText(/已达到可绑定的群聊数量上限/u)).toBeVisible();
  expect(api.addReplyGroup).not.toHaveBeenCalled();
});

it('pauses from the add-group button, binds the selected guest group, saves only its policy and removes it after confirmation', async () => {
  const { api, initial, selected } = setup();
  expect(await screen.findByRole('heading', { name: initial.title })).toBeVisible();
  const bind = screen.getByRole('button', { name: '绑定当前选中的微信群' });
  expect(bind).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '打开微信虚拟机' }));
  await waitFor(() => expect(api.openVirtualMachine).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole('button', { name: '暂停并添加群聊' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '暂停并添加群聊' }));
  await waitFor(() => expect(bind).toBeEnabled());
  expect(api.setPaused).toHaveBeenCalledExactlyOnceWith(true);
  expect(screen.getByText(/已暂停。请在虚拟机的微信里选中要添加的群/u)).toBeVisible();
  expect(screen.queryByRole('button', { name: '暂停并添加群聊' })).toBeNull();
  fireEvent.click(bind);
  const title = await screen.findByRole('heading', { name: selected.title });
  const boundGroup = within(title.closest('article')!);
  const mode = boundGroup.getByRole('combobox', { name: '什么时候在群里回复' });
  fireEvent.change(mode, { target: { value: 'sender' } });
  const save = boundGroup.getByRole('button', { name: '保存群聊回复方式' });
  expect(save).toBeDisabled();
  fireEvent.change(boundGroup.getByRole('textbox', { name: /成员在这个群里显示的准确昵称/u }), { target: { value: ' 群友乙 ' } });
  fireEvent.click(save);
  await waitFor(() => expect(api.configureGroup).toHaveBeenCalledExactlyOnceWith({ groupId: selected.id, policy: { mode: 'sender', sender: '群友乙' } }));
  await waitFor(() => expect(boundGroup.getByRole('button', { name: '移除这个群' })).toBeEnabled());
  expect(within(screen.getByRole('heading', { name: initial.title }).closest('article')!).getByRole('combobox')).toHaveValue('mentions');
  fireEvent.click(boundGroup.getByRole('button', { name: '移除这个群' }));
  expect(api.removeGroup).not.toHaveBeenCalled();
  const confirm = boundGroup.getByRole('group', { name: '停止监听并移除这个群？' });
  fireEvent.click(within(confirm).getByRole('button', { name: '移除这个群' }));
  await waitFor(() => expect(api.removeGroup).toHaveBeenCalledExactlyOnceWith(selected.id));
  expect(screen.queryByRole('heading', { name: selected.title })).not.toBeInTheDocument();
});

it('updates the local model and delivery options, and shows the actual window recovery outcome', async () => {
  const { api } = setup();
  const model = await screen.findByRole('combobox', { name: /回复模型/u });
  await waitFor(() => expect(model).toBeEnabled());
  fireEvent.change(model, { target: { value: 'fixture:large' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /长回复分成多条消息/u }));
  fireEvent.click(screen.getByRole('checkbox', { name: /允许回复时发表情包/u }));
  fireEvent.click(screen.getByRole('button', { name: '保存回复设置' }));
  await waitFor(() => expect(api.configureReply).toHaveBeenCalledExactlyOnceWith({ model: 'fixture:large', split: true, stickers: true }));
  expect(await screen.findByText('微信回复设置已保存。')).toBeVisible();
  expect(screen.getByText(/优先使用虚拟机里该账号的收藏表情/u)).toHaveTextContent('/sticker library 只使用图库');
  fireEvent.click(screen.getByRole('button', { name: '恢复微信窗口' }));
  expect(await screen.findByText('微信窗口已恢复。')).toBeVisible();
  api.recoverWindow.mockResolvedValueOnce({ outcome: 'login_required' });
  fireEvent.click(screen.getByRole('button', { name: '恢复微信窗口' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('请打开虚拟机并重新登录微信。');
});

it('keeps replies, daily summaries and the inbox on separate tabs', async () => {
  const digests = { getGroupSettings: vi.fn(async () => ({ settings: { time: '21:30', groups: [], provider: null, keywords: [] }, groups: [], providers: [], available: true })),
    groupResults: vi.fn(async () => []), getOfficialSettings: vi.fn(async () => { throw new Error('fixture'); }),
    getFriendsMomentsSettings: vi.fn(async () => { throw new Error('fixture'); }) };
  const inbox = { getExport: vi.fn(async () => false), setExport: vi.fn(), list: vi.fn(async () => []), remove: vi.fn() };
  Object.assign(window, { deskpet: { wechatDigests: digests, wechatInbox: inbox } });
  try {
    const { initial } = setup();
    expect(await screen.findByRole('heading', { name: initial.title })).toBeVisible();
    expect(screen.getByRole('tab', { name: '回复' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('region', { name: '群聊每日精华' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '每日整理' }));
    expect(await screen.findByRole('region', { name: '群聊每日精华' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: initial.title })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '收件箱' }));
    await waitFor(() => expect(inbox.getExport).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('tab', { name: '回复' }));
    expect(screen.getByRole('heading', { name: initial.title })).toBeVisible();
  } finally {
    Reflect.deleteProperty(window, 'deskpet');
  }
});
