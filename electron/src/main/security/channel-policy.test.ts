import { describe, expect, it } from 'vitest';

import { ToolFailure } from '../runtime/tool-failure';
import { assertChannelToolPermitted, channelPermitsTool, intersectQqCronCapabilities, QQ_ALLOWED_TOOLS, QQ_CRON_CAPABILITIES, QqWebBudget } from './channel-policy';
import { DESKTOP_CHANNEL, directChatCommandsAllowed, isQqChannel, parseChannelContext, qqChannel } from './execution-context';

describe('channel execution context', () => {
  it('creates a qq context with policy version 2', () => {
    const context = qqChannel({ bindingId: 'binding-1', senderId: 'openid-1' });
    expect(isQqChannel(context)).toBe(true);
    expect(context).toMatchObject({ origin: 'qq', policyVersion: 2 });
    expect(parseChannelContext(context)).toEqual(context);
  });

  it('round-trips a scheduled qq context', () => {
    const context = qqChannel({ bindingId: 'binding-1', senderId: 'openid-1', scheduleId: '6f1c0a30-9364-4c8d-a5c2-8a48a50ee7d6' });
    expect(parseChannelContext(JSON.parse(JSON.stringify(context)))).toEqual(context);
  });

  it('accepts the desktop default and rejects malformed stored values', () => {
    expect(parseChannelContext({ origin: 'desktop' })).toEqual(DESKTOP_CHANNEL);
    expect(() => parseChannelContext(null)).toThrow('channel.contextInvalid');
    expect(() => parseChannelContext({ origin: 'qq' })).toThrow('channel.contextInvalid');
    expect(() => parseChannelContext({ origin: 'qq', kind: 'qq', policyVersion: 3, bindingId: 'b', senderId: 's' })).toThrow('channel.contextInvalid');
    expect(() => parseChannelContext({ origin: 'qq', kind: 'qq', policyVersion: 1, bindingId: '', senderId: 's' })).toThrow('channel.contextInvalid');
    expect(() => parseChannelContext({ origin: 'wechat' })).toThrow('channel.contextInvalid');
  });

  it('disables direct host-command shortcuts for qq runs', () => {
    expect(directChatCommandsAllowed(DESKTOP_CHANNEL)).toBe(true);
    expect(directChatCommandsAllowed(qqChannel({ bindingId: 'b', senderId: 's' }))).toBe(false);
  });
});

describe('qq channel policy', () => {
  it('permits exactly the reviewed allowlist', () => {
    for (const toolId of QQ_ALLOWED_TOOLS) expect(channelPermitsTool(qqChannel({ bindingId: 'b', senderId: 's' }), toolId)).toBe(true);
  });

  it('denies local, system, history, timer and unknown tools', () => {
    const context = qqChannel({ bindingId: 'b', senderId: 's' });
    for (const toolId of ['workspace.list', 'workspace.read', 'workspace.write', 'workspace.search', 'system.summary', 'notification.send', 'timer.create', 'history.search', 'history.read', 'shell.exec', 'computer.control', 'cron.restart']) {
      expect(channelPermitsTool(context, toolId)).toBe(false);
    }
  });

  it('throws a localized tool failure outside the allowlist', () => {
    expect(() => assertChannelToolPermitted(qqChannel({ bindingId: 'b', senderId: 's' }), 'workspace.write')).toThrowError(ToolFailure);
    expect(() => assertChannelToolPermitted(qqChannel({ bindingId: 'b', senderId: 's' }), 'workspace.write')).toThrowError('tool.channelBlocked');
  });

  it('does not restrict desktop runs by the qq ceiling', () => {
    for (const toolId of ['workspace.write', 'system.summary', 'history.read', 'shell.exec']) expect(channelPermitsTool(DESKTOP_CHANNEL, toolId)).toBe(true);
    expect(() => assertChannelToolPermitted(DESKTOP_CHANNEL, 'workspace.write')).not.toThrow();
  });

  it('intersects cron capabilities with the qq ceiling and drops workspace.write', () => {
    expect(intersectQqCronCapabilities(['web.search', 'workspace.write', 'notes.read', 'notes.write', 'time.read'])).toEqual(['web.search', 'time.read']);
    expect(intersectQqCronCapabilities(['workspace.write'])).toEqual([]);
    expect(intersectQqCronCapabilities(QQ_CRON_CAPABILITIES)).toEqual(QQ_CRON_CAPABILITIES);
  });

  it('enforces the per-run qq web budget host-side', () => {
    const budget = new QqWebBudget();
    const run = 'run-a';
    expect(budget.consume(run, 'math.calculate', 2)).toBe(true); // never counted
    expect(budget.consume(run, 'web.search', 2)).toBe(true);
    expect(budget.consume(run, 'web.read', 2)).toBe(true);
    expect(budget.consume(run, 'web.read', 2)).toBe(false); // over limit
    expect(budget.consume('run-b', 'web.search', 2)).toBe(true); // isolated per run
    budget.release(run);
    expect(budget.consume(run, 'web.search', 2)).toBe(true); // released resets
  });
});

it('limits a QQ group to read-only research', () => {
  const group = qqChannel({ bindingId: 'b', senderId: 'group:g1', authorityId: 'a' });
  for (const toolId of ['time.current', 'math.calculate', 'web.search', 'web.read']) expect(channelPermitsTool(group, toolId)).toBe(true);
  for (const toolId of ['task.update', 'task.list', 'cron.create', 'cron.list', 'workspace.read', 'workspace.write', 'history.search']) expect(channelPermitsTool(group, toolId)).toBe(false);
});


describe('paired Telegram execution context', () => {
  const context = parseChannelContext({ origin:'telegram', bindingId:'binding', userId:'sender'.repeat(200), chatId:'chat'.repeat(100), memoryAllowed:false });
  it('accepts owner platform IDs and exposes workspace and task tools within the channel ceiling', () => {
    expect(directChatCommandsAllowed(context)).toBe(false);
    for (const id of ['web.search','task.list','workspace.read','workspace.write']) expect(channelPermitsTool(context,id)).toBe(true);
    for (const id of ['shell.run','cron.create','permission.grant','credential.get','history.search','system.summary']) expect(channelPermitsTool(context,id)).toBe(false);
  });
});

it('declares notes only in interactive private remote channels', () => {
  const ownerQq = qqChannel({ bindingId: 'b', senderId: 'owner', authorityId: 'a' });
  const groupQq = qqChannel({ bindingId: 'b', senderId: 'group:g', authorityId: 'a' });
  const scheduledQq = qqChannel({ bindingId: 'b', senderId: 'owner', authorityId: 'a', scheduleId: 's' });
  const ownerWeChat = parseChannelContext({ origin: 'wechat', binding: 'b'.repeat(64), sessionId: 's', memories: 'selected' });
  const groupWeChat = parseChannelContext({ ...ownerWeChat, group: { id: 'a'.repeat(32), web: true } });
  const telegram = parseChannelContext({ origin: 'telegram', bindingId: 'b', chatId: 'c', userId: 'u', memoryAllowed: false });
  for (const id of ['notes.search', 'notes.read', 'notes.save']) {
    for (const channel of [ownerQq, ownerWeChat, telegram]) expect(channelPermitsTool(channel, id)).toBe(true);
    for (const channel of [groupQq, scheduledQq, groupWeChat]) expect(channelPermitsTool(channel, id)).toBe(false);
  }
});
