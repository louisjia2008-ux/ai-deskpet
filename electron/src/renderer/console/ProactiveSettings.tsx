import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { ProactiveConfig, ProactiveState } from '../../shared/proactive';

export const ProactiveSettings = ({ t }: { t(key: string): string }): JSX.Element | null => {
  const [state, setState] = useState<ProactiveState | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // Keep older development preload sessions usable until their next reload.
    if (!window.deskpet.proactive) return;
    let active = true;
    void window.deskpet.proactive.getState().then((next) => { if (active) setState(next); }).catch(() => { if (active) setFailed(true); });
    const stop = window.deskpet.proactive.onChanged((next) => { if (active) setState(next); });
    return () => { active = false; stop(); };
  }, []);
  const save = async (config: ProactiveConfig): Promise<void> => {
    setSaving(true); setFailed(false);
    try { setState(await window.deskpet.proactive.configure(config)); }
    catch { setFailed(true); }
    finally { setSaving(false); }
  };
  if (state === null && !failed) return null;
  return <section className="proactive-settings" aria-label={t('proactive.title')}>
    <h2>{t('proactive.title')}</h2>
    <p className="setting-help">{t('proactive.detail')}</p>
    {failed && <p role="alert">{t('proactive.saveFailed')}</p>}
    {state && <>
      <label className="proactive-toggle"><input type="checkbox" checked={state.enabled} disabled={saving} onChange={(event) => void save({ enabled: event.target.checked, frequency: state.frequency })} />{t('proactive.enabled')}</label>
      <div className="setting-row"><label htmlFor="proactive-frequency">{t('proactive.frequency')}</label><select id="proactive-frequency" value={state.frequency} disabled={saving} onChange={(event) => void save({ enabled: state.enabled, frequency: event.target.value as ProactiveConfig['frequency'] })}>{(['rare', 'occasional', 'frequent'] as const).map((value) => <option key={value} value={value}>{t(`proactive.${value}`)}</option>)}</select></div>
      <p className="setting-help">{t('proactive.rules')}</p>
      <p role="status">{t('proactive.status')}：{t(`proactive.${state.status}`)} · {t('proactive.count')} {state.attemptsToday}/{state.dailyLimit}</p>
      {state.enabled && state.nextAt && <p className="setting-help">{t('proactive.next')}：{new Date(state.nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>}
      {state.sessionId && <button type="button" className="secondary" onClick={() => void window.deskpet.chat.openSession(state.sessionId!).catch(() => setFailed(true))}>{t('proactive.open')}</button>}
    </>}
  </section>;
};
