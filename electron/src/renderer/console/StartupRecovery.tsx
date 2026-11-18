import { useState } from 'react';
import type { JSX } from 'react';
import type { StartupRecoveryState } from '../../shared';
import { messages } from '../../shared';

export const StartupRecovery = ({ state }: { state: StartupRecoveryState }): JSX.Element => {
  const [password, setPassword] = useState('');
  const [selected, setSelected] = useState(state.snapshots[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const [error, setError] = useState(false);
  const t = (key: keyof typeof messages.en): string => messages[state.locale][key];
  const restore = async (snapshot: boolean): Promise<void> => {
    setBusy(true); setError(false);
    try { setPrepared(await (snapshot ? window.deskpet.recovery.restoreSnapshot(selected) : window.deskpet.recovery.restoreBackup(password))); }
    catch { setError(true); }
    finally { setBusy(false); setPassword(''); }
  };
  return <main className="startup-recovery"><section className="panel stack-form"><span className="eyebrow">DeskPet</span><h1>{t('recovery.title')}</h1><p>{t('recovery.description')}</p><p>{t('backup.memoryProtection.unavailable')}</p><code className="path-block">{state.affectedFile}</code><small>{state.dataDirectory}</small>
    {error && <p className="error-banner" role="alert">{t('recovery.failed')}</p>}
    {prepared ? <div role="status"><p>{t('backup.restartHint')}</p><button type="button" onClick={() => void window.deskpet.backup.restart()}>{t('backup.restart')}</button></div> : <>
      <label>{t('recovery.snapshot')}<select value={selected} disabled={busy || state.snapshots.length === 0} onChange={(event) => setSelected(event.target.value)}>{state.snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.label}</option>)}</select></label>
      <button type="button" disabled={busy || !selected} onClick={() => void restore(true)}>{t('recovery.restoreSnapshot')}</button>
      <label>{t('backup.password')}<input type="password" autoComplete="off" minLength={12} maxLength={256} disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button type="button" className="secondary" disabled={busy || password.length < 12} onClick={() => void restore(false)}>{t('backup.restore')}</button>
      {busy && <p role="status">{t('backup.working')}</p>}
    </>}
  </section></main>;
};
