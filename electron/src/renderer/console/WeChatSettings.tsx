import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ResolvedLocale } from '../../shared';
import { wechatGroupPolicySchema } from '../../shared/wechat-channel';
import { WECHAT_FRIEND_REPLY_RATE, WECHAT_REPLY_FRIEND_LIMIT, WECHAT_REPLY_GROUP_LIMIT } from '../../shared/wechat-channel';
import type { WeChatChannelAPI, WeChatChannelState, WeChatReplyFriend, WeChatReplyGroupCandidate } from '../../shared/wechat-channel';
import { WeChatCloudSettingsPanel } from './WeChatCloudSettings';
import { WeChatInboxExportSettings } from './WeChatInboxPanel';
import { WeChatGroupDigestSettings } from './WeChatGroupDigests';
import { WeChatFollowupSettingsPanel } from './WeChatFollowup';
import { WeChatOfficialBriefSettingsPanel } from './WeChatOfficialBrief';
import { WeChatFriendsMomentsSettingsPanel } from './WeChatFriendsMoments';
import './wechat-settings.css';

type Policy = WeChatChannelState['groupPolicy'];
type PolicyDraft = { mode: Policy['mode']; sender: string | null };
type Group = WeChatChannelState['groups'][number];
type Reply = WeChatChannelState['reply'];

const en = {
  title: 'WeChat channel',
  loading: 'Reading WeChat settings…',
  unavailable: 'Set up the dedicated WeChat virtual machine to use this channel.',
  loadError: 'Could not read the WeChat channel. Refresh to try again.',
  updateError: 'The change could not be saved. Refresh the status and try again.',
  busyError: 'Another change is in progress. Try again in a moment.',
  unavailableError: 'The WeChat listener is unavailable. Check the virtual machine and refresh the status.',
  policyError: 'Check the group reply setting and the member nickname.',
  notPausedError: 'Wait for the listener to pause before binding a group.',
  bindError: 'DeskPet could not bind this group. Select the group in the WeChat virtual machine and try again.',
  groupLimitError: 'The group limit has been reached. Remove a group before adding another.',
  groupNotFoundError: 'This group is no longer bound. Refresh the group list.',
  removeError: 'DeskPet could not remove this group. Refresh the settings and try again.',
  modelsError: 'Could not read the installed local Ollama models.',
  replyError: 'Could not save the WeChat reply settings. Check that the selected model is installed locally.',
  recoveryError: 'DeskPet could not restore the WeChat window. Open the virtual machine to check it.',
  vmError: 'Could not open the WeChat virtual machine.',
  refreshed: 'Status updated.',
  status: 'Listener',
  stale: 'Status is out of date',
  starting: 'Starting',
  running: 'Running',
  paused: 'Paused',
  degraded: 'Needs attention',
  stopped: 'Stopped',
  refresh: 'Refresh status',
  pause: 'Pause automatic replies',
  resume: 'Resume automatic replies',
  pausing: 'Pausing…',
  resuming: 'Resuming…',
  private: 'Private chat',
  ready: 'Listening through the local database',
  waitingMention: 'Waiting for an @-mention',
  disabled: 'Off',
  routeStatus: {
    database_unavailable: 'Could not read the WeChat database. Check that the virtual machine and WeChat are running.',
    database_unbound: 'Database conversation has not been verified.',
    database_sender_unverified: 'Could not identify a unique account for the selected group member.',
    group_policy_invalid: 'Check the saved reply policy', group_unverified: 'Group could not be verified',
    continuity_lost: 'New messages could not be verified', mention_ambiguous: 'Could not identify the @-mention',
    queue_full: 'Reply queue is full', queue_paused: 'Private reply queue paused', send_uncertain: 'Send needs confirmation', model_unavailable: 'Local model unavailable',
    cloud_model_unavailable: 'Cloud reply unavailable. Check the selected service in WeChat settings.',
    owner_commands_unavailable: 'Private commands are waiting for DeskPet to open.',
    read_tools_unavailable: 'Search and other commands are waiting for DeskPet to open.',
    policy_changed: 'Reply policy changed', group_removed: 'Group removed', original_unavailable: 'Original message unavailable',
    send_preflight_blocked: 'Could not verify the reply before sending',
  },
  pending: 'Queued replies',
  uncertain: 'Unconfirmed sends',
  uncertainHelp: 'Check any unconfirmed sends in WeChat.',
  groupsTitle: 'Bound groups',
  noGroups: 'No groups are bound.',
  groupPicker: 'Add groups',
  groupPickerAdd: 'Add',
  groupPickerBusy: 'Verifying group…',
  groupPickerLoading: 'Reading your WeChat groups…',
  groupPickerEmpty: 'There are no more groups to add.',
  groupPickerError: 'Could not read your WeChat groups. Check that WeChat is open in the virtual machine, then refresh the list.',
  groupPickerRefresh: 'Refresh group list',
  groupPickerAdded: 'Group added. It starts with replies only when @-mentioned. Review its reply policy and reply source below.',
  groupPickerBindError: 'The group could not be verified. Refresh the list before trying again.',
  groupPickerTitleAmbiguous: 'More than one group has that name. Rename the group in WeChat so it has a unique name before adding it.',
  groupPickerSearchAmbiguous: 'WeChat search could not identify one group with that name. Check the group name in WeChat.',
  groupPickerTitleMismatch: 'The title of the opened group did not match the selected group.',
  groupPickerConversationMismatch: 'The opened WeChat conversation did not match the selected group.',
  groupPickerUnsupported: 'Update the WeChat listener to add groups from its list.',
  groupPickerNotFound: 'This group is no longer available to add. Refresh the group list.',
  friendsTitle: 'Friends DeskPet can reply to',
  noFriends: 'No friends have been added.',
  friendsLoadError: 'Could not read your bound friends. Refresh to try again.',
  friendsRefresh: 'Refresh bound friends',
  friendPicker: 'Add friends',
  friendPickerLoading: 'Reading WeChat contacts…',
  friendPickerEmpty: 'There are no more eligible friends to add.',
  friendPickerError: 'Could not read your WeChat contacts. Check the virtual machine, then refresh the list.',
  friendPickerRefresh: 'Refresh contact list',
  friendPickerBusy: 'Verifying contact…',
  friendPickerAdded: 'Friend added with local replies. You can review its reply source below.',
  friendPickerBindError: 'The friend could not be verified. Refresh the list before trying again.',
  friendPickerTitleAmbiguous: 'More than one contact has this name. Use a unique contact name in WeChat before adding.',
  friendPickerSearchAmbiguous: 'WeChat search could not identify one contact with that name.',
  friendPickerTitleMismatch: 'The title of the opened chat did not match the selected contact.',
  friendPickerConversationMismatch: 'The opened WeChat conversation did not match the selected contact.',
  friendPickerNotFound: 'This friend is no longer available. Refresh the list.',
  friendLimitError: `You can add up to ${WECHAT_REPLY_FRIEND_LIMIT} friends. Remove one before adding another.`,
  friendHelp: `DeskPet replies to new messages using its public persona and that friend’s recent chat. Limits are ${WECHAT_FRIEND_REPLY_RATE.perFriendMinute} replies per minute and ${WECHAT_FRIEND_REPLY_RATE.perFriendDay} per day for each friend, and ${WECHAT_FRIEND_REPLY_RATE.allFriendsHour} per hour across all friends.`,
  removeFriend: 'Remove friend',
  confirmRemoveFriend: 'Stop replying to this friend?',
  friendRemoved: 'Friend removed.',
  removeFriendError: 'Could not remove this friend. Refresh the list before trying again.',
  bindGroup: 'Bind selected WeChat group',
  bindingGroup: 'Checking selected group…',
  bindGroupHelp: 'Click “Pause to add a group”, open the virtual machine and select the group in WeChat, then return here to bind it. Automatic replies stay paused until you resume them.',
  prepareBind: 'Pause to add a group',
  bindReady: 'Paused. Select the group in WeChat inside the virtual machine, then click “Bind selected WeChat group”.',
  sections: { reply: 'Replies', digests: 'Daily summaries', inbox: 'Inbox' },
  bindUnsupported: 'Group binding needs an updated listener.',
  groupAdded: 'WeChat group bound.',
  removeGroup: 'Remove group',
  removingGroup: 'Removing…',
  confirmRemove: 'Remove this group from the listener?',
  cancel: 'Cancel',
  groupRemoved: 'WeChat group removed.',
  mode: 'When to reply in the group',
  modes: { mentions: 'Only when @-mentioned', sender: 'Messages from a specific member', all: 'All new messages', off: 'Group replies off' },
  sender: 'Exact nickname shown in this group',
  senderHelp: 'DeskPet resolves the name to one account in this group. If the name is ambiguous, this rule waits for a unique match.',
  allHelp: 'DeskPet can reply to new messages from anyone in the bound group, including messages without an @-mention.',
  upgradeRequired: 'Update the existing WeChat listener before changing the group reply policy. Pause and resume are still available.',
  changeHelp: 'Changes apply to new messages. Each group uses its own recent chat history.',
  save: 'Save group policy',
  saving: 'Saving…',
  saved: 'Group policy saved.',
  replyTitle: 'Local model and reply options',
  model: 'Local reply model',
  modelHelp: 'Choose an installed Ollama model for conversations set to use the local model.',
  modelUnavailable: 'Not in the local model list',
  refreshModels: 'Refresh local models',
  loadingModels: 'Reading local models…',
  split: 'Split long replies into multiple messages',
  splitHelp: 'DeskPet may send longer text replies in several short bubbles.',
  stickers: 'Allow stickers with replies',
  stickersHelp: 'DeskPet can choose an approved sticker when it fits the reply.',
  replySave: 'Save reply settings',
  replySaved: 'Reply settings saved.',
  openVm: 'Open WeChat virtual machine',
  openingVm: 'Opening virtual machine…',
  recover: 'Restore WeChat window',
  recovering: 'Restoring WeChat window…',
  recovered: 'WeChat window restored.',
  recoveryReady: 'The WeChat window is ready.',
  recoveryLogin: 'Open the virtual machine and sign in to WeChat again.',
  recoveryAmbiguous: 'Several WeChat windows are open. Close any extra windows in the virtual machine.',
  recoveryLayout: 'The WeChat window is open, but its layout changed. Check it in the virtual machine.',
  recoveryTray: 'WeChat is hidden in the virtual machine tray. Open the virtual machine and select the WeChat tray icon.',
  recoveryNotConfirmed: 'The window could not be confirmed. Open the virtual machine to check it.',
  commandsHelp: 'Send /help in your bound private chat for queue, search and sticker commands. Use /cron to schedule a reminder or a task that runs at the selected time and sends its result. Keep DeskPet open.',
  stickerCommandsHelp: 'With stickers enabled, /sticker tries the virtual account’s WeChat favorites first and falls back to an approved image from the DeskPet library if needed. /sticker library uses only the DeskPet library. Group reply rules still apply.',
  memoryHelp: 'Replies use your DeskPet persona while the app is open. In Memory, enable WeChat private chat for the individual memories you want to share with this channel.',
};

const zh: typeof en = {
  title: '微信通道',
  loading: '正在读取微信设置…',
  unavailable: '设置专用微信虚拟机后即可使用这个通道。',
  loadError: '暂时无法读取微信通道，请刷新后重试。',
  updateError: '未能保存更改，请刷新状态后重试。',
  busyError: '正在处理另一项更改，请稍后重试。',
  unavailableError: '微信监听服务暂不可用，请检查虚拟机并刷新状态。',
  policyError: '请检查群聊回复方式和成员昵称。',
  notPausedError: '请等监听服务暂停后再绑定群聊。',
  bindError: '未能绑定这个群。请在微信虚拟机里选中群聊，再试一次。',
  groupLimitError: '已达到可绑定的群聊数量上限。移除一个群聊后可继续添加。',
  groupNotFoundError: '这个群已不在绑定列表中，请刷新状态。',
  removeError: '未能移除这个群，请刷新设置后重试。',
  modelsError: '未能读取本机 Ollama 已安装的模型。',
  replyError: '未能保存微信回复设置，请确认所选模型已安装在本机。',
  recoveryError: '未能恢复微信窗口，请打开虚拟机检查。',
  vmError: '未能打开微信虚拟机。',
  refreshed: '状态已刷新。',
  status: '监听服务',
  stale: '状态已过期',
  starting: '正在启动',
  running: '运行中',
  paused: '已暂停',
  degraded: '需要检查',
  stopped: '已停止',
  refresh: '刷新状态',
  pause: '暂停自动回复',
  resume: '恢复自动回复',
  pausing: '正在暂停…',
  resuming: '正在恢复…',
  private: '私聊',
  ready: '正在读取本地数据库',
  waitingMention: '等待被 @',
  disabled: '已关闭',
  routeStatus: {
    database_unavailable: '无法读取微信数据库。请检查虚拟机和微信是否正在运行。',
    database_unbound: '尚未核验这个会话的数据库身份。',
    database_sender_unverified: '无法将成员昵称匹配到群里唯一的账号。',
    group_policy_invalid: '请检查群聊回复方式', group_unverified: '未能核实群聊',
    continuity_lost: '未能核实新消息', mention_ambiguous: '未能确认具体的 @ 消息',
    queue_full: '回复队列已满', queue_paused: '普通私聊回复已暂停', send_uncertain: '发送结果待确认', model_unavailable: '本机模型不可用',
    cloud_model_unavailable: '云端回复暂不可用，请检查微信通道中选定的模型服务',
    owner_commands_unavailable: '私聊指令正在等待 DeskPet 打开',
    read_tools_unavailable: '搜索等只读指令正在等待 DeskPet 打开',
    policy_changed: '回复方式已更改', group_removed: '已移除群聊', original_unavailable: '未能找到原消息',
    send_preflight_blocked: '发送前未能核对回复',
  },
  pending: '待处理回复',
  uncertain: '发送结果待确认',
  uncertainHelp: '请在微信中核对发送结果待确认的消息。',
  groupsTitle: '已绑定的群聊',
  noGroups: '还没有绑定群聊。',
  groupPicker: '添加群聊',
  groupPickerAdd: '添加',
  groupPickerBusy: '正在核对群聊…',
  groupPickerLoading: '正在读取微信里的群聊…',
  groupPickerEmpty: '没有其他可添加的群聊。',
  groupPickerError: '未能读取群聊列表。请检查虚拟机里的微信是否已打开，再刷新列表。',
  groupPickerRefresh: '刷新群聊列表',
  groupPickerAdded: '已添加群聊，默认仅在被 @ 时回复。请在下方确认它的回复方式和回复来源。',
  groupPickerBindError: '未能核实这个群。请刷新列表后重试。',
  groupPickerTitleAmbiguous: '存在同名群聊。请先在微信里改成能唯一识别的群名，再添加。',
  groupPickerSearchAmbiguous: '微信搜索无法确认唯一的群聊。请在微信里核对群名。',
  groupPickerTitleMismatch: '打开的群聊标题与选中的群不一致。',
  groupPickerConversationMismatch: '打开的微信会话与所选群聊不一致。',
  groupPickerUnsupported: '更新微信监听服务后可以从列表添加群聊。',
  groupPickerNotFound: '这个群已无法添加。请刷新群聊列表。',
  friendsTitle: '可以回复的好友',
  noFriends: '还没有添加好友。',
  friendsLoadError: '未能读取已添加的好友。请刷新后重试。',
  friendsRefresh: '刷新已添加的好友',
  friendPicker: '添加好友',
  friendPickerLoading: '正在读取微信通讯录…',
  friendPickerEmpty: '没有其他可添加的好友。',
  friendPickerError: '未能读取微信通讯录。请检查虚拟机里的微信，再刷新列表。',
  friendPickerRefresh: '刷新通讯录',
  friendPickerBusy: '正在核对联系人…',
  friendPickerAdded: '已添加好友，默认使用本机模型回复。可在下方查看回复来源。',
  friendPickerBindError: '未能核实这个好友。请刷新列表后重试。',
  friendPickerTitleAmbiguous: '通讯录有同名联系人。请先在微信里设置可唯一识别的备注名。',
  friendPickerSearchAmbiguous: '微信搜索无法确认唯一的联系人。',
  friendPickerTitleMismatch: '打开的聊天标题与所选联系人不一致。',
  friendPickerConversationMismatch: '打开的微信会话与所选联系人不一致。',
  friendPickerNotFound: '这个好友已不可用。请刷新列表。',
  friendLimitError: `最多添加 ${WECHAT_REPLY_FRIEND_LIMIT} 位好友。移除一位后可继续添加。`,
  friendHelp: `桌宠用对外人设和与该好友的近期聊天回复。每位好友每分钟最多 ${WECHAT_FRIEND_REPLY_RATE.perFriendMinute} 条、每天最多 ${WECHAT_FRIEND_REPLY_RATE.perFriendDay} 条，全部好友合计每小时最多 ${WECHAT_FRIEND_REPLY_RATE.allFriendsHour} 条。`,
  removeFriend: '移除好友',
  confirmRemoveFriend: '停止回复这位好友？',
  friendRemoved: '已移除好友。',
  removeFriendError: '未能移除这位好友。请刷新列表后重试。',
  bindGroup: '绑定当前选中的微信群',
  bindingGroup: '正在核对选中的群聊…',
  bindGroupHelp: '点「暂停并添加群聊」，再打开虚拟机，在微信里选中要添加的群，回到这里点「绑定当前选中的微信群」。绑定后记得点「恢复自动回复」。',
  prepareBind: '暂停并添加群聊',
  bindReady: '已暂停。请在虚拟机的微信里选中要添加的群，然后点「绑定当前选中的微信群」。',
  sections: { reply: '回复', digests: '每日整理', inbox: '收件箱' },
  bindUnsupported: '更新监听服务后可以绑定群聊。',
  groupAdded: '已绑定微信群聊。',
  removeGroup: '移除这个群',
  removingGroup: '正在移除…',
  confirmRemove: '停止监听并移除这个群？',
  cancel: '取消',
  groupRemoved: '已移除微信群聊。',
  mode: '什么时候在群里回复',
  modes: { mentions: '仅在被 @ 时回复', sender: '回复指定成员的消息', all: '回复所有新消息', off: '关闭群聊回复' },
  sender: '成员在这个群里显示的准确昵称',
  senderHelp: '桌宠将昵称匹配到群里的唯一账号。如果有同名成员，这条规则会等到账号可以唯一确认。',
  allHelp: '桌宠可以回复这个群里任意成员的新消息，包括没有 @ 它的消息。',
  upgradeRequired: '现有微信监听服务需要更新。更新后可更改群聊回复方式，当前仍可暂停或恢复自动回复。',
  changeHelp: '更改只影响新消息。每个群使用自己的近期聊天记录。',
  save: '保存群聊回复方式',
  saving: '正在保存…',
  saved: '群聊回复方式已保存。',
  replyTitle: '本机模型和回复选项',
  model: '本机回复模型',
  modelHelp: '只有选择本机回复的会话才使用这里设置的 Ollama 模型。',
  modelUnavailable: '当前不在本机模型列表中',
  refreshModels: '刷新本机模型',
  loadingModels: '正在读取本机模型…',
  split: '长回复分成多条消息',
  splitHelp: '较长的文字回复可以分成几个短气泡发送。',
  stickers: '允许回复时发表情包',
  stickersHelp: '合适时，桌宠可选用已允许发送的表情包。',
  replySave: '保存回复设置',
  replySaved: '微信回复设置已保存。',
  openVm: '打开微信虚拟机',
  openingVm: '正在打开虚拟机…',
  recover: '恢复微信窗口',
  recovering: '正在恢复微信窗口…',
  recovered: '微信窗口已恢复。',
  recoveryReady: '微信窗口已就绪。',
  recoveryLogin: '请打开虚拟机并重新登录微信。',
  recoveryAmbiguous: '发现多个微信窗口，请打开虚拟机并关闭多余的窗口。',
  recoveryLayout: '微信窗口已打开，但界面布局发生了变化，请在虚拟机中检查。',
  recoveryTray: '微信隐藏在虚拟机托盘中，请打开虚拟机并点击托盘里的微信图标。',
  recoveryNotConfirmed: '暂时无法确认微信窗口，请打开虚拟机检查。',
  commandsHelp: '在已绑定的主号私聊发 /help 查看队列、搜索和表情指令。发 /cron 可设置提醒或安排到点执行并回传结果的任务。请保持 DeskPet 运行。',
  stickerCommandsHelp: '开启表情回复后，在微信发 /sticker，优先使用虚拟机里该账号的收藏表情，无法使用时从 DeskPet 图库选取已授权的图片。发 /sticker library 只使用图库。群聊仍按该群的回复规则触发。',
  memoryHelp: 'DeskPet 运行时，微信回复可使用你已设置的人格。在「记忆」中，可以逐条选择主号私聊可使用的记忆。',
};

const modes: readonly Policy['mode'][] = ['mentions', 'sender', 'all', 'off'];
const senderMaxInputLength = 160;
const statusIntervalMs = 3000;
const actionErrors = {
  busy: 'busyError', unavailable: 'unavailableError', invalidPolicy: 'policyError', notPaused: 'notPausedError',
  groupUnverified: 'bindError', groupLimit: 'groupLimitError', groupNotFound: 'groupNotFoundError', modelUnavailable: 'replyError',
  groupTitleAmbiguous: 'groupPickerTitleAmbiguous', groupConversationMismatch: 'groupPickerConversationMismatch',
  replyTargetsWorkerUpgradeRequired: 'groupPickerUnsupported',
  friendUnverified: 'friendPickerBindError', friendLimit: 'friendLimitError', friendNotFound: 'friendPickerNotFound',
  friendTitleAmbiguous: 'friendPickerTitleAmbiguous', friendConversationMismatch: 'friendPickerConversationMismatch',
} as const;
type ErrorKey = 'loadError' | 'updateError' | 'bindError' | 'groupPickerBindError' | 'groupPickerNotFound' | 'removeError' | 'modelsError' | 'replyError' | 'recoveryError' | 'vmError'
  | 'groupPickerTitleMismatch' | 'groupPickerSearchAmbiguous' | 'friendPickerTitleMismatch' | 'friendPickerSearchAmbiguous' | 'removeFriendError'
  | typeof actionErrors[keyof typeof actionErrors];
type Action = 'save' | 'pause' | 'resume' | 'bind' | 'addGroup' | 'addFriend' | 'removeFriend' | 'remove' | 'reply' | 'recover' | 'open';
type Notice = 'saved' | 'refreshed' | 'groupAdded' | 'groupPickerAdded' | 'groupRemoved' | 'replySaved' | 'recovered' | 'recoveryReady' | 'bindReady' | 'friendPickerAdded' | 'friendRemoved';
type RecoveryNotice = 'recoveryLogin' | 'recoveryAmbiguous' | 'recoveryLayout' | 'recoveryTray' | 'recoveryNotConfirmed';
const actionFallback: Record<Action, ErrorKey> = {
  save: 'updateError', pause: 'updateError', resume: 'updateError', bind: 'bindError', addGroup: 'groupPickerBindError', remove: 'removeError', reply: 'replyError', recover: 'recoveryError', open: 'vmError',
  addFriend: 'friendPickerBindError', removeFriend: 'removeFriendError',
};
const selectionErrors = {
  targetSearchAmbiguous: { addGroup: 'groupPickerSearchAmbiguous', addFriend: 'friendPickerSearchAmbiguous' },
  targetTitleMismatch: { addGroup: 'groupPickerTitleMismatch', addFriend: 'friendPickerTitleMismatch' },
} as const;
const recoveryLabels: Readonly<Record<string, Notice | RecoveryNotice>> = {
  restored: 'recovered', already_open: 'recoveryReady', login_required: 'recoveryLogin', unavailable: 'recoveryNotConfirmed',
  ambiguous_window: 'recoveryAmbiguous', layout_changed: 'recoveryLayout', tray_hidden: 'recoveryTray',
};

const statusLabel = (status: string | null, copy: typeof en): string | null => {
  switch (status) {
    case 'starting': case 'running': case 'paused': case 'stopped': case 'degraded': return copy[status];
    case 'ready': case 'listening': return copy.ready;
    case 'waiting_at': case 'waiting_mention': return copy.waitingMention;
    case 'off': case 'disabled': return copy.disabled;
    default: return status && Object.hasOwn(copy.routeStatus, status) ? copy.routeStatus[status as keyof typeof copy.routeStatus] : null;
  }
};

function GroupPolicyForm({ copy, group, disabled, busy, save, remove, canRemove }: {
  copy: typeof en; group: Group; disabled: boolean; busy: Action | null;
  save(policy: Policy): Promise<boolean>; remove(): Promise<boolean>; canRemove: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const policy = draft ?? group.policy;
  const mode = policy.mode;
  const sender = mode === 'sender' ? policy.sender?.trim() || null : null;
  const candidate = wechatGroupPolicySchema.safeParse({ mode, sender });
  const canSave = !disabled && candidate.success && (group.policy.mode !== mode || group.policy.sender !== sender);
  const status = statusLabel(group.status, copy);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (canSave && candidate.success && await save(candidate.data)) setDraft(null);
  };
  return <article className="wechat-group">
    <header className="wechat-group-header">
      <h4>{group.title}</h4>
      {status && <span className="muted">{status}</span>}
    </header>
    {(group.pending > 0 || group.uncertain > 0) && <p className="muted">{copy.pending} {group.pending} · {copy.uncertain} {group.uncertain}</p>}
    <form className="stack-form" onSubmit={event => void submit(event)}>
      <label>{copy.mode}<select value={mode} disabled={disabled} onChange={event => {
        setDraft({ mode: event.target.value as Policy['mode'], sender: policy.sender });
      }}>{modes.map(value => <option key={value} value={value}>{copy.modes[value]}</option>)}</select></label>
      {mode === 'sender' && <label>{copy.sender}
        <input value={policy.sender ?? ''} maxLength={senderMaxInputLength} disabled={disabled} onChange={event => {
          setDraft({ mode, sender: event.target.value });
        }} aria-describedby={`wechat-sender-help-${group.id}`} />
        <small id={`wechat-sender-help-${group.id}`}>{copy.senderHelp}</small>
      </label>}
      {mode === 'all' && <p>{copy.allHelp}</p>}
      <div className="button-row">
        <button type="submit" disabled={!canSave}>{busy === 'save' ? copy.saving : copy.save}</button>
        {!confirmRemove && <button type="button" className="text-button" disabled={!canRemove} onClick={() => setConfirmRemove(true)}>{copy.removeGroup}</button>}
      </div>
    </form>
    {confirmRemove && <div className="button-row" role="group" aria-label={copy.confirmRemove}>
      <span>{copy.confirmRemove}</span>
      <button type="button" className="danger" disabled={!canRemove} onClick={() => void remove().then(success => {
        if (success) setConfirmRemove(false);
      })}>{busy === 'remove' ? copy.removingGroup : copy.removeGroup}</button>
      <button type="button" className="secondary" disabled={busy !== null} onClick={() => setConfirmRemove(false)}>{copy.cancel}</button>
    </div>}
  </article>;
}

function ReplySettings({ api, copy, reply, busy, save, disabled }: {
  api: WeChatChannelAPI; copy: typeof en; reply: Reply; busy: Action | null; save(value: Reply): Promise<boolean>; disabled: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState<Reply | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [catalogRevision, setCatalogRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    void api.getModels().then(items => {
      if (active) setModels(items);
    }).catch(() => {
      if (active) setFailed(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [api, catalogRevision]);

  const value = draft ?? reply;
  const validModel = value.model === reply.model || models.includes(value.model);
  const canSave = validModel && !disabled && (value.model !== reply.model || value.split !== reply.split || value.stickers !== reply.stickers);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (canSave && await save(value)) setDraft(null);
  };
  return <form className="stack-form wechat-policy" onSubmit={event => void submit(event)}>
    <h3>{copy.replyTitle}</h3>
    <label>{copy.model}<select value={value.model} disabled={disabled || loading} onChange={event => setDraft({ ...value, model: event.target.value })}>
      {!models.includes(value.model) && <option value={value.model}>{value.model}{!loading && ` · ${copy.modelUnavailable}`}</option>}
      {models.map(model => <option key={model} value={model}>{model}</option>)}
    </select><small>{copy.modelHelp}</small></label>
    {failed && <p className="inline-error" role="status">{copy.modelsError}</p>}
    <button type="button" className="secondary" disabled={disabled || loading} onClick={() => setCatalogRevision(revision => revision + 1)}>
      {loading ? copy.loadingModels : copy.refreshModels}
    </button>
    <label className="wechat-option"><input type="checkbox" checked={value.split} disabled={disabled} onChange={event => setDraft({ ...value, split: event.target.checked })} />
      <span>{copy.split}<small>{copy.splitHelp}</small></span>
    </label>
    <label className="wechat-option"><input type="checkbox" checked={value.stickers} disabled={disabled} onChange={event => setDraft({ ...value, stickers: event.target.checked })} />
      <span>{copy.stickers}<small>{copy.stickersHelp}</small></span>
    </label>
    <button type="submit" disabled={!canSave}>{busy === 'reply' ? copy.saving : copy.replySave}</button>
  </form>;
}

type PickerLabels = { title: string; add: string; binding: string; loading: string; empty: string; error: string; refresh: string; limit: string };

function ReplyTargetPicker({ load, copy, disabled, binding, busy, revision, limitReached, add }: {
  load(): Promise<WeChatReplyGroupCandidate[]>; copy: PickerLabels; disabled: boolean; binding: boolean; busy: boolean; revision: string;
  limitReached: boolean; add(id: string): Promise<boolean>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const [entries, setEntries] = useState<WeChatReplyGroupCandidate[] | null>(null);
  const [failed, setFailed] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    let current = true;
    setEntries(null);
    setFailed(false);
    void load().then(value => { if (current) setEntries(value); }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [load, open, reload, revision]);

  const loading = entries === null && !failed;
  return <div>
    <button type="button" className="secondary" aria-expanded={open} aria-controls={id} disabled={disabled}
      onClick={() => setOpen(value => !value)}>{copy.title}</button>
    {open && <section id={id} aria-label={copy.title} className="wechat-groups">
        {loading && <p role="status">{copy.loading}</p>}
        {failed && <p className="inline-error" role="status">{copy.error}</p>}
        {limitReached && <p className="muted">{copy.limit}</p>}
        {entries?.length === 0 && <p className="muted">{copy.empty}</p>}
        {entries?.map(entry => <div key={entry.id} className="wechat-group-header">
          <span>{entry.title}</span>
          <button type="button" className="secondary" aria-label={`${copy.add} ${entry.title}`} disabled={disabled || limitReached}
            onClick={() => void add(entry.id)}>{copy.add}</button>
        </div>)}
        {binding && <p role="status">{copy.binding}</p>}
        <div><button type="button" className="secondary" disabled={busy || loading} onClick={() => setReload(value => value + 1)}>
          {copy.refresh}
        </button></div>
    </section>}
  </div>;
}

function ReplyFriendRow({ friend, copy, disabled, remove }: {
  friend: WeChatReplyFriend; copy: typeof en; disabled: boolean; remove(id: string): Promise<boolean>;
}): JSX.Element {
  const [confirm, setConfirm] = useState(false);
  return <article className="wechat-group" aria-label={friend.title}>
    <div className="wechat-group-header"><h4>{friend.title}</h4>
      {!confirm && <button type="button" className="secondary" disabled={disabled} onClick={() => setConfirm(true)}>{copy.removeFriend}</button>}
    </div>
    {confirm && <div className="button-row" role="group" aria-label={copy.confirmRemoveFriend}>
      <button type="button" className="secondary" disabled={disabled} onClick={() => setConfirm(false)}>{copy.cancel}</button>
      <button type="button" disabled={disabled} onClick={() => { void remove(friend.id).then(success => { if (!success) setConfirm(false); }); }}>{copy.removeFriend}</button>
    </div>}
  </article>;
}

export function WeChatSettings({ api, locale }: { api?: WeChatChannelAPI | undefined; locale: ResolvedLocale }): JSX.Element {
  const inbox = window.deskpet?.wechatInbox;
  const digests = window.deskpet?.wechatDigests;
  const followup = window.deskpet?.wechatFollowup;
  const copy = locale === 'zh-CN' ? zh : en;
  const [state, setState] = useState<WeChatChannelState | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [notice, setNotice] = useState<Notice | RecoveryNotice | null>(null);
  const [section, setSection] = useState<'reply' | 'digests' | 'inbox'>('reply');
  const [friends, setFriends] = useState<WeChatReplyFriend[] | null>(null);
  const [friendLoadFailed, setFriendLoadFailed] = useState(false);
  const [friendReload, setFriendReload] = useState(0);
  const request = useRef(0);
  const friendMutation = useRef(0);
  const updating = useRef(false);
  const refreshing = useRef(false);

  const refresh = useCallback(async (showNotice = false) => {
    if (!api || updating.current || refreshing.current) return;
    const current = ++request.current;
    refreshing.current = true;
    try {
      const next = await api.getState();
      if (request.current !== current) return;
      setState(next);
      setError(previous => previous === 'loadError' ? null : previous);
      if (showNotice) setNotice('refreshed');
    } catch {
      if (request.current === current) {
        setError('loadError');
        setNotice(null);
      }
    } finally {
      if (request.current === current) refreshing.current = false;
    }
  }, [api]);

  const invalidateRequests = useCallback(() => {
    request.current++;
    refreshing.current = false;
    updating.current = false;
  }, []);

  useEffect(() => {
    void refresh();
    if (!api) return;
    const timer = setInterval(() => void refresh(), statusIntervalMs);
    return () => {
      clearInterval(timer);
      invalidateRequests();
    };
  }, [api, invalidateRequests, refresh]);

  const loadFriends = state?.friendReplySupported === true && section === 'reply';
  useEffect(() => {
    if (!api || !loadFriends) return;
    let current = true;
    const version = friendMutation.current;
    setFriendLoadFailed(false);
    void api.getReplyFriends().then(value => { if (current && friendMutation.current === version) setFriends(value); }).catch(() => {
      if (current && friendMutation.current === version) { setFriends(null); setFriendLoadFailed(true); }
    });
    return () => { current = false; };
  }, [api, loadFriends, friendReload]);

  const update = async (action: Action, work: () => Promise<{ state?: WeChatChannelState; friends?: WeChatReplyFriend[]; notice?: Notice | RecoveryNotice }>): Promise<boolean> => {
    if (updating.current) return false;
    if (action === 'addFriend' || action === 'removeFriend') friendMutation.current++;
    const current = ++request.current;
    updating.current = true;
    refreshing.current = false;
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const next = await work();
      if (request.current !== current) return false;
      if (next.state) setState(next.state);
      if (next.friends) setFriends(next.friends);
      if (next.notice) setNotice(next.notice);
      return true;
    } catch (cause) {
      if (request.current !== current) return false;
      const code = cause instanceof Error ? /\bwechat\.([a-z]+)\b/iu.exec(cause.message)?.[1] : undefined;
      const selectionError = (action === 'addGroup' || action === 'addFriend') && code && Object.hasOwn(selectionErrors, code)
        ? selectionErrors[code as keyof typeof selectionErrors][action] : null;
      const addError = selectionError || (action === 'addGroup' && (code === 'groupUnverified' ? 'groupPickerBindError' : code === 'groupNotFound' ? 'groupPickerNotFound' : null));
      setError(addError || (code && Object.hasOwn(actionErrors, code) ? actionErrors[code as keyof typeof actionErrors] : actionFallback[action]));
      return false;
    } finally {
      if (request.current === current) {
        updating.current = false;
        setBusy(null);
      }
    }
  };

  const privateStatus = statusLabel(state?.privateStatus ?? null, copy);
  const upgradeRequired = state?.groupStatus === 'worker_upgrade_required';
  const groups = state?.groups ?? [];
  const canBind = state?.groupBindingSupported && (state.paused || state.state === 'stopped') && !upgradeRequired;
  const canPrepareBind = state?.groupBindingSupported && !upgradeRequired && !state.paused && state.state !== 'stopped';
  const isRecoveryWarning = notice !== null && ['recoveryLogin', 'recoveryAmbiguous', 'recoveryLayout', 'recoveryTray', 'recoveryNotConfirmed'].includes(notice);

  return <section className="wechat-settings" aria-label={copy.title}>
    <h2>{copy.title}</h2>
    {error && <p className="error-banner" role="alert">{copy[error]}</p>}
    {notice && notice !== 'bindReady' && <p role={isRecoveryWarning ? 'alert' : 'status'} className={isRecoveryWarning ? 'error-banner' : undefined}>{copy[notice]}</p>}
    {(!api || state?.configured === false) && <p>{copy.unavailable}</p>}
    {api && !state && !error && <p role="status">{copy.loading}</p>}
    {api && state?.configured && <>
      <dl className="wechat-status">
        <dt>{copy.status}</dt><dd>{copy[state.state]}{state.stale && <> · {copy.stale}</>}</dd>
        {privateStatus && <><dt>{copy.private}</dt><dd>{privateStatus}</dd></>}
        <dt>{copy.pending}</dt><dd>{state.pending}</dd>
        <dt>{copy.uncertain}</dt><dd>{state.uncertain}</dd>
      </dl>
      {state.uncertain > 0 && <p className="muted">{copy.uncertainHelp}</p>}
      <div className="button-row">
        <button type="button" className="secondary" disabled={busy !== null} onClick={() => void refresh(true)}>{copy.refresh}</button>
        <button type="button" className="secondary" disabled={busy !== null} onClick={() => void update(state.paused ? 'resume' : 'pause', async () => ({ state: await api.setPaused(!state.paused) }))}>
          {busy === 'pause' ? copy.pausing : busy === 'resume' ? copy.resuming : state.paused ? copy.resume : copy.pause}
        </button>
        <button type="button" className="secondary" disabled={busy !== null} onClick={() => void update('open', async () => {
          await api.openVirtualMachine();
          return {};
        })}>{busy === 'open' ? copy.openingVm : copy.openVm}</button>
        <button type="button" className="secondary" disabled={busy !== null} onClick={() => void update('recover', async () => {
          const result = await api.recoverWindow();
          return { notice: recoveryLabels[result.outcome] ?? 'recoveryNotConfirmed' };
        })}>{busy === 'recover' ? copy.recovering : copy.recover}</button>
      </div>
      <div className="memory-tabs" role="tablist">{(['reply', 'digests', 'inbox'] as const)
        .filter(id => id === 'reply' || (id === 'digests' ? digests || followup : inbox))
        .map(id => <button key={id} type="button" role="tab" aria-selected={section === id} onClick={() => setSection(id)}>{copy.sections[id]}</button>)}</div>
      {section === 'reply' && <>
      <section className="wechat-policy wechat-groups" aria-label={copy.groupsTitle}>
        <h3>{copy.groupsTitle}</h3>
        {upgradeRequired && <p className="error-banner" role="alert">{copy.upgradeRequired}</p>}
        {groups.map(group => <GroupPolicyForm key={group.id} group={group} copy={copy} disabled={busy !== null || upgradeRequired} busy={busy}
          canRemove={busy === null && state.groupBindingSupported && !upgradeRequired}
          save={policy => update('save', async () => ({ state: await api.configureGroup({ groupId: group.id, policy }), notice: 'saved' }))}
          remove={() => update('remove', async () => ({ state: await api.removeGroup(group.id), notice: 'groupRemoved' }))} />)}
        {groups.length === 0 && <p className="muted">{state.groupName || copy.noGroups}</p>}
        <p className="muted">{copy.changeHelp}</p>
        {state.replyTargetBindingSupported ? <ReplyTargetPicker load={api.listReplyGroups}
          copy={{ title: copy.groupPicker, add: copy.groupPickerAdd, binding: copy.groupPickerBusy, loading: copy.groupPickerLoading,
            empty: copy.groupPickerEmpty, error: copy.groupPickerError, refresh: copy.groupPickerRefresh, limit: copy.groupLimitError }} disabled={busy !== null || upgradeRequired}
          binding={busy === 'addGroup'} busy={busy !== null} revision={groups.map(group => group.id).join(',')}
          limitReached={groups.length >= WECHAT_REPLY_GROUP_LIMIT}
          add={id => update('addGroup', async () => ({ state: await api.addReplyGroup(id), notice: 'groupPickerAdded' }))} />
          : state.groupBindingSupported && <p className="muted">{copy.groupPickerUnsupported}</p>}
        {state.groupBindingSupported ? <p className="muted" id="wechat-bind-help">{copy.bindGroupHelp}</p>
          : !upgradeRequired && <p className="muted" id="wechat-bind-help">{copy.bindUnsupported}</p>}
        {notice === 'bindReady' && <p role="status">{copy.bindReady}</p>}
        {canPrepareBind && <button type="button" className="secondary" aria-describedby="wechat-bind-help" disabled={busy !== null}
          onClick={() => void update('pause', async () => ({ state: await api.setPaused(true), notice: 'bindReady' }))}>
          {busy === 'pause' ? copy.pausing : copy.prepareBind}
        </button>}
        <button type="button" className="secondary" aria-describedby={!upgradeRequired ? 'wechat-bind-help' : undefined} disabled={busy !== null || !canBind}
          onClick={() => void update('bind', async () => ({ state: await api.bindSelectedGroup(), notice: 'groupAdded' }))}>
          {busy === 'bind' ? copy.bindingGroup : copy.bindGroup}
        </button>
      </section>
      {state.friendReplySupported && <section className="wechat-policy wechat-groups" aria-label={copy.friendsTitle}>
        <h3>{copy.friendsTitle}</h3>
        <p className="muted">{copy.friendHelp}</p>
        {friendLoadFailed && <>
          <p role="status" className="inline-error">{copy.friendsLoadError}</p>
          <div><button type="button" className="secondary" disabled={busy !== null} onClick={() => setFriendReload(value => value + 1)}>{copy.friendsRefresh}</button></div>
        </>}
        {friends?.length === 0 && <p className="muted">{copy.noFriends}</p>}
        {friends?.map(friend => <ReplyFriendRow key={friend.id} friend={friend} copy={copy} disabled={busy !== null || upgradeRequired}
          remove={id => update('removeFriend', async () => ({ friends: await api.removeReplyFriend(id), notice: 'friendRemoved' }))} />)}
        <ReplyTargetPicker load={api.listReplyFriends}
          copy={{ title: copy.friendPicker, add: copy.groupPickerAdd, binding: copy.friendPickerBusy, loading: copy.friendPickerLoading,
            empty: copy.friendPickerEmpty, error: copy.friendPickerError, refresh: copy.friendPickerRefresh, limit: copy.friendLimitError }}
          disabled={busy !== null || upgradeRequired || friends === null} binding={busy === 'addFriend'} busy={busy !== null}
          revision={friends?.map(friend => friend.id).join(',') ?? ''} limitReached={(friends?.length ?? 0) >= WECHAT_REPLY_FRIEND_LIMIT}
          add={id => update('addFriend', async () => ({ friends: await api.addReplyFriend(id), notice: 'friendPickerAdded' }))} />
      </section>}
      <WeChatCloudSettingsPanel api={api} groups={groups} friends={state.friendReplySupported ? friends ?? [] : []}
        localModel={state.reply.model} locale={locale} disabled={busy !== null || upgradeRequired} />
      <ReplySettings api={api} copy={copy} reply={state.reply} busy={busy} disabled={busy !== null || upgradeRequired}
        save={value => update('reply', async () => ({ state: await api.configureReply(value), notice: 'replySaved' }))} />
      <p className="muted">{copy.memoryHelp}</p>
      <p className="muted">{copy.commandsHelp}</p>
      <p className="muted">{copy.stickerCommandsHelp}</p>
      </>}
      {section === 'digests' && <>
        {digests && <WeChatGroupDigestSettings api={digests} locale={locale} disabled={busy !== null || upgradeRequired} />}
        {followup && <WeChatFollowupSettingsPanel api={followup} locale={locale} disabled={busy !== null || upgradeRequired} />}
        {digests && <>
          <WeChatOfficialBriefSettingsPanel api={digests} locale={locale} disabled={busy !== null || upgradeRequired} />
          <WeChatFriendsMomentsSettingsPanel api={digests} locale={locale} disabled={busy !== null || upgradeRequired} />
        </>}
      </>}
      {section === 'inbox' && inbox && <WeChatInboxExportSettings api={inbox} locale={locale} />}
    </>}
    {api && (!state || !state.configured) && <button type="button" className="secondary" onClick={() => void refresh(true)}>{copy.refresh}</button>}
  </section>;
}
