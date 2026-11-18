import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ResolvedLocale, TaskRunEvent } from '../../shared';

const PAGE_SIZE = 100;
export const ActivityPage = ({ t, locale }: { t(key: string): string; locale: ResolvedLocale }): JSX.Element => {
  const [items, setItems] = useState<TaskRunEvent[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const revision = useRef({ value: 0 });
  const load = useCallback(async (beforeId?: string) => {
    const current = ++revision.current.value;
    setBusy(true); setFailed(false);
    try {
      const page = await window.deskpet.tasks.listRunEvents({ limit: PAGE_SIZE, ...(beforeId ? { beforeId } : {}) });
      if (current !== revision.current.value) return;
      setItems(items => beforeId ? [...page, ...items] : page);
      setMore(page.length === PAGE_SIZE);
    } catch { if (current === revision.current.value) setFailed(true); }
    finally { if (current === revision.current.value) setBusy(false); }
  }, []);
  useEffect(() => {
    const current = revision.current;
    void load();
    return () => { current.value++; };
  }, [load]);
  return <section>
    <header className="page-header"><span>{t('nav.activity')}</span><h1>{t('activity.title')}</h1></header>
    <button type="button" disabled={busy} onClick={() => void load()}>{locale === 'zh-CN' ? '刷新' : 'Refresh'}</button>
    {failed && <p role="alert">{t('common.error')}</p>}
    {items.length === 0 ? <p>{busy ? t('common.loading') : t('activity.empty')}</p> : <div className="panel table-wrap"><table>
      <thead><tr><th>{t('activity.status')}</th><th>{t('activity.summary')}</th><th>{t('settings.status')}</th></tr></thead>
      <tbody>{items.slice().reverse().map(item => <tr key={item.id}><td><span className={`status-pill ${item.status}`}>{item.status}</span></td><td>{item.summary}</td><td>{new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(item.createdAt))}</td></tr>)}</tbody>
    </table></div>}
    {more && <button type="button" disabled={busy} onClick={() => void load(items[0]?.id)}>{locale === 'zh-CN' ? '加载更早记录' : 'Load older events'}</button>}
  </section>;
};
