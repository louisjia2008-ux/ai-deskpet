// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EncryptedJsonStore } from '../../persistence/encrypted-json-store';
import type { readWeChatArticle } from './wechat-article-reader';
import { defaultWeChatArticleState, wechatArticleStateSchema } from './wechat-article-state';
import { WeChatArticles } from './wechat-articles';
import type { WeChatArticleBriefOptions, WeChatArticleGuard, WeChatArticleModelInput } from './wechat-articles';

const owner = 'a'.repeat(64);
const formerOwner = 'b'.repeat(64);
const title = '一篇版式实验记录';
const account = '版式实验室';
const url = 'https://mp.weixin.qq.com/s/?__biz=Fixture%3D%3D&mid=100&idx=1&sn=PublicSignature&chksm=PublicChecksum';
const body = '研究者先把标题与人物摆进独立的区域，再让模型生成插图。保持布局的一组实验保留了更多文字细节。';
const summary = '版式实验先锁定标题与人物的位置，再生成插图，结果保留了更多文字细节。';
const source = { status: 'ok', url, title, account, body, truncated: false, hasImages: true } as const;
const roots: string[] = [];
const vault = { getVaultKey: async () => Buffer.alloc(32, 83) };
const event = (text: string, tag = text, binding = owner) => ({ binding, text, eventId: createHash('sha256').update(tag).digest('hex') });
const card = (tag = 'article-card') => ({
  ...event(url, tag), article: { url, title: '分享卡片标题', account: '卡片上的公众号名' },
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-wechat-articles-'));
  roots.push(root);
  const path = join(root, 'managed', 'wechat-articles.enc.json');
  const host = {
    read: vi.fn<typeof readWeChatArticle>(async () => source),
    complete: vi.fn<(binding: string, input: WeChatArticleModelInput, guard: WeChatArticleGuard) => Promise<string>>(async () => summary),
  };
  const guard = { signal: new AbortController().signal, assertCurrent: vi.fn(async () => undefined) };
  const reopen = () => new WeChatArticles(path, vault, host);
  const snapshot = () => new EncryptedJsonStore({
    path, vault, schema: wechatArticleStateSchema, defaultValue: defaultWeChatArticleState,
  }).readPersisted();
  return { path, snapshot, reopen, host, guard, service: reopen() };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('reads and summarizes an authorized article, then saves and retrieves it after explicit selection and profile reload', async () => {
  const f = await fixture();
  const received = card();
  const reply = await f.service.receive(received, f.guard);
  expect(reply).toContain(`《${title}》 · ${account}`);
  expect(reply).toContain(summary);
  expect(reply).toContain('要存进收件箱吗？回「存一下」');
  for (const option of ['「收藏」', '「继续聊」', '「先放着」']) expect(reply).toContain(option);
  expect((await f.snapshot())?.favorites).toEqual([]);
  expect(f.host.read).toHaveBeenCalledExactlyOnceWith(url, f.guard.signal);
  expect(f.host.complete).toHaveBeenCalledExactlyOnceWith(owner, { title, account, body, partial: false }, f.guard);

  const serviceAfterReceive = f.reopen();
  await expect(serviceAfterReceive.receive(received, f.guard)).resolves.toBe(reply);
  const latestInbox = await serviceAfterReceive.inboxLatest(owner, received.eventId);
  expect(latestInbox).toEqual({
    kind: 'article', title, source: account, url, summary, at: 0, legacyId: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  await expect(serviceAfterReceive.inboxLatest(owner, 'c'.repeat(64))).resolves.toBeNull();
  await expect(serviceAfterReceive.inboxLatest(formerOwner)).resolves.toBeNull();
  expect(f.host.complete).toHaveBeenCalledOnce();

  const save = event('收藏', 'save-choice');
  const receipt = await serviceAfterReceive.handle(save, f.guard);
  expect(receipt).toContain(`已收藏《${title}》`);
  const serviceAfterSave = f.reopen();
  await expect(serviceAfterSave.handle(save, f.guard)).resolves.toBe(receipt);
  await expect(serviceAfterSave.handle(event('收藏这篇', 'another-save'), f.guard)).resolves.toContain('已经在收藏里');
  expect((await f.snapshot())?.favorites).toEqual([
    expect.objectContaining({ binding: owner, title, account, url, overview: summary }),
  ]);

  const list = await serviceAfterSave.handle(event('收藏列表'), f.guard);
  expect(list).toContain(title);
  const id = list?.match(/\b[a-f0-9]{12}\b/u)?.[0];
  expect(id).toBeDefined();
  expect(latestInbox!.legacyId.slice(0, 12)).toBe(id);
  await expect(serviceAfterSave.inboxLegacy(owner)).resolves.toEqual([latestInbox]);
  await expect(serviceAfterSave.inboxLegacy(formerOwner)).resolves.toEqual([]);
  const opened = await serviceAfterSave.handle(event(`打开收藏 ${id!}`), f.guard);
  for (const field of [title, summary, url]) expect(opened).toContain(field);
  await expect(serviceAfterSave.handle(event('收藏列表', 'other-binding-list', formerOwner), f.guard)).resolves.toContain('还没有收藏');
  expect(await readFile(f.path, 'utf8')).not.toContain(title);
});

it('re-reads the article to answer a follow-up and leaves the collection empty', async () => {
  const f = await fixture();
  await f.service.receive(card(), f.guard);
  await expect(f.service.handle(event('继续聊'), f.guard)).resolves.toContain('用「问文章」');
  const updatedBody = '复查实验记载显示，测试组锁定版面，并直接检查标题的错字数量。';
  const answer = '实验通过检查错字数量来评估版面保留效果。';
  f.host.read.mockResolvedValueOnce({ ...source, body: updatedBody });
  f.host.complete.mockResolvedValueOnce(answer);
  await expect(f.service.handle(event('问文章 实验怎么评价结果？'), f.guard)).resolves.toBe(answer);
  expect(f.host.read).toHaveBeenCalledTimes(2);
  expect(f.host.complete).toHaveBeenLastCalledWith(owner, {
    title, account, body: updatedBody, partial: false, question: '实验怎么评价结果？',
  }, f.guard);
  expect((await f.snapshot())?.favorites).toEqual([]);
});

it('remembers a decision to leave the current article for now without adding it to the collection', async () => {
  const f = await fixture();
  await f.service.receive(card(), f.guard);
  const defer = event('先放着');
  const reply = await f.service.handle(defer, f.guard);
  expect(reply).toContain(`《${title}》先放着`);
  const service = f.reopen();
  await expect(service.handle(defer, f.guard)).resolves.toBe(reply);
  await expect(service.inboxLatest(owner)).resolves.toBeNull();
  await expect(service.handle(event('收藏'), f.guard)).resolves.toContain('没有待处理的文章');
  expect((await f.snapshot())?.favorites).toEqual([]);
});

it('reports verification without asking the model to invent an overview or saving a previous article by mistake', async () => {
  const f = await fixture();
  await f.service.receive(card(), f.guard);
  f.host.read.mockResolvedValueOnce({ status: 'verification-required' });
  const reply = await f.service.receive(card('second-forward'), f.guard);
  expect(reply).toContain('微信要求完成访问验证');
  expect(reply).toContain('没读到正文');
  expect(reply).not.toContain(summary);
  expect(f.host.complete).toHaveBeenCalledTimes(1);
  await expect(f.service.handle(event('收藏'), f.guard)).resolves.toContain('没有待处理的文章');
  expect((await f.snapshot())?.favorites).toEqual([]);
});

it('tells the owner when a long article was summarized from selected passages', async () => {
  const f = await fixture();
  const opening = '开头段落讨论字体选择。';
  const closing = '结尾段落指出研究样本有限。';
  f.host.read.mockResolvedValueOnce({ ...source, body: opening + '甲'.repeat(4000) + closing });
  await expect(f.service.receive(card(), f.guard)).resolves.toContain('根据可读的部分正文');
  const evidence = f.host.complete.mock.calls[0]?.[1];
  expect(evidence).toMatchObject({ title, account, partial: true });
  expect(evidence?.body.length).toBeLessThanOrEqual(3000);
  expect(evidence?.body.startsWith(opening)).toBe(true);
  expect(evidence?.body.endsWith(closing)).toBe(true);
});

it('does not send article evidence to a model after its request loses authorization', async () => {
  const f = await fixture();
  f.guard.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('request no longer authorized'));
  await expect(f.service.receive(card(), f.guard)).rejects.toThrow('request no longer authorized');
  expect(f.host.read).toHaveBeenCalledOnce();
  expect(f.host.complete).not.toHaveBeenCalled();
  await expect(f.snapshot()).resolves.toBeNull();
});

it('uses the separately supplied briefing route and does not write a legacy article or favorite', async () => {
  const f = await fixture();
  const complete = vi.fn<WeChatArticleBriefOptions['complete']>(async () =>
    summary + ' 实验记录还描述了对比条件。');
  const article = { ...card().article, url: url + '&scene=fixture' };
  const result = await f.service.brief(article, { complete }, f.guard);
  expect(result).toMatchObject({ url, title, summary: expect.stringContaining(summary) });
  expect(f.host.read).toHaveBeenCalledExactlyOnceWith(url, f.guard.signal);
  expect(f.host.complete).not.toHaveBeenCalled();
  expect(complete.mock.calls[0]?.[0]).toContain('两三句简报摘要');
  expect(JSON.parse(complete.mock.calls[0]![1])).toEqual({ body, title, account, partial: false });
  await expect(f.snapshot()).resolves.toBeNull();

  const question = '对比条件是什么？';
  await f.service.brief(article, { complete, question }, f.guard);
  expect(JSON.parse(complete.mock.calls[1]![1])).toMatchObject({ question });
  expect(complete.mock.calls[1]![0]).toContain('question 字段');
});

it('does not call the briefing model after revocation during article reading', async () => {
  const f = await fixture();
  const complete = vi.fn(async () => summary);
  f.guard.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('request no longer authorized'));
  await expect(f.service.brief(card().article, { complete }, f.guard)).rejects.toThrow('request no longer authorized');
  expect(complete).not.toHaveBeenCalled();
  expect(f.host.complete).not.toHaveBeenCalled();
});
