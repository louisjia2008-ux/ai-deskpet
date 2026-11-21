import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { ResolvedLocale } from '../../shared';
import type { CompanionRecentAPI, CompanionRecentStatus } from '../../shared/companion-recent';

export function CompanionRecentPanel({ api, locale }: { api: CompanionRecentAPI; locale: ResolvedLocale }): JSX.Element {
  const zh = locale === 'zh-CN';
  const [value, setValue] = useState<CompanionRecentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => { void api.status().then(result => {
      if (alive) { setValue(result); setError(false); }
    }, () => { if (alive) setError(true); }); };
    const stop = api.onChanged(refresh);
    refresh();
    return () => { alive = false; stop(); };
  }, [api]);
  const update = async (action: () => Promise<CompanionRecentStatus>): Promise<void> => {
    setBusy(true);
    setError(false);
    try { setValue(await action()); setConfirm(false); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  return <section className="panel stack-form" aria-labelledby="companion-recent-title" aria-busy={busy}>
    <h3 id="companion-recent-title">{zh ? '最近和你的事' : 'Recent conversations with you'}</h3>
    <p>{value?.text || (zh ? '最近 36 小时暂时没有摘要。' : 'There is no summary for the last 36 hours yet.')}</p>
    {value?.updatedAt && <small>{zh ? '更新于 ' : 'Updated '}<time dateTime={value.updatedAt}>{new Date(value.updatedAt).toLocaleString(locale)}</time></small>}
    {value && <label><input type="checkbox" checked={value.localOnly} disabled={busy} onChange={event => {
      const localOnly = event.currentTarget.checked;
      void update(() => api.setLocalOnly(localOnly));
    }} /> {zh ? '仅本地使用摘要' : 'Keep the summary local'}</label>}
    {value?.containsLocal && !value.localOnly && <small>{zh ? '当前摘要含仅本地内容。' : 'The current summary contains local-only material.'}</small>}
    {error && <p role="alert">{zh ? '暂时无法读取或更新摘要。' : 'The summary could not be loaded or updated.'}</p>}
    {value?.text && <div>
      <button type="button" disabled={busy} onClick={() => {
        if (confirm) void update(() => api.clear());
        else setConfirm(true);
      }}>{confirm ? (zh ? '确认清空摘要' : 'Confirm clear') : (zh ? '清空摘要' : 'Clear summary')}</button>
      {confirm && <button type="button" disabled={busy} onClick={() => setConfirm(false)}>{zh ? '取消' : 'Cancel'}</button>}
    </div>}
  </section>;
}
