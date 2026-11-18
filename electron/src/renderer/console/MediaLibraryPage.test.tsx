import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../shared';
import { defaultMediaSettings } from '../../shared/media';
import type { MediaAPI, MediaAsset, MediaSettings } from '../../shared/media';
import type { WeChatChannelState } from '../../shared/wechat-channel';
import { MediaLibraryPage } from './MediaLibraryPage';

const asset = (n = 1, title = '开心挥手', tags = ['开心', '问候']): MediaAsset => ({
  id: n.toString(16).padStart(64, '0'), sha256: n.toString(16).padStart(64, '0'), title, tags, enabled: true, allowQq: false,
  mime: 'image/png', extension: 'png', bytes: 100, width: 1000, height: 1000, source: { kind: 'imported', name: 'fixture.png' },
  createdAt: '2026-11-06T12:00:00.000Z', updatedAt: '2026-11-06T12:00:00.000Z', deletedAt: null, lastUsedAt: null, useCount: 0,
});
const providers: ProviderConfig[] = ['gpt-6.1-terra', 'gpt-6.1-sol'].map((model, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`, kind: 'openai', name: `OpenAI ${i}`, model, enabled: true,
  baseUrl: 'https://api.openai.com/v1', supportsTools: true, secretState: 'configured',
}));
const fixture = (initial = [asset(), asset(2, '晚安小猫', ['晚安', '休息'])]) => {
  let assets = initial, settings: MediaSettings = defaultMediaSettings();
  const snapshot = vi.fn<MediaAPI['snapshot']>(async () => structuredClone({ assets, settings }));
  const update = vi.fn<MediaAPI['update']>(async input => {
    const previous = assets.find(item => item.id === input.id)!;
    const value = { ...previous, title: input.title ?? previous.title, tags: input.tags ?? previous.tags, enabled: input.enabled ?? previous.enabled, allowQq: input.allowQq ?? previous.allowQq };
    assets = assets.map(item => item.id === value.id ? value : item); return value;
  });
  const remove = vi.fn<MediaAPI['remove']>(async id => { assets = assets.map(item => item.id === id ? { ...item, deletedAt: '2026-11-06T13:00:00.000Z' } : item); });
  const restore = vi.fn<MediaAPI['restore']>(async id => { const value = { ...assets.find(item => item.id === id)!, deletedAt: null }; assets = assets.map(item => item.id === id ? value : item); return value; });
  const configure = vi.fn<MediaAPI['configure']>(async input => { settings = input; return input; });
  const generated = { ...asset(3, '原创小猫', ['原创']), source: { kind: 'generated' as const, name: 'generated.png' } };
  const generate = vi.fn<MediaAPI['generate']>(async () => { assets = [...assets, generated]; return generated; });
  const attach = vi.fn<MediaAPI['attach']>(async () => undefined);
  const importImages = vi.fn<MediaAPI['importImages']>(async () => ({ imported: [], reused: 2, skipped: 0 }));
  const importFolder = vi.fn<MediaAPI['importFolder']>(async () => null);
  const api: MediaAPI = { snapshot, update, remove, restore, configure, generate, attach, importImages, importFolder };
  const onAttached = vi.fn();
  return { api, snapshot, update, remove, restore, configure, generate, attach, importImages, importFolder, generated, onAttached };
};
const show = (f: ReturnType<typeof fixture>) => render(<MediaLibraryPage api={f.api} providers={providers} locale="zh-CN" sessionId="current-session" onAttached={f.onAttached} />);
afterEach(cleanup);

describe('media library page', () => {
  it('searches titles and scene tags without generating or attaching pictures', async () => {
    const f = fixture(); show(f); await screen.findByRole('article', { name: '开心挥手' });
    expect(screen.getAllByRole('article')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('搜索图片或标签'), { target: { value: '休息' } });
    expect(screen.getAllByRole('article')).toHaveLength(1); expect(screen.getByRole('article', { name: '晚安小猫' })).toBeVisible();
    fireEvent.change(screen.getByLabelText('搜索图片或标签'), { target: { value: '开心挥手' } });
    expect(screen.getByRole('article', { name: '开心挥手' })).toBeVisible(); expect(f.generate).not.toHaveBeenCalled(); expect(f.attach).not.toHaveBeenCalled();
  });

  it('saves a title, deduplicated tags and permissions then removes and restores the same image', async () => {
    const f = fixture([asset()]); show(f); const card = await screen.findByRole('article', { name: '开心挥手' });
    fireEvent.click(within(card).getByRole('button', { name: '编辑图片信息' }));
    const editor = screen.getByRole('form', { name: '编辑图片信息' });
    fireEvent.change(within(editor).getByLabelText('图片名称'), { target: { value: '收到啦' } });
    fireEvent.change(within(editor).getByLabelText('场景标签'), { target: { value: '收到，确认,收到' } });
    fireEvent.click(within(editor).getByLabelText('参与自动配图')); fireEvent.click(within(editor).getByLabelText('允许 QQ 回复使用这张图片'));
    fireEvent.click(within(editor).getByRole('button', { name: '保存图片信息' }));
    const renamed = await screen.findByRole('article', { name: '收到啦' });
    expect(f.update).toHaveBeenCalledExactlyOnceWith({ id: asset().id, title: '收到啦', tags: ['收到', '确认'], enabled: false, allowQq: true });
    expect(within(renamed).getByRole('button', { name: '放入当前对话' })).toBeEnabled(); expect(within(renamed).getByText(/仅手动选择/)).toBeVisible();
    fireEvent.click(within(renamed).getByRole('button', { name: '移入回收站' }));
    await waitFor(() => expect(screen.queryByRole('article')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '回收站 1' }));
    fireEvent.click(within(screen.getByRole('article', { name: '收到啦' })).getByRole('button', { name: '恢复图片' }));
    await waitFor(() => expect(f.restore).toHaveBeenCalledExactlyOnceWith(asset().id));
    await waitFor(() => expect(screen.getByRole('button', { name: '图库 1' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '图库 1' })); expect(screen.getByRole('article', { name: '收到啦' })).toBeVisible();
  });

  it('grants WeChat permissions only to the owner and selected enrolled groups', async () => {
    const f = fixture([asset()]);
    const state: WeChatChannelState = {
      configured: true, groupName: '测试群', state: 'running', stale: false, paused: false,
      privateStatus: 'ready', groupStatus: 'ready', pending: 0, uncertain: 0,
      groupPolicy: { mode: 'mentions', sender: null }, groupBindingSupported: true,
      groups: [
        { id: 'legacy', title: '测试群', policy: { mode: 'mentions', sender: null }, status: 'ready', pending: 0, uncertain: 0 },
        { id: 'a'.repeat(32), title: '另一个群', policy: { mode: 'off', sender: null }, status: 'ready', pending: 0, uncertain: 0 },
      ],
      reply: { model: 'qwen3.5:0.8b', split: false, stickers: true },
    };
    render(<MediaLibraryPage api={f.api} wechat={{ getState: async () => state }} providers={providers} locale="zh-CN"
      sessionId="current-session" onAttached={f.onAttached} />);
    const card = await screen.findByRole('article', { name: '开心挥手' });
    fireEvent.click(within(card).getByRole('button', { name: '编辑图片信息' }));
    fireEvent.click(await screen.findByLabelText('允许微信群「测试群」使用这张图片'));
    expect(screen.getByLabelText('允许微信群「另一个群」使用这张图片')).not.toBeChecked();
    expect(screen.getByLabelText('允许微信主号私聊使用这张图片')).not.toBeChecked();
    fireEvent.click(screen.getByLabelText('允许微信主号私聊使用这张图片'));
    fireEvent.click(screen.getByRole('button', { name: '保存图片信息' }));
    await waitFor(() => expect(f.update).toHaveBeenCalledWith(expect.objectContaining({
      allowQq: false, allowWechat: true, allowWechatGroups: ['legacy'],
    })));
  });

  it('attaches only the selected image to the current conversation and reports completion', async () => {
    const f = fixture(); show(f); const card = await screen.findByRole('article', { name: '晚安小猫' });
    fireEvent.click(within(card).getByRole('button', { name: '放入当前对话' }));
    await waitFor(() => expect(f.onAttached).toHaveBeenCalledOnce());
    expect(f.attach).toHaveBeenCalledExactlyOnceWith({ sessionId: 'current-session', assetId: asset(2).id }); expect(f.generate).not.toHaveBeenCalled();
  });

  it('opens native import pickers only after explicit import actions and handles cancellation', async () => {
    const f = fixture(); show(f); await screen.findByRole('article', { name: '开心挥手' });
    expect(f.importImages).not.toHaveBeenCalled(); expect(f.importFolder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '导入图片' }));
    expect(await screen.findByText('已导入 0 张，复用 2 张，跳过 0 个文件。')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '导入文件夹' }));
    await waitFor(() => expect(f.importFolder).toHaveBeenCalledOnce()); await waitFor(() => expect(screen.getByRole('button', { name: '导入图片' })).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps generation explicit, defaults to the saved sol service and blocks duplicate submission', async () => {
    const f = fixture(); let resolve: ((value: MediaAsset) => void) | undefined;
    f.generate.mockImplementation(() => new Promise(value => { resolve = value; })); show(f);
    const prompt = await screen.findByLabelText('想生成什么图片');
    expect(screen.getByLabelText(/^图片生成使用的模型服务/u)).toHaveValue(providers[1]!.id);
    expect(screen.getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(expect.arrayContaining(['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2']));
    fireEvent.change(prompt, { target: { value: ' 原创小猫挥手，中文“收到啦” ' } }); expect(f.generate).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: '生成一张并收藏' }); fireEvent.click(button); fireEvent.click(button);
    expect(f.generate).toHaveBeenCalledExactlyOnceWith({ providerId: providers[1]!.id, model: 'gpt-image-2', prompt: '原创小猫挥手，中文“收到啦”' });
    expect(button).toBeDisabled(); expect(screen.getByText('正在生成一张图片并收藏，请稍候…')).toBeVisible();
    await act(async () => { resolve!(f.generated); });
    expect(await screen.findByText('图片已生成并收藏到图库。')).toBeVisible(); expect(button).toBeEnabled();
    expect(screen.getByText(/这个按钮只按文字生成，不会上传图库素材/)).toBeVisible();
    expect(screen.getByText(/标签为「角色参考」的图片，会把它作为参考图一起发送/u)).toBeVisible();
  });

  it('saves owner-controlled automatic reply settings without generating an image', async () => {
    const f = fixture(); show(f); fireEvent.click(await screen.findByLabelText('桌面回复按场景配图'));
    fireEvent.click(screen.getByLabelText('QQ 回复按场景配图'));
    fireEvent.change(screen.getByLabelText('自动配图最短间隔（秒）'), { target: { value: '600' } });
    fireEvent.click(screen.getByRole('button', { name: '保存图库设置' }));
    await waitFor(() => expect(f.configure).toHaveBeenCalledExactlyOnceWith({ ...defaultMediaSettings(), providerId: providers[1]!.id, autoReplyDesktop: true, autoReplyQq: true, cooldownSeconds: 600 }));
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('shows a bounded error and preserves existing cards after failure', async () => {
    const f = fixture(); f.generate.mockRejectedValueOnce(new Error('media.providerUnavailable SECRET_MUST_NOT_RENDER')); show(f);
    fireEvent.change(await screen.findByLabelText('想生成什么图片'), { target: { value: 'original cat' } });
    fireEvent.click(screen.getByRole('button', { name: '生成一张并收藏' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('请选择已启用且保存了凭据的 OpenAI 服务。');
    expect(screen.getByRole('article', { name: '开心挥手' })).toBeVisible(); expect(screen.queryByText(/SECRET_MUST_NOT_RENDER/)).not.toBeInTheDocument();
  });

  it('batch-grants WeChat, group and auto-reply use plus tags to the searched images only, and can revoke them', async () => {
    const f = fixture([asset(), asset(2, '晚安小猫', ['晚安']), asset(3, '风景', ['风景'])]);
    const state: WeChatChannelState = {
      configured: true, groupName: '测试群', state: 'running', stale: false, paused: false,
      privateStatus: 'ready', groupStatus: 'ready', pending: 0, uncertain: 0,
      groupPolicy: { mode: 'mentions', sender: null }, groupBindingSupported: true,
      groups: [{ id: 'legacy', title: '测试群', policy: { mode: 'mentions', sender: null }, status: 'ready', pending: 0, uncertain: 0 }],
      reply: { model: 'qwen3.5:0.8b', split: false, stickers: true },
    };
    render(<MediaLibraryPage api={f.api} wechat={{ getState: async () => state }} providers={providers} locale="zh-CN"
      sessionId="current-session" onAttached={f.onAttached} />);
    await screen.findByRole('article', { name: '风景' });
    fireEvent.change(screen.getByLabelText('搜索图片或标签'), { target: { value: '小猫' } });
    fireEvent.change(screen.getByLabelText('搜索图片或标签'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('搜索图片或标签'), { target: { value: '晚安' } });
    fireEvent.click(screen.getByRole('button', { name: '批量设置这 1 张' }));
    const panel = screen.getByRole('region', { name: '批量设置图片' });
    const grant = within(panel).getByRole('button', { name: '对这 1 张打开勾选项' });
    expect(grant).toBeDisabled();
    fireEvent.click(within(panel).getByLabelText('微信主号私聊使用'));
    fireEvent.click(await within(panel).findByLabelText('微信群「测试群」使用'));
    fireEvent.change(within(panel).getByLabelText('同时追加标签'), { target: { value: '睡觉，晚安' } });
    fireEvent.click(grant);
    await screen.findByText('已设置 1 张图片。');
    expect(f.update).toHaveBeenCalledExactlyOnceWith({ id: asset(2).id, allowWechat: true, allowWechatGroups: ['legacy'], tags: ['晚安', '睡觉'] });

    fireEvent.change(screen.getByLabelText('搜索图片或标签'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '批量设置这 3 张' }));
    const all = screen.getByRole('region', { name: '批量设置图片' });
    fireEvent.click(within(all).getByLabelText('QQ 回复使用'));
    fireEvent.click(within(all).getByRole('button', { name: '对这 3 张取消勾选项' }));
    await screen.findByText('已取消 3 张图片。');
    expect(f.update.mock.calls.slice(1).map(([input]) => input)).toEqual([asset(1), asset(2), asset(3)].map(({ id }) => ({ id, allowQq: false })));
  });

  it('marks an unsupported saved image model and will not save it until a listed one is chosen', async () => {
    const f = fixture([asset()]);
    await f.api.configure({ ...defaultMediaSettings(), providerId: providers[1]!.id, model: 'gpt-image-2.6' });
    show(f); await screen.findByRole('article', { name: '开心挥手' });
    const model = screen.getByLabelText('图像模型');
    expect(model).toHaveValue('gpt-image-2.6');
    expect(screen.getByRole('option', { name: /gpt-image-2\.6（不受支持，请重新选择）/u })).toBeInTheDocument();
    const save = screen.getByRole('button', { name: '保存图库设置' });
    expect(save).toBeDisabled();
    fireEvent.change(model, { target: { value: 'gpt-image-2.6-sunburst' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(f.configure).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'gpt-image-2.6-sunburst' })));
  });

  it('opens the batch panel above the image grid', async () => {
    const f = fixture(); show(f); await screen.findByRole('article', { name: '开心挥手' });
    fireEvent.click(screen.getByRole('button', { name: '批量设置这 2 张' }));
    const panel = screen.getByRole('region', { name: '批量设置图片' });
    const firstCard = screen.getAllByRole('article')[0]!;
    // 4 = DOCUMENT_POSITION_FOLLOWING: the first card comes after the panel.
    expect(panel.compareDocumentPosition(firstCard) & 4).toBeTruthy();
  });

  it('tolerates an older preload without a media API', () => {
    render(<MediaLibraryPage api={undefined} providers={[]} locale="zh-CN" sessionId="" onAttached={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('当前窗口尚未提供图库功能'); expect(screen.queryByRole('button', { name: '导入图片' })).not.toBeInTheDocument();
  });
});
