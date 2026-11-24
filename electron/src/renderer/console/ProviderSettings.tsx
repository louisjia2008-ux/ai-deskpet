import { useEffect, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ProviderConfig, ProviderModel } from '../../shared';
import { providerDefinitions } from '../../shared';
import { providerSetupText } from '../../shared/provider-setup-i18n';
import { providerSetupFailureText } from '../../shared/provider-setup-failure';
import { BoundModelSelect, ModelSelect } from './ModelSelect';
import './provider-setup.css';
import { DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from '../../shared/output-limits';
import type { DefaultModelChange, DefaultModelImpact, ModelChangeConsent } from '../../shared/model-bindings';
import { modelBindingLocation } from './ModelBindingIssues';

const endpointIdentity = (value: string): string => value.trim().replace(/\/+$/u, '');
import { ModelRoutingSettings } from './ModelRoutingSettings';
import { ConfirmButton } from './ConfirmButton';

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
  const [modelNotice, setModelNotice] = useState<DefaultModelChange | null>(null);
  const [confirmation, setConfirmation] = useState<{ impact: DefaultModelImpact; model: string; selected: string[] } | null>(null);
  const dialog = useRef<globalThis.HTMLDialogElement>(null);
  const resolveConfirmation = useRef<((value: ModelChangeConsent | null) => void) | null>(null);
  const mounted = useRef(false);
  const discovery = useRef({ revision: 0 }), saving = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const catalog = discovery.current;
    return () => { mounted.current = false; catalog.revision++; resolveConfirmation.current?.(null); };
  }, []);
  useEffect(() => {
    if (confirmation && !dialog.current?.open) dialog.current?.showModal();
    if (!confirmation && dialog.current?.open) dialog.current.close();
  }, [confirmation]);
  const definition = providerDefinitions.find((item) => item.kind === kind);
  const existing = editing && providers.find((provider) => provider.id === editing.id);
  const sameEndpoint = existing && existing.kind === kind && endpointIdentity(existing.baseUrl) === endpointIdentity(baseUrl);
  const keepsKey = sameEndpoint && existing.secretState === 'configured';
  const needsKey = definition?.apiKeyRequired !== false;
  const endpointChanged = Boolean(existing && !sameEndpoint);
  const changedSavedCredential = endpointChanged && existing?.secretState === 'configured';
  const credentialReady = (!needsKey && !changedSavedCredential) || apiKey.trim().length > 0 || keepsKey;
  const invalidateCatalog = (clearModel = true): void => {
    discovery.current.revision++; setModels([]); setLoading(false); setCatalogError(null); setCatalogLoaded(false);
    if (clearModel) { setModel(''); setModelUnverified(false); }
  };
  const changeKey = (value: string): void => {
    // A different key invalidates metadata, not the user's explicit model choice.
    // Provider/endpoint changes still clear that choice through the default path.
    invalidateCatalog(false); setApiKey(value); setModelUnverified(Boolean(model.trim()));
  };
  const perform = async (operation: () => Promise<unknown>, failureChannel?: 'providers:upsert'): Promise<void> => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(null); setModelNotice(null);
    try { await operation(); await refresh(); } catch (cause) { setError(failureChannel ? providerSetupFailureText(cause, failureChannel, locale) : t('common.error')); try { await refresh(); } catch { /* Keep the failure visible until authority can be read. */ } } finally { saving.current = false; setBusy(false); }
  };
  const approveModelChange = async (provider: ProviderConfig, next: string): Promise<ModelChangeConsent | null | undefined> => {
    if (provider.model === next || !window.deskpet.providers.defaultModelImpact) return undefined;
    const impact = await window.deskpet.providers.defaultModelImpact(provider.id);
    if (!mounted.current) return null;
    if (!impact || impact.previousModel !== provider.model) throw new Error('provider.defaultModelChanged');
    if (!impact.pinned.length) return { previousModel: impact.previousModel, followIds: [] };
    return new Promise(resolve => {
      resolveConfirmation.current = resolve;
      setConfirmation({ impact, model: next, selected: impact.pinned.map(binding => binding.id) });
    });
  };
  const finishConfirmation = (value: ModelChangeConsent | null): void => {
    resolveConfirmation.current?.(value);
    resolveConfirmation.current = null;
    setConfirmation(null);
  };
  const setDefaultModel = async (provider: ProviderConfig, next: string): Promise<void> => {
    const consent = await approveModelChange(provider, next);
    if (consent === null) return;
    const result = await window.deskpet.providers.setModel(provider.id, next, consent);
    setModelNotice(result.modelChange ?? null);
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
    const revision = ++discovery.current.revision; setLoading(true); setCatalogError(null); setModels([]); setCatalogLoaded(false);
    try {
      const list = await window.deskpet.providers.discoverModels({ kind, baseUrl,
        ...(apiKey ? { apiKey } : {}), ...(keepsKey && existing ? { existingProviderId: existing.id } : {}) });
      if (revision !== discovery.current.revision) return;
      const currentModels = list ?? [];
      setModels(currentModels); setCatalogLoaded(true);
      // With nothing chosen yet, pick the first model that can chat (embedding and reranker models cannot).
      if (!model.trim()) { const first = currentModels.find(item => !/embed|bge-|rerank|minilm|(^|[/:-])e5-|gte-/iu.test(item.id)); if (first) setModel(first.id); }
      setModelUnverified(Boolean(model.trim()) && !currentModels.some((item) => item.id === model.trim()));
    } catch (cause) { if (revision === discovery.current.revision) { setCatalogError(providerSetupFailureText(cause, 'providers:discover-models', locale)); setModels([]); } }
    finally { if (revision === discovery.current.revision) setLoading(false); }
  };
  // Look the models up by themselves once there is something to connect with: at once for a local
  // service, after the key is typed for a cloud one. A custom address keeps the manual button, so a key
  // is never sent to an address that is still being typed.
  const formOpen = adding || editing !== null || providers.length === 0;
  const officialAddress = baseUrl === providerDefinitions.find(item => item.kind === kind)?.defaultBaseUrl && !/example\.invalid/iu.test(baseUrl);
  const autoDiscover = formOpen && credentialReady && officialAddress;
  const lookupHost = ((): string => { try { return new URL(baseUrl).host; } catch { return ''; } })();
  const discoverRef = useRef(discover); discoverRef.current = discover;
  useEffect(() => {
    if (!autoDiscover) return;
    const timer = window.setTimeout(() => void discoverRef.current(), apiKey ? 800 : 0);
    return () => window.clearTimeout(timer);
  }, [autoDiscover, kind, baseUrl, apiKey]);
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!credentialReady || !model.trim() || loading) return;
    await perform(async () => {
      const consent = editing ? await approveModelChange(editing, model.trim()) : undefined;
      if (consent === null) return;
      const result = await window.deskpet.providers.upsert({ id: editing?.id ?? crypto.randomUUID(), kind, name: name.trim() || definition?.label || kind,
        baseUrl, model: model.trim(), enabled, supportsTools: tools,
        ...(localExecutionConfirmed || editing?.localExecutionConfirmed !== undefined ? { localExecutionConfirmed } : {}),
        ...(kind === 'ollama' && ollamaNumCtx ? { ollamaNumCtx: Number(ollamaNumCtx) } : {}),
        ...(contextWindow ? { contextWindowTokens: Number(contextWindow) } : {}),
        ...(outputLimit ? { maxOutputTokens: Number(outputLimit) } : {}),
        ...(outputParameter ? { outputTokenParameter: outputParameter } : {}),
        ...(apiKey ? { apiKey } : {}), ...(consent ? { consent } : {}) });
      edit(null); setAdding(false);
      setModelNotice(result.modelChange ?? null);
    }, 'providers:upsert');
  };
  const zh = locale === 'zh-CN';
  return <div><h2>{t('provider.title')}</h2>{error && <p className="error-banner" role="alert">{error}</p>}
    {modelNotice && <p role="status">{zh ? `${modelNotice.followers} 个功能会跟着使用新模型。` : `${modelNotice.followers} features will use the new model.`}
      {modelNotice.failed > 0 && (zh ? ` ${modelNotice.failed} 个功能未能改为跟随，请检查各功能的模型设置。` : ` Could not update ${modelNotice.failed} features. Check their model settings.`)}</p>}
    <dialog ref={dialog} className="provider-model-confirmation" aria-labelledby="provider-model-confirmation-title"
      onCancel={event => { event.preventDefault(); finishConfirmation(null); }}>
      {confirmation && <>
        <h3 id="provider-model-confirmation-title">{zh ? '同步单独指定的模型' : 'Update pinned models'}</h3>
        <p>{zh ? `这些功能固定使用 ${confirmation.impact.previousModel}。勾选要改为跟随默认模型（${confirmation.model}）的功能。`
          : `These features are pinned to ${confirmation.impact.previousModel}. Select the ones that should follow the default model (${confirmation.model}).`}</p>
        <div className="provider-model-confirmation-list">
          {confirmation.impact.pinned.map(binding => <label key={binding.id} className="check-row">
            <input type="checkbox" checked={confirmation.selected.includes(binding.id)} onChange={event => {
              const checked = event.currentTarget.checked;
              setConfirmation(current => current && { ...current, selected: checked
                ? [...current.selected, binding.id] : current.selected.filter(id => id !== binding.id) });
            }} />
            <span>{binding.label}<small>{modelBindingLocation(binding.feature, locale)}</small></span>
          </label>)}
        </div>
        <div className="button-row">
          <button type="button" className="secondary" onClick={() => finishConfirmation({ previousModel: confirmation.impact.previousModel, followIds: [] })}>{zh ? '保留' : 'Keep pins'}</button>
          <button type="button" disabled={confirmation.selected.length === 0}
            onClick={() => finishConfirmation({ previousModel: confirmation.impact.previousModel, followIds: confirmation.selected })}>{zh ? '一起改' : 'Update selected'}</button>
        </div>
      </>}
    </dialog>
    <div className="provider-list">{providers.map((provider) => <article key={provider.id} aria-label={provider.name}>
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
      {provider.secretState !== 'missing' && <ConfirmButton label={t('provider.clearKey')} confirmLabel={zh ? '确认移除（之后需要重新填写）' : 'Remove (you will need to enter it again)'} cancelLabel={t('common.cancel')} disabled={busy} onConfirm={() => void perform(() => window.deskpet.providers.clearSecret(provider.id))} />}
      <ConfirmButton label={t('common.delete')} confirmLabel={zh ? `确认删除「${provider.name}」和它保存的密钥` : `Delete ${provider.name} and its saved key`} cancelLabel={t('common.cancel')} disabled={busy} onConfirm={() => void perform(() => window.deskpet.providers.remove(provider.id))} />
    </div>
    {feedback[provider.id] && <small role="status">{feedback[provider.id]}</small>}
    {shownModels[provider.id] && <BoundModelSelect provider={provider} value={provider.model} label={`${provider.name} ${t('provider.model')}`} locale={locale} disabled={busy}
      onChange={(value) => void perform(() => setDefaultModel(provider, value))} />}
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
            {endpointChanged && <small>{text('provider.endpointKeyChanged')}</small>}{!credentialReady && <small>{text('provider.keyNeeded')}</small>}
            {officialAddress && lookupHost && <small>{locale === 'zh-CN' ? `填好后会自动连接 ${lookupHost} 读取模型。用自建地址的话，先在「高级连接设置」里改地址。` : `Once entered, models are looked up at ${lookupHost}. For your own gateway, change the address under Advanced connection settings first.`}</small>}</> : <><p>{locale === 'zh-CN' ? '本机服务的 API Key 可选；如果服务启用了身份验证，请在高级连接设置中填写。' : 'Local API keys are optional. If this service requires authentication, enter its key in advanced connection settings.'}</p>
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
    </form>}<ModelRoutingSettings providers={providers} locale={locale} />
  </div>;
};
