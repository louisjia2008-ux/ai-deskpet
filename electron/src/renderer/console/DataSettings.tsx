import { useState } from 'react';
import type { JSX } from 'react';
import type { AppState } from '../../shared';

type Translator = (key: string) => string;
const errorKey = (error: unknown, fallback: string): string => error instanceof Error ? error.message.match(/(?:backup\.error|startup)\.[a-zA-Z]+/)?.[0] ?? fallback : fallback;

export const StartupSettings = ({ app, t, refresh }: { app: AppState; t: Translator; refresh(): Promise<void> }): JSX.Element => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const state = app.autoLaunchState ?? 'unavailable';
  const change = async (enabled: boolean): Promise<void> => {
    setBusy(true); setError('');
    try { await window.deskpet.app.setAutoLaunch(enabled); await refresh(); }
    catch (cause) { setError(errorKey(cause, 'startup.error')); await refresh(); }
    finally { setBusy(false); }
  };
  return <div className="startup-settings setting-row">
    <div className="setting-label">
      <label htmlFor="auto-launch">{t('settings.autoLaunch')}</label>
      <p role="status" className="muted">{t(`startup.${state}`)}</p>
      {app.platform === 'darwin' && (state === 'approval-required' || state === 'error') && <button type="button" className="secondary" onClick={() => void window.deskpet.app.openLoginSettings()}>{t('startup.openSettings')}</button>}
      {error && <p role="alert" className="error-banner">{t(error)}</p>}
    </div>
    <span className="switch-row"><input id="auto-launch" type="checkbox" checked={app.autoLaunch} disabled={busy || state === 'unavailable'} onChange={(event) => void change(event.target.checked)} /></span>
  </div>;
};

export const DataSettings = ({ directory, t }: { directory: string; t: Translator }): JSX.Element => {
  const zh = /[\u4e00-\u9fff]/u.test(t('backup.title'));
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [restorePassword, setRestorePassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [prepared, setPrepared] = useState<{ sessions: number; messages: number; files: number; memoryProtection?: 'preserved' | 'unavailable' } | null>(null);
  const create = async (): Promise<void> => {
    setBusy(true); setError(''); setSaved('');
    try { const result = await window.deskpet.backup.create(password); if (result !== null) setSaved(result.path); }
    catch (cause) { setError(errorKey(cause, 'backup.error.invalid')); }
    finally { setPassword(''); setConfirmation(''); setBusy(false); }
  };
  const restore = async (): Promise<void> => {
    setBusy(true); setError(''); setSaved('');
    try { setPrepared(await window.deskpet.backup.restore(restorePassword)); }
    catch (cause) { setError(errorKey(cause, 'backup.error.invalid')); }
    finally { setRestorePassword(''); setBusy(false); }
  };
  const settle = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError('');
    try { await operation(); } catch (cause) { setError(errorKey(cause, 'backup.error.invalid')); setBusy(false); }
  };
  return <div className="data-settings"><h2>{t('settings.privacy')}</h2><p>{t('privacy.localOnly')}</p><code className="path-block">{directory}</code>
    <h2>{t('backup.title')}</h2><p className="muted">{t('backup.description')}</p>
    <section className="stack-form" aria-label={zh ? '创建加密备份' : 'Create an encrypted backup'}><h3>{zh ? '创建加密备份' : 'Create an encrypted backup'}</h3>
      <label>{t('backup.password')}<input type="password" autoComplete="off" minLength={12} maxLength={256} disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <label>{t('backup.confirmPassword')}<input type="password" autoComplete="off" maxLength={256} disabled={busy} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
      <small>{t('backup.passwordHint')}</small>
      <div className="button-row"><button type="button" disabled={busy || password.length < 12 || password !== confirmation} onClick={() => void create()}>{t('backup.create')}</button></div>
    </section>
    <details className="settings-more"><summary>{zh ? '从备份恢复' : 'Restore from a backup'}</summary><section className="stack-form" aria-label={zh ? '从备份恢复' : 'Restore from a backup'}>
      <label>{zh ? '这个备份的密码' : 'This backup’s password'}<input type="password" autoComplete="off" maxLength={256} disabled={busy} value={restorePassword} onChange={(event) => setRestorePassword(event.target.value)} /></label>
      <small>{zh ? '下一步选择备份文件。恢复会替换当前数据，重启前可以取消。' : 'Next you choose the backup file. Restoring replaces current data; you can cancel before restarting.'}</small>
      <div className="button-row"><button type="button" className="secondary" disabled={busy || restorePassword.length < 12} onClick={() => void restore()}>{t('backup.restore')}</button></div>
    </section></details>
    {busy && <p role="status">{t('backup.working')}</p>}
    {saved && <div role="status" className="success-card"><strong>{t('backup.saved')}</strong><code className="path-block">{saved}</code></div>}
    {error && <p role="alert" className="error-banner">{t(error)}</p>}
    {prepared !== null && <div className="backup-pending" role="alertdialog" aria-modal="true" aria-label={t('backup.ready')}><div className="panel"><h2>{t('backup.ready')}</h2><p>{t('backup.restartHint')}</p>{prepared.memoryProtection && <p>{t(`backup.memoryProtection.${prepared.memoryProtection}`)}</p>}<p>{prepared.sessions} · {t('nav.chat')} / {prepared.messages} · {t('backup.messages')}</p>
      <p className="muted">{zh ? '取消会放弃这次恢复，DeskPet 重新打开后数据保持原样。' : 'Cancelling drops this restore; DeskPet reopens with your data unchanged.'}</p>
      {error && <p role="alert" className="error-banner">{t(error)}</p>}
      <div className="button-row"><button type="button" className="secondary" autoFocus disabled={busy} onClick={() => void settle(() => window.deskpet.backup.cancelRestore())}>{zh ? '取消恢复' : 'Cancel restore'}</button>
        <button type="button" disabled={busy} onClick={() => void settle(() => window.deskpet.backup.restart())}>{t('backup.restart')}</button></div>
    </div></div>}
  </div>;
};
