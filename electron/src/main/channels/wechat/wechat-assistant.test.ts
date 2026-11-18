// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from '../../domain/chat-service';
import { DomainRepository } from '../../domain/repository';
import { channelPermitsTool, WECHAT_CRON_CAPABILITIES, WECHAT_GROUP_WEB_CALL_LIMIT, WECHAT_TOOLS } from '../../security/channel-policy';
import { assertSessionChannel, parseChannelContext } from '../../security/execution-context';
import type { ChannelContext } from '../../security/execution-context';
import { WECHAT_ASSISTANT_REPLY_LIMIT, WECHAT_GROUP_REPLY_LIMIT, wechatAssistantDeliveryId, wechatAssistantText, wechatScheduledReplyText } from './wechat-assistant';
import { wechatAssistantSessionIds, WeChatTranscript } from './wechat-transcript';

const binding = 'a'.repeat(64);
const roots: string[] = [];
const vault = { getVaultKey: async () => Buffer.alloc(32, 71) };

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-wechat-assistant-')); roots.push(root);
  const value = new DomainRepository(join(root, 'profile.enc.json'), vault);
  await value.initialize();
  return value;
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('WeChat assistant text', () => {
  it.each([
    ['官网在这儿 https://deskpet.example/', 'https://deskpet.example/'],
    ['可以去[下载页](https://deskpet.example/download)取最新安装包。', 'https://deskpet.example/download'],
  ])('keeps a link in an ordinary reply while hiding it in a scheduled delivery: %s', (reply, url) => {
    expect(wechatAssistantText(reply, 'zh-CN')).toContain(url);
    expect(wechatScheduledReplyText(`[sticker:none] ${reply}`, 'zh-CN')).not.toMatch(/https?:|\[sticker:/u);
  });

  it('turns a Markdown answer into one printable line', () => {
    const text = wechatAssistantText('## 明早天气\n\n- **晴**，18°C\n- 见 [天气网](https://weather.example/today)\n\n```\ncode\n```', 'zh-CN');
    expect(text).toBe('明早天气 · 晴，18°C · 见 天气网 https://weather.example/today code');
    expect(text).not.toMatch(/[\n\r\u2028\u200b]/u);
    expect(wechatAssistantText('a\u200bb\u3000c\u2028d', 'en')).toBe('ab cd');
    expect(wechatAssistantText('\n\n', 'zh-CN')).toBe('');
  });

  it('keeps long answers within the listener history limit, at a sentence when possible', () => {
    const long = '第一句很长。'.repeat(120);
    const text = wechatAssistantText(long, 'zh-CN');
    expect([...text].length).toBeLessThanOrEqual(WECHAT_ASSISTANT_REPLY_LIMIT);
    expect(text).toMatch(/。…（完整回复在桌宠里）$/u);
    const unbroken = wechatAssistantText('x'.repeat(2_000), 'en');
    expect([...unbroken].length).toBeLessThanOrEqual(WECHAT_ASSISTANT_REPLY_LIMIT);
    expect(unbroken.endsWith('… (full reply in DeskPet)')).toBe(true);
  });

  it('derives stable conversation candidates and delivery identities', () => {
    const ids = wechatAssistantSessionIds(binding);
    expect(ids).toHaveLength(64);
    expect(new Set(ids).size).toBe(64);
    expect(wechatAssistantSessionIds(binding)).toEqual(ids);
    expect(wechatAssistantSessionIds('b'.repeat(64))[0]).not.toBe(ids[0]);
    expect(() => wechatAssistantSessionIds('not a digest')).toThrow();
    expect(wechatAssistantDeliveryId('run')).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe('WeChat assistant conversation', () => {
  it('creates one owner conversation, reuses it, and moves on when it is archived', async () => {
    const repo = await repository();
    const chat = new ChatService(repo);
    const ids = wechatAssistantSessionIds(binding);
    const first = await chat.ensureSession(ids, '微信私聊助手');
    expect(first).toMatchObject({ id: ids[0], title: '微信私聊助手', kind: 'normal', historyPrivacy: 'cloud-allowed' });
    expect(first.channelBindingId).toBeUndefined();
    expect((await chat.ensureSession(ids, 'ignored')).id).toBe(ids[0]);
    await repo.transaction(state => { state.chatSessions.find(item => item.id === ids[0])!.archivedAt = new Date().toISOString(); });
    expect((await chat.ensureSession(ids, '微信私聊助手')).id).toBe(ids[1]);
    await chat.addMessage({ sessionId: ids[1]!, role: 'user', content: '你好', status: 'complete', errorCode: null });
  });

  it('never adopts a channel-bound or transcript conversation', async () => {
    const repo = await repository();
    const chat = new ChatService(repo);
    const [id] = wechatAssistantSessionIds(binding);
    await repo.transaction(state => {
      state.chatSessions.push({ id: id!, title: 'bound', kind: 'normal', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        channelBindingId: '542bd3df-7376-4dd0-8d3e-0500d0ef8c09' });
    });
    await expect(chat.ensureSession([id!], 'x')).rejects.toThrow('chat.sessionUnavailable');
  });

  it('acknowledges transcript entries already in the assistant conversation without importing them', async () => {
    const repo = await repository();
    const handled = 'c'.repeat(64), other = 'd'.repeat(64);
    const entry = { binding, scope: 'private', title: 'Owner', role: 'user', text: '已由助手记录', at: null };
    const source = {
      readTranscript: vi.fn(async (): Promise<unknown> => ({ version: 1, more: false, entries: [
        { ...entry, id: handled }, { ...entry, id: handled, role: 'assistant', text: '助手回复' }, { ...entry, id: other, text: '指令记录' },
      ] })),
      acknowledgeTranscript: vi.fn<(input: object) => Promise<unknown>>(async () => ({ ok: true })),
    };
    const sync = new WeChatTranscript(repo, source, { available: () => true, locale: () => 'zh-CN', changed: () => undefined,
      skip: item => item.scope === 'private' && item.id === handled });
    await sync.sync();
    expect(repo.snapshot().chatMessages.map(message => message.content)).toEqual(['指令记录']);
    expect(source.acknowledgeTranscript).toHaveBeenCalledWith({ version: 1, entries: [
      { id: handled, role: 'user' }, { id: handled, role: 'assistant' }, { id: other, role: 'user' },
    ] });
  });
});

describe('WeChat channel ceiling', () => {
  const channel: ChannelContext = { origin: 'wechat', binding, sessionId: wechatAssistantSessionIds(binding)[0]!, memories: 'all' };

  it('permits research, task records, recurring tasks and approved vault tools in the owner chat', () => {
    for (const tool of WECHAT_TOOLS) expect(channelPermitsTool(channel, tool)).toBe(true);
    for (const tool of ['workspace.read', 'workspace.write', 'shell.run', 'history.read', 'skills.read', 'notification.send',
      'system.summary', 'timer.create', 'mcp.c_12345678_tool', 'vm.shell']) expect(channelPermitsTool(channel, tool)).toBe(false);
    for (const capability of ['workspace.write', 'notes.read', 'notes.write']) {
      expect(WECHAT_CRON_CAPABILITIES).not.toContain(capability);
    }
  });

  it('round-trips and rejects malformed or bound WeChat contexts', () => {
    expect(parseChannelContext(JSON.parse(JSON.stringify(channel)))).toEqual(channel);
    expect(() => parseChannelContext({ ...channel, binding: 'short' })).toThrow('channel.contextInvalid');
    expect(() => parseChannelContext({ ...channel, memories: 'everything' })).toThrow('channel.contextInvalid');
    expect(() => assertSessionChannel(undefined, channel)).not.toThrow();
    expect(() => assertSessionChannel('542bd3df-7376-4dd0-8d3e-0500d0ef8c09', channel)).toThrow('wechat.sessionOriginMismatch');
  });
});

describe('WeChat group mode', () => {
  const base = { origin: 'wechat' as const, binding, sessionId: wechatAssistantSessionIds(binding)[0]!, memories: 'selected' as const };

  it('gives a group only time and arithmetic, plus public web where the owner allowed it', () => {
    const closed: ChannelContext = { ...base, group: { id: 'legacy', web: false } };
    const open: ChannelContext = { ...base, group: { id: 'a'.repeat(32), web: true } };
    for (const tool of ['time.current', 'math.calculate']) expect([channelPermitsTool(closed, tool), channelPermitsTool(open, tool)]).toEqual([true, true]);
    for (const tool of ['web.search', 'web.read']) expect([channelPermitsTool(closed, tool), channelPermitsTool(open, tool)]).toEqual([false, true]);
    for (const tool of ['cron.create', 'cron.list', 'task.update', 'moments.propose', 'workspace.read', 'notes.read', 'shell.run'])
      expect(channelPermitsTool(open, tool)).toBe(false);
    expect(WECHAT_GROUP_WEB_CALL_LIMIT).toBe(3);
    expect(parseChannelContext(JSON.parse(JSON.stringify(open)))).toEqual(open);
    expect(() => parseChannelContext({ ...base, group: { id: 'bad', web: true } })).toThrow('channel.contextInvalid');
    expect(() => parseChannelContext({ ...base, group: { id: 'legacy' } })).toThrow('channel.contextInvalid');
  });

  it('keeps a group reply short', () => {
    const text = wechatAssistantText('今天天气不错。'.repeat(60), 'zh-CN', WECHAT_GROUP_REPLY_LIMIT);
    expect([...text].length).toBeLessThanOrEqual(WECHAT_GROUP_REPLY_LIMIT);
  });
});
