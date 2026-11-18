/** Host-owned execution origin for every agent run.
 *
 * A channel context is created by host code (IPC entry points, the QQ channel
 * service, or the cron executor) and is persisted alongside durable work. It is
 * never derived from message text, model output, tool arguments, or web content.
 * A run without a recorded channel context is treated as desktop-only; stored
 * contexts are re-validated on read and rejected when malformed.
 */

import { QQ_CHANNEL_POLICY_VERSION, qqGroupIdFromSender } from '../../shared/qq-channel';

export type RequestOrigin = 'desktop' | 'qq' | 'telegram' | 'wechat';

export interface QqChannelRef {
  kind: 'qq';
  bindingId: string;
  senderId: string;
  policyVersion: typeof QQ_CHANNEL_POLICY_VERSION;
  /** Live host authority stamp. Legacy contexts without it cannot execute. */
  authorityId?: string;
  /** Present when this run was started by an approved recurring task. */
  scheduleId?: string;
}

export interface TelegramChannelRef {
  origin: 'telegram'; bindingId: string; chatId: string; userId: string; memoryAllowed: boolean;
}
/** The owner's bound WeChat private chat. `binding` is the listener's owner
 * binding digest; `sessionId` is the one host-derived assistant conversation. */
export interface WeChatChannelRef {
  origin: 'wechat'; binding: string; sessionId: string; memories: 'all' | 'selected';
  /** A bound group: members are not the owner. `web` is the owner's per-group switch. */
  group?: { id: string; web: boolean };
}
export type ChannelContext = { origin: 'desktop' } | ({ origin: 'qq' } & QqChannelRef) | TelegramChannelRef | WeChatChannelRef;

export const DESKTOP_CHANNEL: ChannelContext = { origin: 'desktop' };

export const qqChannel = (input: { bindingId: string; senderId: string; scheduleId?: string; authorityId?: string }): ChannelContext => ({
  origin: 'qq',
  kind: 'qq',
  bindingId: input.bindingId,
  senderId: input.senderId,
  policyVersion: QQ_CHANNEL_POLICY_VERSION,
  ...(input.authorityId === undefined ? {} : { authorityId: input.authorityId }),
  ...(input.scheduleId === undefined ? {} : { scheduleId: input.scheduleId }),
});

/** A group's sender is the group itself, so any member's text runs under this ceiling. */
export const isQqGroupChannel = (context: ChannelContext | undefined | null): boolean =>
  isQqChannel(context) && qqGroupIdFromSender(context.senderId) !== null;

export const isQqChannel = (context: ChannelContext | undefined | null): context is { origin: 'qq' } & QqChannelRef =>
  context !== null && context !== undefined && context.origin === 'qq' && context.kind === 'qq' && context.policyVersion === QQ_CHANNEL_POLICY_VERSION;

/** Hosts must separately assert the live channel authority before using this scope. WeChat friend replies do not enter this execution path. */
export const isOwnerDiaryChannel = (context: ChannelContext): boolean => context.origin === 'desktop'
  || (context.origin === 'wechat' && !context.group)
  || (isQqChannel(context) && !!context.authorityId && !isQqGroupChannel(context));

/** Fail closed on malformed persisted values; unknown future versions are not desktop. */
export const parseChannelContext = (raw: unknown): ChannelContext => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('channel.contextInvalid');
  const value = raw as Record<string, unknown>;
  if (value.origin === 'desktop') return DESKTOP_CHANNEL;
  if (value.origin === 'telegram' && typeof value.bindingId === 'string' && value.bindingId.length > 0
    && typeof value.chatId === 'string' && value.chatId.length > 0 && typeof value.userId === 'string' && value.userId.length > 0
    && typeof value.memoryAllowed === 'boolean') {
    return { origin: 'telegram', bindingId: value.bindingId, chatId: value.chatId, userId: value.userId, memoryAllowed: value.memoryAllowed };
  }
  if (value.origin === 'wechat' && typeof value.binding === 'string' && /^[a-f0-9]{64}$/u.test(value.binding)
    && typeof value.sessionId === 'string' && value.sessionId.length > 0 && value.sessionId.length <= 128
    && (value.memories === 'all' || value.memories === 'selected')) {
    const group = value.group as { id?: unknown; web?: unknown } | undefined;
    if (group !== undefined && (typeof group !== 'object' || group === null || typeof group.id !== 'string'
      || !/^(?:legacy|[a-f0-9]{32})$/u.test(group.id) || typeof group.web !== 'boolean')) throw new Error('channel.contextInvalid');
    return { origin: 'wechat', binding: value.binding, sessionId: value.sessionId, memories: value.memories,
      ...(group ? { group: { id: group.id as string, web: group.web as boolean } } : {}) };
  }
  if (value.origin === 'qq' && value.kind === 'qq' && value.policyVersion === QQ_CHANNEL_POLICY_VERSION
    && typeof value.bindingId === 'string' && value.bindingId.length > 0 && value.bindingId.length <= 128
    && typeof value.senderId === 'string' && value.senderId.length > 0
    && (value.authorityId === undefined || (typeof value.authorityId === 'string' && value.authorityId.length > 0 && value.authorityId.length <= 128))
    && (value.scheduleId === undefined || (typeof value.scheduleId === 'string' && value.scheduleId.length > 0 && value.scheduleId.length <= 128))) {
    return qqChannel({ bindingId: value.bindingId, senderId: value.senderId, ...(value.authorityId === undefined ? {} : { authorityId: value.authorityId }), ...(value.scheduleId === undefined ? {} : { scheduleId: value.scheduleId }) });
  }
  throw new Error('channel.contextInvalid');
};

/** Direct host-command shortcuts (memory save/forget/edit, deterministic tool
 * commands) run only for desktop users. QQ text is never parsed as authority. */
export const directChatCommandsAllowed = (context: ChannelContext): boolean => context.origin === 'desktop';

/** A persisted QQ session cannot be upgraded by desktop send/retry entry points. */
export const assertSessionChannel = (bindingId: string | undefined, context: ChannelContext): void => {
  // The WeChat assistant conversation is an ordinary owner conversation that the
  // desktop may continue; the host checks the exact session separately.
  if (context.origin === 'wechat') {
    if (bindingId !== undefined) throw new Error('wechat.sessionOriginMismatch');
  } else if (context.origin === 'telegram') {
    if (bindingId !== context.bindingId) throw new Error('telegram.sessionOriginMismatch');
  } else if ((context.origin === 'desktop' && bindingId !== undefined) || (isQqChannel(context) && bindingId !== context.bindingId)) {
    throw new Error('qq.sessionOriginMismatch');
  }
};
