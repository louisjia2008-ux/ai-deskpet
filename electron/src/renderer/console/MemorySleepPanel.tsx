import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { MemorySleepAPI, MemorySleepStatus } from '../../shared/memory-sleep';

const copy = {
  en: {
    title: 'Nightly tidy-up', detail: 'Once a night the model you are using reads what was learned from conversation. It merges repeats, lets a newer statement replace an older one, moves lasting facts into the deep profile that accompanies every conversation, and lets go of what was only passing. Shallow entries nothing has confirmed for 30 days fade. Memories you wrote or edited yourself are never changed. Every step below can be undone for 30 days.',
    enabled: 'Tidy up every night', hour: 'Hour', run: 'Tidy up now', running: 'Tidying…', last: 'Last run', never: 'not yet', layers: (shallow: number, deep: number) => `${shallow} shallow · ${deep} deep`,
    none: 'Nothing has been changed yet.', undo: 'Undo', undone: 'Undone', failed: 'That did not work.', by: 'by',
    kind: { merge: 'Merged', promote: 'Moved to deep', drop: 'Let go', expire: 'Faded after 30 days' },
    error: { 'sleep.noProvider': 'No model provider is selected.', 'sleep.invalidResult': 'The model did not return a usable plan.', 'sleep.incomplete': 'The model stopped before finishing.', 'sleep.failed': 'The last run failed.' } as Record<string, string>,
  },
  'zh-CN': {
    title: '夜间整理', detail: '每晚一次，由你当前使用的模型把从对话中记下的内容读一遍：合并重复的，新说法替换旧说法，把长期成立的升为每次聊天都带上的深层画像，放下只是一时的内容。30 天没有再被印证的浅层记忆会自动淡出。你自己写的或改过的记忆不会被改动。下面每一步在 30 天内都可以撤销。',
    enabled: '每晚自动整理', hour: '时间（点）', run: '现在整理', running: '整理中…', last: '上次整理', never: '还没有', layers: (shallow: number, deep: number) => `浅层 ${shallow} 条 · 深层 ${deep} 条`,
    none: '还没有改动过任何记忆。', undo: '撤销', undone: '已撤销', failed: '操作没有成功。', by: '模型',
    kind: { merge: '合并', promote: '升为深层', drop: '放下', expire: '30 天后淡出' },
    error: { 'sleep.noProvider': '还没有选择模型服务。', 'sleep.invalidResult': '模型没有返回可用的整理方案。', 'sleep.incomplete': '模型没有回答完。', 'sleep.failed': '上次整理失败。' } as Record<string, string>,
  },
};

export const MemorySleepPanel = ({ api, locale, onMemoryChanged }: { api: MemorySleepAPI; locale: 'en' | 'zh-CN'; onMemoryChanged(): Promise<void> }): JSX.Element | null => {
  const t = copy[locale];
  const [status, setStatus] = useState<MemorySleepStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => api.status().then(setStatus).catch(() => undefined), [api]);
  useEffect(() => { void load(); }, [load]);
  const perform = async (operation: () => Promise<MemorySleepStatus>): Promise<void> => {
    setBusy(true); setFailed(false);
    try { setStatus(await operation()); await onMemoryChanged(); } catch { setFailed(true); await load(); } finally { setBusy(false); }
  };
  if (!status) return null;
  const date = (value: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  return <section className="memory-sleep" aria-label={t.title}>
    <div className="panel">
      <p>{t.detail}</p>
      <label className="check-row"><input type="checkbox" checked={status.settings.enabled} disabled={busy}
        onChange={event => void perform(() => api.configure({ ...status.settings, enabled: event.target.checked }))} />{t.enabled}</label>
      <div className="setting-row"><label htmlFor="memory-sleep-hour">{t.hour}</label>
        <select id="memory-sleep-hour" value={status.settings.hour} disabled={busy} onChange={event => void perform(() => api.configure({ ...status.settings, hour: Number(event.target.value) }))}>
          {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}
        </select></div>
      <p><small>{t.layers(status.shallow, status.deep)} · {t.last}: {status.lastRunAt ? date(status.lastRunAt) : t.never}</small></p>
      <div className="button-row"><button type="button" disabled={busy || status.running} onClick={() => void perform(() => api.runNow())}>{busy || status.running ? t.running : t.run}</button></div>
      {(failed || status.lastError) && <p role="alert">{status.lastError ? t.error[status.lastError] ?? t.error['sleep.failed'] : t.failed}</p>}
    </div>
    {status.reports.length === 0 ? <p>{t.none}</p> : status.reports.map(report => <article className="panel" key={report.id} aria-label={date(report.at)}>
      <div className="panel-heading"><h2>{date(report.at)}</h2><small>{t.by} {report.provider}</small></div>
      <ul className="simple-list">{report.changes.map(change => <li key={change.id} data-kind={change.kind}>
        <div><strong>{t.kind[change.kind]}</strong>
          {change.kind !== 'promote' && change.before.map((text, index) => <small key={index}><s>{text}</s></small>)}
          {change.after !== null && <small>{change.after}</small>}</div>
        {change.undoneAt ? <span>{t.undone}</span>
          : <button type="button" className="secondary" disabled={busy} onClick={() => void perform(() => api.undo({ reportId: report.id, changeId: change.id }))}>{t.undo}</button>}
      </li>)}</ul>
    </article>)}
  </section>;
};
