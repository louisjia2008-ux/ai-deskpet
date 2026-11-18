import { useEffect, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ProviderConfig, ProviderModel } from '../../shared';
import { providerDefinitions } from '../../shared';
import { providerSetupText } from '../../shared/provider-setup-i18n';
import { providerSetupFailureText } from '../../shared/provider-setup-failure';
import { BoundModelSelect, ModelSelect } from './ModelSelect';
import './provider-setup.css';
import { DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from '../../shared/output-limits';

const endpointIdentity = (value: string): string => value.trim().replace(/\/+$/u, '');
import { ModelRoutingSettings } from './ModelRoutingSettings';

export const ProviderSettings = ({ providers, activeId, t, refresh }: { providers: ProviderConfig[]; activeId: string | null; t(key: string): string; refresh(): Promise<void> }): JSX.Element => {
  const locale = t('provider.type') === '服务类型' ? 'zh-CN' : 'en';
  const text = providerSetupText(locale);
  const [editing, setEditing] = useState<ProviderConfig | null>(null);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<ProviderConfig['kind']>('openai');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState(providerDefinitions[0]?.defaultBaseUrl ?? '');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [tools, setTools] = useState(true);
  const [localExecutionConfirmed, setLocalExecutionConfirmed] = useState(false);
  const [ollamaNumCtx, setOllamaNumCtx] = useState('');
  const [contextWindow, setContextWindow] = useState('');
  const [outputLimit, setOutputLimit] = useState('');
  const [outputParameter, setOutputParameter] = useState<'' | 'max_tokens' | 'max_completion_tokens'>('');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null), [catalogError, setCatalogError] = useState<string | null>(null), [catalogLoaded, setCatalogLoaded] = useState(false);
  const [modelUnverified, setModelUnverified] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [shownModels, setShownModels] = useState<Record<string, boolean>>({});
  const [pendingEnabled, setPendingEnabled] = useState<Record<string, boolean>>({});
  const discovery = useRef(0), saving = useRef(false);
  useEffect(() => () => { discovery.current++; }, []);
  const definition = providerDefinitions.find((item) => item.kind === kind);
  const existing = editing && providers.find((provider) => provider.id === editing.id);
  const sameEndpoint = existing && existing.kind === kind && endpointIdentity(existing.baseUrl) === endpointIdentity(baseUrl);
  const keepsKey = sameEndpoint && existing.secretState === 'configured';
  const needsKey = definition?.apiKeyRequired !== false;
  const endpointChanged = Boolean(existing && !sameEndpoint);
  const changedSavedCredential = endpointChanged && existing?.secretState === 'configured';
  const credentialReady = (!needsKey && !changedSavedCredential) || apiKey.trim().length > 0 || keepsKey;
  const invalidateCatalog = (clearModel = true): void => {
    discovery.current++; setModels([]); setLoading(false); setCatalogError(null); setCatalogLoaded(false);
    if (clearModel) { setModel(''); setModelUnverified(false); }
  };
  const changeKey = (value: string): void => {
    // A different key invalidates metadata, not the user's explicit model choice.
    // Provider/endpoint changes still clear that choice through the default path.
    invalidateCatalog(false); setApiKey(value); setModelUnverified(Boolean(model.trim()));
  };
  const perform = async (operation: () => Promise<unknown>, failureChannel?: 'providers:upsert'): Promise<void> => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try { await operation(); await refresh(); } catch (cause) { setError(failureChannel ? providerSetupFailureText(cause, failureChannel, locale) : t('common.error')); try { await refresh(); } catch { /* Keep the failure visible until authority can be read. */ } } finally { saving.current = false; setBusy(false); }
  };
  const update = (provider: ProviderConfig, patch: Partial<ProviderConfig>) => {
    const { secretState: _secretState, ...config } = provider;
    void _secretState;
    return window.deskpet.providers.upsert({ ...config, ...patch });
  };
  const edit = (provider: ProviderConfig | null): void => {
    invalidateCatalog(); setEditing(provider); setKind(provider?.kind ?? 'openai'); setName(provider?.name ?? '');
    setBaseUrl(provider?.baseUrl ?? providerDefinitions[0]?.defaultBaseUrl ?? '');
    setModel(provider?.model ?? ''); setApiKey(''); setEnabled(provider?.enabled ?? true); setTools(provider?.supportsTools ?? true);
    setLocalExecutionConfirmed(provider?.localExecutionConfirmed ?? false);
    setOllamaNumCtx(provider?.ollamaNumCtx?.toString() ?? '');
    setContextWindow(provider?.contextWindowTokens?.toString() ?? '');
    setOutputLimit(provider?.maxOutputTokens?.toString() ?? '');
    setOutputParameter(provider?.outputTokenParameter ?? ''); setError(null);
  };
  const toggle = (provider: ProviderConfig, enabled: boolean): void => {
    setPendingEnabled((current) => ({ ...current, [provider.id]: enabled }));
    void perform(() => update(provider, { enabled })).finally(() => setPendingEnabled((current) => {
      const next = { ...current }; delete next[provider.id]; return next;
    }));
  };
  const discover = async (): Promise<void> => {
    if (!credentialReady || loading || busy) return;
    const revision = ++discovery.current; setLoading(true); setCatalogError(null); setModels([]); setCatalogLoaded(false);
    try {
      const list = await window.deskpet.providers.discoverModels({ kind, baseUrl,
        ...(apiKey ? { apiKey } : {}), ...(keepsKey && existing ? { existingProviderId: existing.id } : {}) });
      if (revision !== discovery.current) return;
      const currentModels = list ?? [];
      setModels(currentModels); setCatalogLoaded(true);
      setModelUnverified(Boolean(model.trim()) && !currentModels.some((item) => item.id === model.trim()));
    } catch (cause) { if (revision === discovery.current) { setCatalogError(providerSetupFailureText(cause, 'providers:discover-models', locale)); setModels([]); } }
    finally { if (revision === discovery.current) setLoading(false); }
  };
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!credentialReady || !model.trim() || loading) return;
    await perform(async () => {
      await window.deskpet.providers.upsert({ id: editing?.id ?? crypto.randomUUID(), kind, name: name.trim() || definition?.label || kind,
        baseUrl, model: model.trim(), enabled, supportsTools: tools,
        ...(localExecutionConfirmed || editing?.localExecutionConfirmed !== undefined ? { localExecutionConfirmed } : {}),
        ...(kind === 'ollama' && ollamaNumCtx ? { ollamaNumCtx: Number(ollamaNumCtx) } : {}),
        ...(contextWindow ? { contextWindowTokens: Number(contextWindow) } : {}),
        ...(outputLimit ? { maxOutputTokens: Number(outputLimit) } : {}),
        ...(outputParameter ? { outputTokenParameter: outputParameter } : {}),
        ...(apiKey ? { apiKey } : {}) });
      edit(null); setAdding(false);
    }, 'providers:upsert');
  };
  return <div><h2>{t('provider.title')}</h2>{error && <p className="error-banner" role="alert">{error}</p>}<div className="provider-list">{providers.map((provider) => <article key={provider.id} aria-label={provider.name}>
    <div><strong>{provider.name}</strong><small>{provider.kind} · {provider.model}</small></div>
    <span className="status-pill">{provider.kind === 'ollama' || provider.kind === 'lm-studio' ? t('provider.localNoKey') : t(provider.secretState === 'configured' ? 'provider.apiKeyStored' : 'provider.apiKeyMissing')}</span>
    {(provider.kind === 'ollama' || provider.kind === 'lm-studio') && !provider.localExecutionConfirmed && <small>{t('provider.memoryWithheld')}</small>}
    {provider.secretState === 'unavailable' && <small role="status">{text('provider.credentialsPending')}</small>}
    <label className="check-row"><input type="checkbox" checked={pendingEnabled[provider.id] ?? provider.enabled} disabled={busy} aria-label={`${t('provider.enabled')} ${provider.name}`} onChange={(event) => toggle(provider, event.target.checked)} />{t('provider.enabled')}</label>
    <div className="button-row">
      <button type="button" disabled={busy || !provider.enabled || activeId === provider.id} onClick={() => void perform(() => window.deskpet.providers.select(provider.id))}>{t(activeId === provider.id ? 'provider.currentChat' : 'provider.useChat')}</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => edit(provider)}>{t('common.edit')}</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => void perform(async () => { const result = await window.deskpet.providers.test(provider.id); setFeedback((items) => ({ ...items, [provider.id]: t(result.messageCode) })); })}>{t('provider.test')}</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => setShownModels((current) => ({ ...current, [provider.id]: !current[provider.id] }))}>{t('provider.models')}</button>
      <button type="button" className="text-button" disabled={busy || provider.secretState === 'missing'} onClick={() => void perform(() => window.deskpet.providers.clearSecret(provider.id))}>{t('provider.clearKey')}</button>
      <button type="button" className="text-button" disabled={busy} onClick={() => void perform(() => window.deskpet.providers.remove(provider.id))}>{t('common.delete')}</button>
    </div>
    {feedback[provider.id] && <small role="status">{feedback[provider.id]}</small>}
    {shownModels[provider.id] && <BoundModelSelect provider={provider} value={provider.model} label={`${provider.name} ${t('provider.model')}`} locale={locale} disabled={busy}
      onChange={(value) => void perform(() => window.deskpet.providers.setModel(provider.id, value))} />}
  </article>)}</div>
    {!(adding || editing !== null || providers.length === 0) ? <div className="provider-add"><button type="button" onClick={() => setAdding(true)}>{text('provider.add')}</button></div> : <form className="stack-form provider-form" aria-label={text('provider.setupTitle')} onSubmit={(event) => void save(event)}>
      <h3>{text('provider.setupTitle')}</h3><p className="provider-setup-intro">{text('provider.setupIntro')}</p>
      <div className="provider-setup-steps">
        <fieldset className="provider-step"><legend>1 · {t('provider.type')}</legend><label>{t('provider.type')}<select value={kind} disabled={busy} onChange={(event) => {
          const value = event.target.value as ProviderConfig['kind']; invalidateCatalog(); setKind(value); setApiKey(''); setName(''); setLocalExecutionConfirmed(false);
          setOllamaNumCtx(''); setContextWindow(''); setOutputLimit(''); setOutputParameter(''); setBaseUrl(providerDefinitions.find((item) => item.kind === value)?.defaultBaseUrl ?? '');
        }}>{providerDefinitions.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select></label></fieldset>
        <fieldset className="provider-step"><legend>2 · {t('provider.apiKey')}</legend>
          {needsKey ? <><label>{t('provider.apiKey')}<input type="password" autoComplete="off" disabled={busy} value={apiKey} placeholder={keepsKey ? t('provider.keepKey') : ''} onChange={(event) => changeKey(event.target.value)} /></label>
            {endpointChanged && <small>{text('provider.endpointKeyChanged')}</small>}{!credentialReady && <small>{text('provider.keyNeeded')}</small>}</> : <><p>{locale === 'zh-CN' ? '本机服务的 API Key 可选；如果服务启用了身份验证，请在高级连接设置中填写。' : 'Local API keys are optional. If this service requires authentication, enter its key in advanced connection settings.'}</p>
            {changedSavedCredential && <small>{text('provider.endpointKeyChanged')}</small>}</>}
        </fieldset>
        <fieldset className="provider-step"><legend>3 · {t('provider.model')}</legend>
          <button type="button" className="secondary" disabled={busy || loading || !credentialReady} onClick={() => void discover()}>{text(loading ? 'provider.loadingModels' : 'provider.loadModels')}</button>
          <ModelSelect models={models} value={model} onChange={setModel} label={t('provider.model')} locale={locale} disabled={busy || loading} failed={catalogError !== null} failureMessage={catalogError ?? undefined} catalogKey={`${kind}:${baseUrl}`}/>
          {modelUnverified && model.trim() && <small role="status">{text('provider.modelUnverified')}</small>}
          {catalogLoaded && models.length === 0 && <p role="status">{text('provider.catalogEmpty')}</p>}
          {(kind === 'ollama' || kind === 'lm-studio') && <label className="check-row"><input type="checkbox" checked={localExecutionConfirmed} disabled={busy}
            onChange={event => setLocalExecutionConfirmed(event.target.checked)} />{t('provider.localExecutionConfirmed')}</label>}
          {(kind === 'ollama' || kind === 'lm-studio') && <small>{t(localExecutionConfirmed ? 'provider.localExecutionDetail' : 'provider.memoryWithheld')}</small>}
          {!model.trim() && <small>{text('provider.modelNeeded')}</small>}
        </fieldset>
      </div>
      <details className="provider-advanced"><summary>{text('provider.advanced')}</summary><div className="stack-form">
        {!needsKey && <label>{t('provider.apiKey')}{locale === 'zh-CN' ? '（可选）' : ' (optional)'}<input type="password" autoComplete="off" disabled={busy} value={apiKey} placeholder={keepsKey ? t('provider.keepKey') : ''} onChange={(event) => changeKey(event.target.value)} /></label>}
        <label>{t('provider.name')}<input value={name} disabled={busy} maxLength={240} onChange={(event) => setName(event.target.value)} /></label>
        <label>{t('provider.baseUrl')}<input type="url" required disabled={busy} value={baseUrl} onChange={(event) => { invalidateCatalog(); setBaseUrl(event.target.value); setLocalExecutionConfirmed(false); }} /></label>
        <label className="check-row"><input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} />{t('provider.enabled')}</label>
        <label className="check-row"><input type="checkbox" checked={tools} disabled={busy} onChange={(event) => setTools(event.target.checked)} />{t('provider.tools')}</label>
        {kind === 'openai-compatible' && <><label className="check-row"><input type="checkbox" checked={localExecutionConfirmed} disabled={busy} onChange={event => setLocalExecutionConfirmed(event.target.checked)} />{t('provider.localExecutionConfirmed')}</label>
          <small>{t('provider.localExecutionDetail')}</small></>}
        {kind === 'ollama' && <><label>{t('provider.ollamaNumCtx')}<input type="number" min="512" max="131072" step="1" disabled={busy} value={ollamaNumCtx} onChange={event => setOllamaNumCtx(event.target.value)} /></label>
          <small>{t('provider.ollamaAllocation')}</small></>}
        <label>{t('provider.contextWindow')}<input type="number" min="512" max="131072" step="1" disabled={busy} value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} /></label>
        <small>{t('provider.contextFallback')}</small>
        <label>{t('provider.outputLimit')}<input type="number" min="1" max={MAX_OUTPUT_TOKENS} step="1" placeholder={String(DEFAULT_OUTPUT_TOKENS)} disabled={busy} value={outputLimit} onChange={(event) => setOutputLimit(event.target.value)} /></label>
        <label>{t('provider.outputParameter')}<select disabled={busy} value={outputParameter} onChange={(event) => setOutputParameter(event.target.value as typeof outputParameter)}>
          <option value="">{t('provider.outputParameterAuto')}</option><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option>
        </select></label>
      </div></details>
      <div className="button-row"><button type="submit" disabled={busy || loading || !credentialReady || !model.trim()}>{editing ? t('common.save') : t('provider.save')}</button>{editing && <button type="button" className="secondary" disabled={busy} onClick={() => edit(null)}>{t('common.cancel')}</button>}</div>
    </form>}<ModelRoutingSettings providers={providers} locale={locale} /><p className="notice">{t('provider.unsupported')}</p>
  </div>;
};
