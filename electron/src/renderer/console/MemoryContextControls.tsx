import { useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ContextPrivacy, ContextScope, MemoryItem } from '../../shared';

export const MemoryContextControls = ({ item, currentSessionId, t, refresh }: {
  item: MemoryItem; currentSessionId: string; t(key: string): string; refresh(): Promise<void>;
}): JSX.Element => {
  const metadata = item.contextMetadata;
  const originalSession = metadata?.scope.kind === 'session' ? metadata.scope.sessionId : null;
  const [privacy, setPrivacy] = useState<ContextPrivacy>(metadata?.privacy ?? 'local-only');
  const [scope, setScope] = useState(originalSession === null ? 'global' : originalSession === currentSessionId ? 'current' : 'original');
  const [telegramAllowed, setTelegramAllowed] = useState(metadata?.telegramAllowed === true);
  const [wechatAllowed, setWechatAllowed] = useState(metadata?.wechatAllowed === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ signature: string; operationId: string } | null>(null);
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError('');
    const selectedScope: ContextScope = scope === 'global'
      ? { kind: 'global' }
      : { kind: 'session', sessionId: scope === 'original' ? originalSession ?? '' : currentSessionId };
    try {
      const signature = JSON.stringify([privacy, selectedScope, telegramAllowed, wechatAllowed, metadata?.revision ?? 0]);
      if (pending.current?.signature !== signature) pending.current = { signature, operationId: crypto.randomUUID() };
      await window.deskpet.memory.upsert({ id: item.id, text: item.text, tags: item.tags, privacy, scope: selectedScope, telegramAllowed: telegramAllowed && privacy === 'cloud-allowed' && scope === 'global',
        wechatAllowed: wechatAllowed && scope === 'global',
        confirmForChat: metadata?.trust !== 'host-confirmed', expectedRevision: metadata?.revision ?? 0, operationId: pending.current.operationId });
      await refresh();
    } catch (cause) { setError(cause instanceof Error && cause.message.includes('repository.commitUncertain') ? 'repository.commitUncertain' : 'common.error'); }
    finally { setBusy(false); }
  };
  return <details className="memory-context-settings"><summary>{t('memory.contextSettings')}</summary>
    <p className="muted">{t(metadata?.trust === 'host-confirmed' ? 'memory.confirmedForChat' : 'memory.needsReview')}</p>
    <p>{t('memory.source')}: {t(`memory.origin.${metadata?.origin ?? 'legacy-unknown'}`)} · {metadata?.layer ? `${t(`memory.layer.${metadata.layer}`)} · ` : ''}{t('memory.revision')}: {metadata?.revision ?? t('chat.contextUnknown')}</p>
    <small>{t('memory.sentAttempts')}: {metadata?.sentCount ?? t('chat.contextUnknown')}</small>
    <p className="muted">{t('memory.sentDetail')}</p>
    <form className="stack-form" onSubmit={(event) => void save(event)}>
      <label>{t('memory.contextSettings')}<select aria-label={t('memory.contextSettings')} disabled={busy} value={privacy} onChange={(event) => setPrivacy(event.target.value as ContextPrivacy)}>
        <option value="local-only">{t('memory.localOnly')}</option><option value="cloud-allowed">{t('memory.cloudAllowed')}</option>
      </select></label>
      <label>{t('form.scope')}<select aria-label={t('form.scope')} disabled={busy} value={scope} onChange={(event) => setScope(event.target.value)}>
        <option value="global">{t('memory.globalScope')}</option>
        {currentSessionId && <option value="current">{t('memory.sessionScope')}</option>}
        {originalSession && originalSession !== currentSessionId && <option value="original">{t('memory.otherSessionScope')}</option>}
      </select></label>
      <label><input type="checkbox" checked={telegramAllowed && privacy === 'cloud-allowed' && scope === 'global'}
        disabled={busy || privacy !== 'cloud-allowed' || scope !== 'global'} onChange={event => setTelegramAllowed(event.target.checked)} />
        {t('memory.telegramAllowed')}</label>
      <label><input type="checkbox" checked={wechatAllowed && scope === 'global'}
        disabled={busy || scope !== 'global'} onChange={event => setWechatAllowed(event.target.checked)} />
        {t('memory.wechatAllowed')}</label>
      <button type="submit" disabled={busy || (scope !== 'global' && !(scope === 'original' ? originalSession : currentSessionId))}>{t('memory.confirmForChat')}</button>
      {error && <small role="alert">{t(error)}</small>}
    </form>
  </details>;
};
