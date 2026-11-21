import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ChatModelSelection, ProviderConfig, ProviderModel } from '../../shared';
import { ModelSelect } from './ModelSelect';

export const ChatModelPicker = ({ providers, provider, selection, onSelect, running, t, refresh, onSavingChange }: {
  providers: ProviderConfig[];
  provider: ProviderConfig | undefined;
  selection: ChatModelSelection | undefined;
  onSelect(value: ChatModelSelection | null): Promise<unknown>;
  running: boolean;
  t(key: string): string;
  refresh(): Promise<void>;
  onSavingChange(saving: boolean): void;
}): JSX.Element => {
  const [catalog, setCatalog] = useState<{ key: string; models: ProviderModel[]; failed: boolean }>({ key: '', models: [], failed: false });
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const changing = useRef(false), catalogEpoch = useRef(0);
  useEffect(() => {
    const api = window.deskpet.providers;
    if (typeof api.onChanged !== 'function') return;
    let subscribed = true;
    const stop = api.onChanged(() => {
      if (!subscribed) return;
      // Credential rotation does not expose the secret or change public fields.
      catalogEpoch.current++; setCatalog({ key: '', models: [], failed: false });
      setRevision((current) => current + 1);
    });
    return () => { subscribed = false; stop(); };
  }, []);
  const id = provider?.id, kind = provider?.kind, baseUrl = provider?.baseUrl, secretState = provider?.secretState;
  const key = `${id ?? ''}:${kind ?? ''}:${baseUrl ?? ''}:${secretState ?? ''}`;
  const locale = t('provider.type') === '服务类型' ? 'zh-CN' : 'en';
  useEffect(() => {
    let active = true; const epoch = ++catalogEpoch.current;
    if (!id) { setLoading(false); return; }
    setLoading(true);
    void (async () => {
      try {
        const models = await window.deskpet.providers.listModels(id);
        if (active && catalogEpoch.current === epoch) setCatalog({ key, models: models ?? [], failed: false });
      } catch {
        if (active && catalogEpoch.current === epoch) setCatalog({ key, models: [], failed: true });
      } finally { if (active && catalogEpoch.current === epoch) setLoading(false); }
    })();
    return () => { active = false; };
  }, [id, key, revision]);
  useEffect(() => { setFailed(false); }, [id]);
  const perform = async (operation: () => Promise<unknown>): Promise<void> => {
    if (changing.current) return;
    changing.current = true; setSaving(true); onSavingChange(true); setFailed(false);
    try { await operation(); await refresh(); }
    catch { setFailed(true); }
    finally { changing.current = false; setSaving(false); onSavingChange(false); }
  };
  const selectModel = (model: string): void => {
    if (!provider || (model.trim() || null) === (selection?.model ?? null)) return;
    void perform(() => onSelect({ providerId: provider.id, model: model.trim() || null }));
  };
  const effectiveModel = selection?.model ?? provider?.model;
  const summary = provider ? `${provider.name} · ${effectiveModel}` : t('chat.noProvider');
  return <details className="chat-model-picker">
    <summary><span className="chat-model-summary-label">{t('chat.model')}</span><span className="chat-model-summary-value" title={summary}>{summary}</span><span className="chat-model-summary-action">{locale === 'zh-CN' ? '更换' : 'Change'}</span></summary>
    <div className="chat-model-expanded">
    <div className="chat-model-controls">
      <label><span>{t('provider.current')}</span><select aria-label={t('provider.current')} value={selection?.providerId ?? ''} disabled={saving || !providers.some(item => item.enabled)} onChange={(event) => {
        const selected = event.target.value;
        void perform(() => onSelect(selected ? { providerId: selected, model: null } : null));
      }}>
        <option value="">{t('chat.followActiveProvider')}</option>
        {selection && !provider && <option disabled value={selection.providerId}>{t('chat.noProvider')}</option>}
        {providers.filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <ModelSelect models={catalog.key === key ? catalog.models : []} value={selection?.model ?? ''} onChange={selectModel} label={t('chat.model')}
        followDefault={provider ? `${t('chat.followDefaultModel')} (${provider.model})` : undefined} defaultModel={provider?.model}
        locale={locale} disabled={saving || !provider} loading={loading} onRefresh={() => setRevision((value) => value + 1)} refreshLabel={t('chat.refreshModels')}
        manualLabel={t('chat.manualModel')} manualIdLabel={t('chat.modelId')} manualUseLabel={t('chat.useModel')} catalogKey={key} showNotice={false} />
    </div>
    <small className="model-switch-hint">{t(saving ? 'chat.modelSaving' : running ? 'chat.modelNextTurn' : 'chat.modelShared')}</small>
    {failed && <p className="inline-error" role="alert">{t('chat.modelSaveFailed')}</p>}
    {catalog.key === key && catalog.failed && <small className="model-switch-hint">{t('chat.modelsUnavailable')}</small>}
    </div>
  </details>;
};
