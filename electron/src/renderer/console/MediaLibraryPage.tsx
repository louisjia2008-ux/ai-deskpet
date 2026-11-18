import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ProviderConfig } from '../../shared';
import type { MediaAPI, MediaAsset, MediaSettings, MediaSnapshot } from '../../shared/media';
import type { WeChatChannelAPI, WeChatChannelState } from '../../shared/wechat-channel';
import { localMediaUrl } from './ChatImages';
import './media-library.css';

interface Props { api: MediaAPI | undefined; wechat?: Pick<WeChatChannelAPI, 'getState'>; providers: ProviderConfig[]; locale: string; sessionId: string; onAttached(): void }
interface EditDraft { id: string; title: string; tags: string; enabled: boolean; allowQq: boolean; allowWechat: boolean; allowWechatGroups: string[] }
interface BatchDraft { enabled: boolean; allowQq: boolean; allowWechat: boolean; groups: string[]; tags: string }
const emptyBatch = (): BatchDraft => ({ enabled: false, allowQq: false, allowWechat: false, groups: [], tags: '' });
const splitTags = (value: string): string[] => [...new Set(value.split(/[,，\n]/u).map(tag => tag.trim()).filter(tag => tag && [...tag].length <= 40))];
/** Words the WeChat and QQ sticker scenes look for in titles and tags. */
const IMAGE_MODELS: ReadonlyArray<readonly [string, string]> = [
  ['gpt-image-2.6-sunburst', 'gpt-image-2.6-sunburst（细致，支持参考图，推荐）'],
  ['gpt-image-2.6-flare', 'gpt-image-2.6-flare（更快）'],
  ['gpt-image-2', 'gpt-image-2'],
];
const SCENE_WORDS = '招手、问候、你好、中午、午安、晚安、睡觉、偷笑、大笑、笑哭、庆祝、开心、点赞、抱抱、安慰、谢谢、收到、明白、加油、鼓励、爱心、喜欢';
const errorText = (value: unknown): string => {
  const code = value instanceof Error ? value.message.match(/(?:media|provider)\.[A-Za-z]+/u)?.[0] : undefined;
  const copy: Record<string, string> = {
    'media.imageTooLarge': '图片过大，请选择不超过 16 MB 的图片。', 'media.invalidImage': '无法识别这张图片，请使用 PNG、JPEG、WebP 或 GIF。',
    'media.invalidDimensions': '图片尺寸超出支持范围。', 'media.importLimit': '文件过多，请分批导入。',
    'media.libraryFull': '图库已满，请先整理已有素材。', 'media.unavailable': '这张图片当前不可用，请刷新图库。',
    'media.providerUnavailable': '请选择已启用且保存了凭据的 OpenAI 服务。', 'media.invalidModel': '该图像模型暂不受支持，请核对模型名称。',
    'provider.authentication': '模型服务认证失败，请核对已保存的 API Key。', 'provider.quota': '模型服务额度或支出上限不足。',
    'provider.rateLimit': '模型服务暂时限流，请稍后重试。', 'provider.timeout': '图片生成超时，请稍后核对图库。',
  };
  return code && copy[code] ? copy[code] : '操作未完成，请刷新核对已保存状态后重试。';
};

export const MediaLibraryPage = ({ api, wechat, providers, locale, sessionId, onAttached }: Props): JSX.Element => {
  const [snapshot, setSnapshot] = useState<MediaSnapshot | null>(null), [settings, setSettings] = useState<MediaSettings | null>(null);
  const [search, setSearch] = useState(''), [trash, setTrash] = useState(false), [editor, setEditor] = useState<EditDraft | null>(null);
  const [prompt, setPrompt] = useState(''), [busy, setBusy] = useState<string | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [wechatState, setWechatState] = useState<WeChatChannelState | null>(null);
  const [batch, setBatch] = useState<BatchDraft | null>(null);
  const batchOpen = batch !== null;
  useEffect(() => { if (batchOpen) batchPanel.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); }, [batchOpen]);
  const alive = useRef(false), working = useRef(false), batchPanel = useRef<HTMLElement>(null);
  const refresh = useCallback(async (): Promise<void> => {
    if (!api) return;
    const value = await api.snapshot();
    if (alive.current) { setSnapshot(value); setSettings(previous => previous ?? value.settings); }
  }, [api]);
  const refreshWechat = useCallback((): void => {
    if (!wechat) return;
    void wechat.getState().then(value => { if (alive.current) setWechatState(value); })
      .catch(() => { if (alive.current) setWechatState(null); });
  }, [wechat]);
  useEffect(() => {
    alive.current = true;
    void refresh().catch(() => { if (alive.current) setError('暂时无法读取图库，请刷新重试。'); });
    refreshWechat();
    const stop = api?.onChanged?.(() => { void refresh().catch(() => { if (alive.current) setError('刷新未完成，之前的图库仍然保留。'); }); });
    return () => { alive.current = false; stop?.(); };
  }, [api, refresh, refreshWechat]);
  const perform = async (label: string, operation: () => Promise<string | void>): Promise<void> => {
    if (working.current || !api) return;
    working.current = true; setBusy(label); setError(''); setNotice('');
    try { const message = await operation(); await refresh(); if (alive.current && message) setNotice(message); }
    catch (cause) { if (alive.current) setError(errorText(cause)); }
    finally { working.current = false; if (alive.current) setBusy(null); }
  };
  const importImages = (folder: boolean): void => { void perform('import', async () => {
    const result = await (folder ? api!.importFolder() : api!.importImages());
    if (result) return `已导入 ${result.imported.length} 张，复用 ${result.reused} 张，跳过 ${result.skipped} 个文件。`;
    return undefined;
  }); };
  const selectedProviders = providers.filter(provider => provider.enabled && provider.kind === 'openai');
  const defaultProvider = selectedProviders.find(provider => provider.model === 'gpt-6.1-sol') ?? selectedProviders.at(-1);
  const providerId = settings?.providerId ?? defaultProvider?.id ?? '';
  const visible = snapshot?.assets.filter(asset => Boolean(asset.deletedAt) === trash && `${asset.title} ${asset.tags.join(' ')}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [];
  const allCount = snapshot?.assets.filter(asset => !asset.deletedAt).length ?? 0;
  const deletedCount = snapshot?.assets.filter(asset => asset.deletedAt).length ?? 0;
  const edit = (asset: MediaAsset): void => {
    refreshWechat();
    setEditor({ id: asset.id, title: asset.title, tags: asset.tags.join('，'), enabled: asset.enabled, allowQq: asset.allowQq,
      allowWechat: asset.allowWechat === true, allowWechatGroups: asset.allowWechatGroups ?? [] });
  };
  const saveEditor = (event: FormEvent): void => {
    event.preventDefault(); if (!editor) return;
    const saved = editor;
    void perform('edit', async () => {
      await api!.update({ id: saved.id, title: saved.title.trim(), tags: [...new Set(saved.tags.split(/[,，\n]/u).map(tag => tag.trim()).filter(Boolean))], enabled: saved.enabled, allowQq: saved.allowQq,
        ...(wechat ? { allowWechat: saved.allowWechat, allowWechatGroups: saved.allowWechatGroups } : {}) });
      if (alive.current) setEditor(null); return '图片信息已保存。';
    });
  };
  const batchTargets = trash ? [] : visible.filter(asset => !asset.deletedAt);
  const batchChosen = batch !== null && (batch.enabled || batch.allowQq || batch.allowWechat || batch.groups.length > 0 || splitTags(batch.tags).length > 0);
  const applyBatch = (grant: boolean): void => {
    if (!batch) return;
    const chosen = batch, targets = batchTargets, tags = splitTags(chosen.tags);
    void perform('batch', async () => {
      for (const asset of targets) {
        const groups = new Set(asset.allowWechatGroups ?? []);
        for (const id of chosen.groups) if (grant) groups.add(id); else groups.delete(id);
        const nextTags = grant ? [...new Set([...asset.tags, ...tags])].slice(0, 30) : asset.tags.filter(tag => !tags.includes(tag));
        await api!.update({ id: asset.id,
          ...(chosen.enabled ? { enabled: grant } : {}), ...(chosen.allowQq ? { allowQq: grant } : {}),
          ...(wechat && chosen.allowWechat ? { allowWechat: grant } : {}),
          ...(wechat && chosen.groups.length ? { allowWechatGroups: [...groups] } : {}),
          ...(tags.length ? { tags: nextTags } : {}) });
      }
      if (alive.current) setBatch(null);
      return `已${grant ? '设置' : '取消'} ${targets.length} 张图片。`;
    });
  };
  if (!api) return <section className="media-library"><h1>表情图库</h1><p role="status">当前窗口尚未提供图库功能，请重新打开应用后重试。</p></section>;
  return <section className="media-library" aria-label="表情图库">
    <header className="page-header"><div><h1>表情图库</h1><p>收藏你的表情，按场景复用，也可以将选中的图片放入当前对话。</p></div><button type="button" className="secondary" disabled={busy !== null} onClick={() => void perform('refresh', refresh)}>刷新图库</button></header>
    <div className="media-toolbar"><button type="button" disabled={busy !== null} onClick={() => importImages(false)}>导入图片</button><button type="button" className="secondary" disabled={busy !== null} onClick={() => importImages(true)}>导入文件夹</button>
      <span>支持 PNG、JPEG、WebP 和 GIF。原文件会保留。</span></div>
    {error && <p role="alert" className="inline-error">{error}</p>}{notice && <p role="status" className="media-notice">{notice}</p>}
    {busy && <p role="status">{busy === 'generate' ? '正在生成一张图片并收藏，请稍候…' : busy === 'batch' ? '正在批量保存，请稍候…' : '正在保存，请稍候…'}</p>}
    <div className="media-library-controls"><label>搜索图片或标签<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="例如：开心、晚安、收到" /></label>
      {!trash && batchTargets.length > 0 && <button type="button" className="secondary" disabled={busy !== null}
        onClick={() => { refreshWechat(); setEditor(null); setBatch(batch ? null : emptyBatch()); }}>批量设置这 {batchTargets.length} 张</button>}
      <div role="group" aria-label="图库分类"><button type="button" className="secondary" aria-pressed={!trash} onClick={() => { setTrash(false); setEditor(null); }}>图库 {allCount}</button><button type="button" className="secondary" aria-pressed={trash} onClick={() => { setTrash(true); setEditor(null); }}>回收站 {deletedCount}</button></div></div>
    {batch && !trash && <section ref={batchPanel} className="panel media-editor" aria-label="批量设置图片">
      <h2>批量设置 {batchTargets.length} 张图片</h2>
      <p>作用于{search.trim() ? `搜索「${search.trim()}」找到的` : '图库里全部的'} {batchTargets.length} 张图片。只改下面勾选的项目，其余设置保持不变。</p>
      <label className="media-check"><input type="checkbox" checked={batch.enabled} onChange={event => setBatch({ ...batch, enabled: event.target.checked })} />参与自动配图</label>
      <label className="media-check"><input type="checkbox" checked={batch.allowQq} onChange={event => setBatch({ ...batch, allowQq: event.target.checked })} />QQ 回复使用</label>
      {wechat && <>
        <label className="media-check"><input type="checkbox" checked={batch.allowWechat} onChange={event => setBatch({ ...batch, allowWechat: event.target.checked })} />微信主号私聊使用</label>
        {wechatState?.groups.map(group => <label className="media-check" key={group.id}>
          <input type="checkbox" checked={batch.groups.includes(group.id)}
            onChange={event => setBatch({ ...batch, groups: event.target.checked ? [...batch.groups, group.id] : batch.groups.filter(id => id !== group.id) })} />
          微信群「{group.title}」使用</label>)}
      </>}
      <label>同时追加标签<input value={batch.tags} onChange={event => setBatch({ ...batch, tags: event.target.value })} placeholder="用逗号分隔，例如：开心，招手" /></label>
      <p>表情要按场景自动发出，名称或标签里需要有场景词：{SCENE_WORDS}。微信只发静态 PNG 或 JPEG。</p>
      <div className="media-toolbar">
        <button type="button" disabled={busy !== null || !batchChosen} onClick={() => applyBatch(true)}>对这 {batchTargets.length} 张打开勾选项</button>
        <button type="button" className="secondary" disabled={busy !== null || !batchChosen} onClick={() => applyBatch(false)}>对这 {batchTargets.length} 张取消勾选项</button>
        <button type="button" className="secondary" onClick={() => setBatch(null)}>关闭</button>
      </div>
    </section>}
    {snapshot === null ? <p>正在读取图库…</p> : visible.length === 0 ? <p className="media-empty">{search ? '没有匹配的图片。' : trash ? '回收站为空。' : '图库还是空的。先导入已有表情，或者生成一张新图。'}</p> : <div className="media-grid">
      {visible.map(asset => <article className="media-card" aria-label={asset.title} key={asset.id}>
        {!asset.deletedAt && localMediaUrl(asset) ? <img src={localMediaUrl(asset)!} alt={asset.title} loading="lazy" /> : <div className="media-deleted-preview">已移入回收站</div>}
        <h2>{asset.title}</h2><p className="media-card-meta">{asset.width} × {asset.height} · {asset.source.kind === 'generated' ? '生成图片' : '已导入'} · {new Date(asset.createdAt).toLocaleDateString(locale)}</p>
        <p className="media-tags">{asset.tags.length ? asset.tags.join(' · ') : '暂无标签'}</p>
        {!asset.deletedAt && <p className="media-card-meta">{asset.enabled ? '自动配图已开' : '仅手动选择'} · {asset.allowQq ? '允许 QQ 使用' : 'QQ 未授权'}
          {asset.allowWechat && ' · 允许微信主号私聊'}{Boolean(asset.allowWechatGroups?.length) && ` · 允许 ${asset.allowWechatGroups!.length} 个微信群`}</p>}
        <div className="media-card-actions">{asset.deletedAt ? <button type="button" disabled={busy !== null} onClick={() => void perform('restore', async () => { await api.restore(asset.id); return '图片已恢复到图库。'; })}>恢复图片</button> : <>
          <button type="button" disabled={busy !== null || !sessionId} onClick={() => void perform('attach', async () => { await api.attach({ sessionId, assetId: asset.id }); onAttached(); })}>放入当前对话</button>
          <button type="button" className="secondary" disabled={busy !== null} onClick={() => edit(asset)}>编辑图片信息</button>
          <button type="button" className="secondary" disabled={busy !== null} onClick={() => void perform('remove', async () => { await api.remove(asset.id); if (editor?.id === asset.id) setEditor(null); return '已移入回收站，可随时恢复。'; })}>移入回收站</button>
        </>}</div>
      </article>)}
    </div>}
    {editor && <form className="panel media-editor" aria-label="编辑图片信息" onSubmit={saveEditor}><h2>编辑图片信息</h2>
      <label>图片名称<input value={editor.title} maxLength={160} required onChange={event => setEditor({ ...editor, title: event.target.value })} /></label>
      <label>场景标签<textarea value={editor.tags} onChange={event => setEditor({ ...editor, tags: event.target.value })} placeholder="用逗号分隔，例如：开心，庆祝，点赞" /></label>
      <label className="media-check"><input type="checkbox" checked={editor.enabled} onChange={event => setEditor({ ...editor, enabled: event.target.checked })} />参与自动配图</label>
      <label className="media-check"><input type="checkbox" checked={editor.allowQq} onChange={event => setEditor({ ...editor, allowQq: event.target.checked })} />允许 QQ 回复使用这张图片</label>
      {wechat && <fieldset><legend>微信回复授权</legend>
        <p>微信使用静态 PNG 或 JPEG。授权按会话设置。</p>
        <label className="media-check"><input type="checkbox" checked={editor.allowWechat}
          onChange={event => setEditor({ ...editor, allowWechat: event.target.checked })} />允许微信主号私聊使用这张图片</label>
        {wechatState?.groups.map(group => <label className="media-check" key={group.id}>
          <input type="checkbox" checked={editor.allowWechatGroups.includes(group.id)}
            onChange={event => setEditor({ ...editor, allowWechatGroups: event.target.checked
              ? [...editor.allowWechatGroups, group.id] : editor.allowWechatGroups.filter(id => id !== group.id) })} />
          允许微信群「{group.title}」使用这张图片</label>)}
        {!wechatState?.groups.length && <p>绑定微信群后，可在这里授权对应群聊。</p>}
      </fieldset>}
      <div className="media-toolbar"><button type="submit" disabled={busy !== null || !editor.title.trim()}>保存图片信息</button><button type="button" className="secondary" onClick={() => setEditor(null)}>取消编辑</button></div>
    </form>}
    {settings && <section className="panel media-preferences" aria-label="图库使用与生成"><h2>图库使用与生成</h2>
      <p>自动配图只选择已开启“参与自动配图”的图片，不会自动调用生图服务。其它图片仍可手动放入对话。</p>
      <label className="media-check"><input type="checkbox" checked={settings.autoReplyDesktop} disabled={busy !== null} onChange={event => setSettings({ ...settings, autoReplyDesktop: event.target.checked })} />桌面回复按场景配图</label>
      <label className="media-check"><input type="checkbox" checked={settings.autoReplyQq} disabled={busy !== null} onChange={event => setSettings({ ...settings, autoReplyQq: event.target.checked })} />QQ 回复按场景配图</label>
      <label>自动配图最短间隔（秒）<input type="number" min={30} max={86400} value={settings.cooldownSeconds} onChange={event => setSettings({ ...settings, cooldownSeconds: Number(event.target.value) })} /></label>
      <label>图片生成使用的模型服务（用这个服务里保存的 OpenAI API Key）<select value={providerId} disabled={busy !== null} onChange={event => setSettings({ ...settings, providerId: event.target.value || null })}><option value="">请选择服务</option>{selectedProviders.map(provider => <option value={provider.id} key={provider.id}>{provider.name} · {provider.model}</option>)}</select></label>
      <label>图像模型<select value={settings.model} disabled={busy !== null} onChange={event => setSettings({ ...settings, model: event.target.value })}>
        {!IMAGE_MODELS.some(([id]) => id === settings.model) && <option value={settings.model}>{settings.model}（不受支持，请重新选择）</option>}
        {IMAGE_MODELS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      <button type="button" className="secondary" disabled={busy !== null || !Number.isInteger(settings.cooldownSeconds) || settings.cooldownSeconds < 30 || settings.cooldownSeconds > 86400 || !IMAGE_MODELS.some(([id]) => id === settings.model)} onClick={() => void perform('configure', async () => { const saved = await api.configure({ ...settings, providerId: providerId || null }); if (alive.current) setSettings(saved); return '图库设置已保存。'; })}>保存图库设置</button>
      <hr /><h3>生成新图片</h3><p>按下按钮才生成一张并收藏。使用已保存的 API Key；按服务用量计费。这个按钮只按文字生成，不会上传图库素材。</p>
      <p>微信缺少某个场景的表情、或准备朋友圈配图时，也会用这里选的服务和模型自动画图（表情每天最多 10 张）；若有标签为「角色参考」的图片，会把它作为参考图一起发送，以保持角色一致。</p>
      <label>想生成什么图片<textarea value={prompt} maxLength={4000} disabled={busy !== null} onChange={event => setPrompt(event.target.value)} placeholder="例如：原创小猫开心挥手，配中文“收到啦”" /></label>
      <button type="button" disabled={busy !== null || !providerId || !settings.model.trim() || !prompt.trim()} onClick={() => void perform('generate', async () => { await api.generate({ providerId, model: settings.model.trim(), prompt: prompt.trim() }); setTrash(false); setSearch(''); return '图片已生成并收藏到图库。'; })}>生成一张并收藏</button>
    </section>}
  </section>;
};
