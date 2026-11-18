import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { ChatTimer } from '../../shared';
import { formatTimerDeadline } from '../../shared/timer-time';

/** One-off timers set from chat. */
export const TimerList = ({ t }: { t(key: string): string }): JSX.Element => {
  const [timers, setTimers] = useState<ChatTimer[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void window.deskpet.timers.list().then((items) => { if (active) setTimers(items); }).catch(() => { if (active) setFailed(true); });
    const stop = window.deskpet.timers.onChanged(setTimers);
    return () => { active = false; stop(); };
  }, []);
  const cancel = async (id: string): Promise<void> => {
    setBusy(true); setFailed(false);
    try { await window.deskpet.timers.cancel(id); } catch { setFailed(true); } finally { setBusy(false); }
  };
  return <div className="panel timer-list"><h2>{t('timer.title')}</h2><p className="muted">{t('timer.detail')}</p>
    {failed && <p className="error-banner" role="alert">{t('common.error')}</p>}
    <ul className="simple-list">{timers.slice().reverse().slice(0, 100).map((timer) => <li key={timer.id} aria-label={timer.label || t('timer.title')}><div><strong>{timer.label || t('timer.title')}</strong><small>{formatTimerDeadline(timer.dueAt)} · {t(`timer.${timer.status}`)}</small></div>{timer.status === 'pending' && <button type="button" className="secondary" disabled={busy} onClick={() => void cancel(timer.id)}>{t('common.cancel')}</button>}</li>)}</ul>
    {timers.length === 0 && <p className="muted">{t('timer.empty')}</p>}</div>;
};
