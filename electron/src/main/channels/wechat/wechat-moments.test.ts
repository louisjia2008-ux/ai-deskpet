// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { classifyMomentAnswer, momentText, WECHAT_MOMENT_TTL_MS, WeChatMoments } from './wechat-moments';
import type { MomentAnswerContext, WeChatMomentsHost, WeChatMomentsState } from './wechat-moments';

const asset = 'a'.repeat(64);
const adjacent = async () => 'next' as const;
const later = async () => 'later' as const;

function fixture(options: { enabled?: boolean; post?: WeChatMomentsHost['post']; now?: number } = {}) {
  let stored: WeChatMomentsState | null = null;
  let now = options.now ?? Date.parse('2026-11-14T16:30:00.000Z'); // 00:30 in Shanghai
  const host = {
    read: vi.fn(async () => stored ? JSON.stringify(stored) : null),
    write: vi.fn(async (value: WeChatMomentsState) => { stored = structuredClone(value); }),
    enabled: vi.fn(async () => options.enabled ?? true),
    now: () => now,
    timezone: () => 'Asia/Shanghai',
    compose: vi.fn<WeChatMomentsHost['compose']>(async () => ({ text: '今天降温了\n在家里裹着毯子打游戏 ❄️', imageIdea: 'She is wrapped in a blanket playing a game by the window.' })),
    draw: vi.fn(async () => ({ assetId: asset })),
    image: vi.fn(async () => ({ full: Buffer.from('full'), preview: Buffer.from('preview') })),
    preview: vi.fn<WeChatMomentsHost['preview']>(async () => 'sent'),
    post: vi.fn<WeChatMomentsHost['post']>(options.post ?? (async () => 'posted')),
    notify: vi.fn(async () => undefined),
    record: vi.fn(async () => undefined),
    wait: vi.fn(async () => undefined),
  } satisfies WeChatMomentsHost;
  const moments = new WeChatMoments(host);
  return { host, moments, stored: () => stored, setNow: (value: number) => { now = value; } };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('WeChat Moments', () => {
  it('previews a draft with its picture and posts only after the owner says so', async () => {
    const f = fixture();
    const result = await f.moments.propose({ text: '  今天降温了\r\n\r\n\r\n好冷  ', imageIdea: 'She shivers in the snow.' });
    expect(result).toMatchObject({ status: 'preview_sent', id: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(f.host.preview).toHaveBeenCalledWith({ id: result.id, text: expect.stringContaining('今天降温了 / 好冷'), image: Buffer.from('preview') });
    expect(f.host.preview.mock.calls[0]![0].text).toContain('可以跟我说');
    expect(f.host.post).not.toHaveBeenCalled();
    expect(f.stored()!.draft).toMatchObject({ text: '今天降温了\n\n好冷', status: 'awaiting', imageAssetId: asset });
    expect(f.host.record).toHaveBeenCalledWith(expect.stringContaining('（朋友圈草稿）今天降温了'));

    expect(await f.moments.answer('今天吃什么', adjacent)).toBeNull();
    expect(await f.moments.answer('发', later)).toMatch(/去发|这就|发啦/u);
    await flush(); await flush();
    expect(f.host.post).toHaveBeenCalledWith({ id: result.id, text: '今天降温了\n\n好冷', visibility: 'all', images: [Buffer.from('full')] });
    expect(f.stored()!.draft!.status).toBe('posted');
    expect(f.stored()!.posted).toEqual([{ id: result.id, text: '今天降温了\n\n好冷', at: expect.any(Number) }]);
    expect(f.host.notify).toHaveBeenCalledWith(expect.stringMatching(/发好|发出去|发到朋友圈/u));
    expect(await f.moments.answer('发', later)).toBeNull();
  });

  it('honours "only me", rejection and expiry', async () => {
    const f = fixture();
    await f.moments.propose({ text: '测试', imageIdea: 'idea' });
    expect(await f.moments.answer('发，仅自己可见', later)).toContain('仅自己可见');
    await flush(); await flush();
    expect(f.host.post).toHaveBeenLastCalledWith(expect.objectContaining({ visibility: 'private' }));

    await f.moments.propose({ text: '第二条', imageIdea: 'idea' });
    expect(await f.moments.answer('不发了', adjacent)).toContain('不发');
    expect(f.stored()!.draft!.status).toBe('discarded');

    await f.moments.propose({ text: '第三条', imageIdea: 'idea' });
    f.setNow(Date.parse('2026-11-14T16:30:00.000Z') + WECHAT_MOMENT_TTL_MS + 1);
    expect(await f.moments.answer('发吧', later)).toMatch(/超过一天/u);
    expect(f.stored()!.draft!.status).toBe('expired');
    expect(f.host.post).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['busy', 'wechat.momentWindowBusy', '微信窗口还被其他操作占着', 1],
    ['paused', 'wechat.momentListenerPaused', '微信监听已暂停', 12],
    ['window_error', 'wechat.momentWindowError', '打开微信窗口时出了错', 12],
  ] as const)('reports %s distinctly and keeps failure/preview consent rules', async (status, code, reason, attempts) => {
    const f = fixture({ post: async () => status });
    await f.moments.propose({ text: '合成草稿', imageIdea: 'synthetic idea' });
    await f.moments.answer('发', adjacent);
    await vi.waitFor(() => expect(f.host.notify).toHaveBeenCalledWith(expect.stringContaining(reason)));
    expect(f.host.notify).toHaveBeenCalledWith(expect.stringContaining('草稿已经作废'));
    expect(f.host.post).toHaveBeenCalledTimes(attempts);
    expect(f.stored()!.draft!.status).toBe('failed');
    expect(f.moments.lastError).toBe(code);

    f.host.preview.mockResolvedValue(status);
    const preview = await f.moments.propose({ text: '没有收到的预览', imageIdea: 'synthetic idea' });
    expect(preview).toMatchObject({ status: 'preview_unconfirmed', reason: expect.stringContaining(reason) });
    expect(await f.moments.answer('发', adjacent)).toContain(reason);
    expect(f.stored()!.draft).toMatchObject({ status: 'awaiting' });
    expect(f.stored()!.draft!.previewedAt).toBeUndefined();
    expect(f.host.post).toHaveBeenCalledTimes(attempts);
    expect(f.moments.lastError).toBe(code);
  });

  it('never retries an unconfirmed post', async () => {
    const unsure = fixture({ post: async () => 'uncertain' });
    await unsure.moments.propose({ text: '不确定', imageIdea: 'idea' });
    await unsure.moments.answer('发', adjacent);
    await vi.waitFor(() => expect(unsure.host.notify).toHaveBeenCalledWith(expect.stringMatching(/没能确认/u)));
    expect(unsure.host.post).toHaveBeenCalledOnce();
    expect(unsure.stored()!.draft!.status).toBe('uncertain');
  });

  it('drafts at most once a day after the planned time, and only when enabled', async () => {
    const off = fixture({ enabled: false });
    await off.moments.tick();
    expect(off.host.compose).not.toHaveBeenCalled();

    const f = fixture();
    await f.moments.tick();
    const plan = f.stored()!.plan!;
    expect(plan.date).toBe('2026-11-15');
    f.setNow(plan.at - 1);
    await f.moments.tick();
    expect(f.host.compose).not.toHaveBeenCalled();
    f.setNow(plan.at + 1);
    await f.moments.tick();
    expect(f.host.compose).toHaveBeenCalledOnce();
    expect(f.host.compose).toHaveBeenCalledWith({ date: '2026-11-15', recent: [] });
    await f.moments.tick();
    expect(f.host.compose).toHaveBeenCalledOnce();
  });

  it('waits an hour after a failed daily draft instead of retrying every tick', async () => {
    const f = fixture();
    f.host.compose.mockRejectedValueOnce(new Error('model down'));
    await f.moments.tick();
    f.setNow(f.stored()!.plan!.at + 1);
    await expect(f.moments.tick()).rejects.toThrow('model down');
    await f.moments.tick();
    expect(f.host.compose).toHaveBeenCalledOnce();
  });

  it.each([true, false])('asks the compose model to shorten an overlong daily draft exactly once (accepted: %s)', async accepted => {
    const f = fixture();
    const long = '长'.repeat(450);
    f.host.compose.mockResolvedValueOnce({ text: long, imageIdea: 'idea' }).mockResolvedValueOnce({ text: accepted ? '短'.repeat(300) : long, imageIdea: 'idea' });
    await f.moments.tick();
    f.setNow(f.stored()!.plan!.at + 1);
    if (accepted) await f.moments.tick();
    else await expect(f.moments.tick()).rejects.toThrow('wechat.momentInvalid');
    expect(f.host.compose).toHaveBeenCalledTimes(2);
    expect(f.host.compose).toHaveBeenLastCalledWith({ date: '2026-11-15', recent: [], shorten: long });
    expect(f.host.preview).toHaveBeenCalledTimes(accepted ? 1 : 0);
    if (accepted) expect(f.host.preview.mock.calls[0]![0].text).toContain('短'.repeat(300));
  });

  it('keeps post text printable with line breaks only', () => {
    expect(momentText('a​\tb\r\n\r\n\r\nc d')).toBe('ab\n\ncd');
  });
});

describe('closed natural-language Moments consent', () => {
  it.each(['发吧', '可以', '好呀', '行', '发', '嗯发', '好', '好的', '发布', '发出去', '可以发', '就这样发', '发！', '发。', ' post ', '好,发吧'])('allows an explicit yes: %s', text => {
    expect(classifyMomentAnswer(text, true)).toBe('all');
  });
  it.each(['发什么', '发了吗', '你觉得呢', '可以吗', '好？', '不发了', '算了', '别发', '不要', '发不发', '不可以', '还没说发', '发给谁', '如果行就发', '随便你', '嗯？', '不要发吧', '发之前再改改'])('never treats ambiguity or refusal as consent: %s', text => {
    expect(classifyMomentAnswer(text, true)).not.toBe('all');
    expect(classifyMomentAnswer(text, true)).not.toBe('private');
  });
  it.each(['只给我看', '仅自己可见', '别让别人看到', '发，仅自己可见'])('restricts visibility: %s', text => {
    expect(classifyMomentAnswer(text, true)).toBe('private');
  });
  it('asks once instead of posting on a question and rewrites before a new approval', async () => {
    const f = fixture();
    const rewrite = vi.fn(async () => ({ text: '新的短草稿', imageIdea: 'idea' }));
    const intro = vi.fn(async () => '我挑好配图啦，帮我看看嘛。');
    const moments = new WeChatMoments({ ...f.host, rewrite, previewIntro: intro });
    await moments.propose({ text: '原来的草稿', imageIdea: 'idea' });
    const first = f.stored()!.draft!.id;
    expect(await moments.answer('发了吗', adjacent)).toContain('还没发');
    expect(f.host.post).not.toHaveBeenCalled();
    expect(await moments.answer('短一点', later)).toBeNull();
    expect(await moments.answer('草稿短一点', later)).toContain('等你点头');
    expect(f.stored()!.draft!.id).not.toBe(first);
    expect(f.stored()!.draft!.text).toBe('新的短草稿');
    expect(f.host.post).not.toHaveBeenCalled();
    expect(f.host.preview.mock.calls[1]![0].text).not.toContain('可以跟我说');
    await moments.answer('只给我看', adjacent);
    await vi.waitFor(() => expect(f.host.post).toHaveBeenCalledWith(expect.objectContaining({ text: '新的短草稿', visibility: 'private' })));
  });
  it.each(['今天好累', '不想上课', '帮我看看这道题', '把闹钟改成7点', '官网地址发我', '头发怎么绑', '你觉得呢', '可以吗', '好？', '随便你'])('leaves ordinary private chat alone: %s', async text => {
    const f = fixture();
    await f.moments.propose({ text: '一片落叶', imageIdea: 'idea' });
    expect(await f.moments.answer(text, adjacent)).toBeNull();
    expect(await f.moments.answer(text, later)).toBeNull();
    expect(f.host.post).not.toHaveBeenCalled();
  });
  it.each(['好', '可以', '行', '嗯'])('accepts %s only as the next turn within two hours', async text => {
    const f = fixture();
    await f.moments.propose({ text: '一片落叶', imageIdea: 'idea' });
    const previewedAt = f.stored()!.draft!.previewedAt!;
    expect(await f.moments.answer('今天好累', adjacent)).toBeNull();
    expect(await f.moments.answer(text, later)).toBeNull();
    f.setNow(previewedAt + 3 * 3_600_000);
    expect(await f.moments.answer(text, adjacent)).toBeNull();
    expect(f.host.post).not.toHaveBeenCalled();
    f.setNow(previewedAt + 2 * 3_600_000);
    expect(await f.moments.answer(text, adjacent)).toMatch(/去发|这就|发啦/u);
    await vi.waitFor(() => expect(f.host.post).toHaveBeenCalledOnce());
  });
  it('never treats an old queued message or unconfirmed preview as consent', async () => {
    const f = fixture();
    const before = async (): Promise<MomentAnswerContext> => 'before-preview';
    await f.moments.propose({ text: '收到过预览', imageIdea: 'idea' });
    expect(await f.moments.answer('发', before)).toBeNull();
    f.host.preview.mockResolvedValueOnce('uncertain');
    await f.moments.propose({ text: '预览没有确认', imageIdea: 'idea' });
    const first = f.stored()!.draft!;
    // Consent to an unseen preview resends that same draft under a new delivery id; it never posts.
    expect(await f.moments.answer('今天好累', adjacent)).toBeNull();
    expect(await f.moments.answer('发', adjacent)).toContain('重新发了一遍');
    const resent = f.stored()!.draft!;
    expect(resent).toMatchObject({ text: '预览没有确认', imageAssetId: first.imageAssetId, status: 'awaiting' });
    expect(resent.id).not.toBe(first.id);
    expect(resent.previewedAt).toBeDefined();
    expect(f.host.draw).toHaveBeenCalledTimes(2);
    expect(f.host.post).not.toHaveBeenCalled();
    await f.moments.answer('发', adjacent);
    await vi.waitFor(() => expect(f.host.post).toHaveBeenCalledOnce());
  });
  it('keeps an unseen preview unposted when resending it fails, and lets the owner drop it', async () => {
    const f = fixture();
    f.host.preview.mockResolvedValueOnce('uncertain').mockResolvedValueOnce('uncertain');
    await f.moments.propose({ text: '两次都没确认', imageIdea: 'idea' });
    expect(await f.moments.answer('发', adjacent)).toContain('先不发');
    expect(f.stored()!.draft).toMatchObject({ status: 'awaiting' });
    expect(f.stored()!.draft!.previewedAt).toBeUndefined();
    expect(await f.moments.answer('不发', adjacent)).not.toBeNull();
    expect(f.stored()!.draft!.status).toBe('discarded');
    expect(f.host.post).not.toHaveBeenCalled();
  });
  it('lets even consent-shaped private chat through while drawing a preview', async () => {
    const f = fixture();
    let finishDrawing!: () => void;
    f.host.draw.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finishDrawing = resolve; });
      return { assetId: asset };
    });
    const draft = f.moments.propose({ text: '一片落叶', imageIdea: 'idea' });
    await vi.waitFor(() => expect(f.host.draw).toHaveBeenCalledOnce());
    expect(await f.moments.answer('今天好累', adjacent)).toBeNull();
    expect(await f.moments.answer('发', adjacent)).toBeNull();
    finishDrawing();
    await draft;
    expect(f.host.post).not.toHaveBeenCalled();
  });
  it('rotates fallback lines without repeating the previous line and reports model failure', async () => {
    const f = fixture();
    const moments = new WeChatMoments({ ...f.host, previewIntro: async () => { throw new Error('offline'); } });
    await moments.propose({ text: '草稿', imageIdea: 'idea' });
    await moments.propose({ text: '草稿', imageIdea: 'idea' });
    const notices = f.host.preview.mock.calls.map(([value]) => value.text.split(' 草稿')[0]);
    expect(notices[0]).not.toBe(notices[1]);
    expect(moments.lastError).toBe('wechat.momentPreviewFallback');
  });
});
