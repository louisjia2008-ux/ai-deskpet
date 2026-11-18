import { useRef, useState } from 'react';
import type { JSX } from 'react';
import type { PermissionDescriptor } from '../../shared';

interface Props {
  permissions: PermissionDescriptor[];
  t(key: string): string;
  refresh(): Promise<void>;
}

const PermissionRow = ({ permission, t, refresh }: Omit<Props, 'permissions'> & { permission: PermissionDescriptor }): JSX.Element => {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const granted = permission.state === 'session' || permission.state === 'always';

  const change = async (duration: 'session' | 'always' | null): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setFailed(false);
    try {
      if (duration === null) await window.deskpet.permissions.revoke(permission.capabilityId);
      else await window.deskpet.permissions.request({ capabilityId: permission.capabilityId, duration });
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return <article aria-label={t(permission.titleCode)} aria-busy={busy}>
    <div className="permission-detail">
      <strong>{t(permission.titleCode)}</strong>
      <small>{t(permission.detailCode)}</small>
      <small>{permission.capabilityId} · {permission.risk}</small>
    </div>
    <span className={`status-pill ${permission.state === 'denied' ? 'failed' : granted ? 'succeeded' : 'degraded'}`} data-permission-state={permission.state}>{t(`permission.state.${permission.state}`)}</span>
    <div className="permission-actions">
      {permission.state !== 'session' ? <button type="button" className="secondary" disabled={busy} onClick={() => void change('session')}>{t(permission.state === 'always' ? 'permission.switchToSession' : 'permission.allowSession')}</button> : null}
      {permission.state !== 'always' ? <button type="button" disabled={busy} onClick={() => void change('always')}>{t('permission.allowAlways')}</button> : null}
      {granted ? <button type="button" className="secondary" disabled={busy} onClick={() => void change(null)}>{t('permission.revoke')}</button> : null}
    </div>
    {failed ? <p className="permission-error" role="alert">{t('permission.updateFailed')}</p> : null}
  </article>;
};

export const PermissionSettings = ({ permissions, t, refresh }: Props): JSX.Element => <div>
  <h2>{t('permission.title')}</h2>
  <p className="permission-help">{t('permission.persistenceHint')}</p>
  <div className="permission-list">{permissions.map((permission) => <PermissionRow key={permission.capabilityId} permission={permission} t={t} refresh={refresh} />)}</div>
</div>;
