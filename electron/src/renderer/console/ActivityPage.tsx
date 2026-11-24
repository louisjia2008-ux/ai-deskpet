import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ResolvedLocale, TaskRunEvent, TaskRunStatus } from '../../shared';

const PAGE_SIZE = 100;
const STATUS_LABELS: Record<TaskRunStatus, [string, string]> = {
  queued: ['排队中', 'Queued'], running: ['进行中', 'Running'], 'awaiting-approval': ['等你确认', 'Needs your approval'],
  succeeded: ['已完成', 'Done'], failed: ['没成功', 'Failed'], cancelled: ['已取消', 'Cancelled'], missed: ['错过了', 'Missed'],
};

export const ActivityPage = ({ t, locale }: { t(key: string): string; locale: ResolvedLocale }): JSX.Element => {
  const zh = locale === 'zh-CN';
  const [items, setItems] = useState<TaskRunEvent[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const revision = useRef({ value: 0 });
  // Once older events are open, coming back to the window keeps the reader's place.
  const olderOpen = useRef(false), loadingOlder = useRef(false);
  const load = useCallback(async (beforeId?: string) => {
    if (beforeId) loadingOlder.current = true;
    const current = ++revision.current.value;
    setBusy(true); setFailed(false);
    try {
      const page = await window.deskpet.tasks.listRunEvents({ limit: PAGE_SIZE, ...(beforeId ? { beforeId } : {}) });
      if (current !== revision.current.value) return;
      if (beforeId) olderOpen.current = true;
      setItems(items => beforeId ? [...page, ...items] : page);
      setMore(page.length === PAGE_SIZE);
    } catch { if (current === revision.current.value) setFailed(true); }
    finally { if (beforeId) loadingOlder.current = false; if (current === revision.current.value) setBusy(false); }
  }, []);
  useEffect(() => {
    const current = revision.current;
    void load();
    // Coming back to the window shows the latest events without a refresh button.
    const reload = (): void => { if (!olderOpen.current && !loadingOlder.current) void load(); };
    window.addEventListener('focus', reload);
    return () => { current.value++; window.removeEventListener('focus', reload); };
  }, [load]);
  return <section>
    <header className="page-header"><span>{t('nav.activity')}</span><h1>{t('activity.title')}</h1></header>
    {failed && <p role="alert">{t('common.error')} <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>{t('common.retry')}</button></p>}
    {items.length === 0 ? <p>{busy ? t('common.loading') : t('activity.empty')}</p> : <div className="panel table-wrap"><table>
      <thead><tr><th>{zh ? '结果' : 'Result'}</th><th>{zh ? '发生了什么' : 'What happened'}</th><th>{zh ? '时间' : 'Time'}</th></tr></thead>
      <tbody>{items.slice().reverse().map(item => <tr key={item.id}><td><span className={`status-pill ${item.status}`}>{STATUS_LABELS[item.status][zh ? 0 : 1]}</span></td><td>{item.summary}</td><td>{new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(item.createdAt))}</td></tr>)}</tbody>
    </table></div>}
    {more && <button type="button" disabled={busy} onClick={() => void load(items[0]?.id)}>{locale === 'zh-CN' ? '加载更早记录' : 'Load older events'}</button>}
  </section>;
};
