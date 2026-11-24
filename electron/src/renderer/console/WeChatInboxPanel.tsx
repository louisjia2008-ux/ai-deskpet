import { useEffect, useId, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { ConfirmButton } from './ConfirmButton';
import type { ResolvedLocale } from '../../shared';
import type { WeChatInboxAPI, WeChatInboxItem } from '../../shared/wechat-inbox';

const copy = {
  en: {
    title: 'Inbox', query: 'Search inbox', search: 'Search', delete: 'Remove from inbox', deleteConfirm: 'Confirm (the WeChat message is not affected)', cancel: 'Cancel', previous: 'Previous', next: 'Next',
    empty: 'Your inbox is empty. Reply “存一下” in the owner’s WeChat chat to save a forwarded item.',
    noMatch: 'Nothing matches this search.', loading: 'Reading inbox…', readError: 'Could not read the inbox.',
    deleteError: 'Could not delete the item.',
    kinds: { article: 'Article', link: 'Link', file: 'File', image: 'Image', forward: 'Forwarded messages', quote: 'Quote' },
    export: 'Save new inbox items to your notes vault',
    exportDetail: 'DeskPet writes a Markdown copy into the DeskPet 收件箱 folder in the vault you selected.',
    exportReadError: 'Could not read the inbox export setting.',
    exportError: 'Could not save the inbox export setting.',
    vaultRequired: 'Select a notes vault in Settings before enabling export.',
  },
  'zh-CN': {
    title: '收件箱', query: '搜索收件箱', search: '搜索', delete: '从收件箱移除', deleteConfirm: '确认移除（微信里的原消息不受影响）', cancel: '取消', previous: '上一页', next: '下一页',
    empty: '收件箱是空的。在微信主人私聊里回复「存一下」就能保存转发的内容。',
    noMatch: '没有匹配的条目。', loading: '正在读取收件箱…', readError: '未能读取收件箱。',
    deleteError: '未能删除这条内容。',
    kinds: { article: '公众号文章', link: '链接', file: '文件', image: '图片', forward: '合并转发', quote: '引用' },
    export: '将新收藏同步到本地笔记库',
    exportDetail: 'DeskPet 会在所选笔记库的「DeskPet 收件箱」文件夹里保存 Markdown 副本。',
    exportReadError: '未能读取收件箱同步设置。',
    exportError: '未能保存收件箱同步设置。',
    vaultRequired: '请先在设置里选择本地笔记库，再开启同步。',
  },
};

const pageSize = 25;

export function WeChatInboxPanel({ api, locale }: { api: Pick<WeChatInboxAPI, 'list' | 'remove'>; locale: ResolvedLocale }): JSX.Element {
  const t = copy[locale];
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState({ text: '' });
  const [items, setItems] = useState<WeChatInboxItem[] | null>(null);
  const [page, setPage] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<'readError' | 'deleteError' | null>(null);

  useEffect(() => {
    let active = true;
    setItems(null);
    setError(null);
    void api.list(search.text).then(value => {
      if (active) setItems(value);
    }).catch(() => {
      if (active) setError('readError');
    });
    return () => { active = false; };
  }, [api, search]);

  const find = (event: FormEvent): void => {
    event.preventDefault();
    setPage(0);
    setSearch({ text: query.trim() });
  };
  const remove = async (id: string): Promise<void> => {
    if (deleting) return;
    setDeleting(id);
    setError(null);
    try {
      await api.remove(id);
      setItems(previous => previous?.filter(item => item.id !== id) ?? null);
    } catch {
      setError('deleteError');
    } finally {
      setDeleting(null);
    }
  };

  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const lastPage = Math.max(0, Math.ceil((items?.length ?? 0) / pageSize) - 1);
  const visible = Math.min(page, lastPage);
  const entries = items?.slice(visible * pageSize, (visible + 1) * pageSize) ?? [];
  return <section role="tabpanel" aria-label={t.title}>
    <form className="panel inline-form" onSubmit={find}>
      <label htmlFor={searchId}>{t.query}</label>
      <input id={searchId} type="search" value={query} maxLength={160} onChange={event => setQuery(event.target.value)} />
      <button type="submit" disabled={deleting !== null}>{t.search}</button>
    </form>
    {error && <p className="error-banner" role="alert">{t[error]}</p>}
    {items === null && error === null && <p role="status">{t.loading}</p>}
    {items?.length === 0 && <p>{search.text ? t.noMatch : t.empty}</p>}
    <div className="card-grid">
      {entries.map(item => <article key={item.id} className="memory-card">
        <h3>{item.title}</h3>
        <small className="muted">{[t.kinds[item.kind], item.source, item.at ? date.format(item.at) : ''].filter(Boolean).join(' · ')}</small>
        {item.summary && <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.summary}</p>}
        {item.url && <p className="muted" style={{ overflowWrap: 'anywhere' }}>{item.url}</p>}
        <ConfirmButton label={t.delete} ariaLabel={`${t.delete} ${item.title}`} confirmLabel={t.deleteConfirm} cancelLabel={t.cancel} disabled={deleting !== null} onConfirm={() => void remove(item.id)} />
      </article>)}
    </div>
    {lastPage > 0 && <div className="button-row">
      <button type="button" disabled={visible === 0 || deleting !== null} onClick={() => setPage(visible - 1)}>{t.previous}</button>
      <span>{visible + 1} / {lastPage + 1}</span>
      <button type="button" disabled={visible === lastPage || deleting !== null} onClick={() => setPage(visible + 1)}>{t.next}</button>
    </div>}
  </section>;
}

export function WeChatInboxExportSettings({ api, locale }: { api: Pick<WeChatInboxAPI, 'getExport' | 'setExport'>; locale: ResolvedLocale }): JSX.Element {
  const t = copy[locale];
  const detailId = useId();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<'exportReadError' | 'exportError' | 'vaultRequired' | null>(null);
  useEffect(() => {
    let active = true;
    void api.getExport().then(value => {
      if (active) setEnabled(value);
    }).catch(() => {
      if (active) setError('exportReadError');
    });
    return () => { active = false; };
  }, [api]);

  const update = async (next: boolean): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await api.setExport(next);
      setEnabled(next);
    } catch (cause) {
      setError(cause instanceof Error && cause.message.includes('wechat.inboxVaultRequired') ? 'vaultRequired' : 'exportError');
    } finally {
      setSaving(false);
    }
  };

  return <fieldset className="wechat-cloud-route">
    <legend>{t.title}</legend>
    <label className="wechat-option">
      <input type="checkbox" checked={enabled === true} disabled={enabled === null || saving} aria-describedby={detailId}
        onChange={event => void update(event.target.checked)} />
      <span>{t.export}</span>
    </label>
    <small id={detailId} className="muted">{t.exportDetail}</small>
    {error && <p className="error-banner" role="alert">{t[error]}</p>}
  </fieldset>;
}
