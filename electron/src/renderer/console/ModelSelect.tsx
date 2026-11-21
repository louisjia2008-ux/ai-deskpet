import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ProviderConfig, ProviderModel } from '../../shared';
import { providerSetupText } from '../../shared/provider-setup-i18n';
import './provider-setup.css';

const number = (value: number | null | undefined, unknown: string): string => typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 }).format(value) : unknown;
export const modelPriceLabel = (model: ProviderModel | undefined, locale: string): string => {
  const text = providerSetupText(locale), price = model?.pricing;
  if (!price) return text('provider.priceUnknown');
  const unknown = locale === 'zh-CN' ? '未知' : 'unknown';
  return `${price.currency} ${text('provider.priceInput')} ${number(price.inputPerMillion, unknown)} / ${text('provider.priceOutput')} ${number(price.outputPerMillion, unknown)} · ${text('provider.priceUnit')}`;
};

export const ModelSelect = ({ models, value, onChange, label, locale = 'en', disabled = false, loading = false, failed = false, followDefault, defaultModel,
  onRefresh, refreshLabel, manualLabel, manualIdLabel, manualUseLabel, catalogKey = '', showNotice = true, failureMessage }: {
  models: ProviderModel[]; value: string; onChange(value: string): void; label: string; locale?: string; disabled?: boolean; loading?: boolean; failed?: boolean;
  onRefresh?(): void; refreshLabel?: string; manualLabel?: string; manualIdLabel?: string; manualUseLabel?: string; catalogKey?: string; showNotice?: boolean;
  failureMessage?: string | undefined;
  followDefault?: string | undefined;
  defaultModel?: string | undefined;
}): JSX.Element => {
  const text = providerSetupText(locale);
  const [search, setSearch] = useState(''), [manual, setManual] = useState('');
  useEffect(() => { setSearch(''); setManual(''); }, [catalogKey]);
  const choices = useMemo(() => {
    const seen = new Map<string, ProviderModel>();
    for (const model of models) if (model.id && model.id.length <= 240 && !seen.has(model.id)) seen.set(model.id, model);
    if (value && !seen.has(value)) seen.set(value, { id: value, displayName: value, contextWindow: null, supportsTools: false });
    return [...seen.values()];
  }, [models, value]);
  const displayedModel = value || defaultModel;
  const selected = choices.find((model) => model.id === displayedModel);
  const needle = search.toLocaleLowerCase().trim();
  const filtered = choices.filter((model) => model.id === value || !needle || `${model.id} ${model.displayName}`.toLocaleLowerCase().includes(needle));
  const validManual = manual.trim().length > 0 && manual.trim().length <= 240 && ![...manual].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  return <div className="model-select">
    <div className="model-select-controls">
      <label>{text('provider.modelSearch')}<input type="search" aria-label={`${label} ${text('provider.modelSearch')}`} value={search} disabled={disabled} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} onChange={(event) => setSearch(event.target.value)} /></label>
      <label>{label}<select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {(followDefault || !value) && <option value="">{followDefault ?? text('provider.modelChoose')}</option>}
        {filtered.map((model) => <option key={model.id} value={model.id}>{model.displayName === model.id ? model.id : `${model.displayName} (${model.id})`} · {modelPriceLabel(model, locale)}</option>)}
      </select></label>
      {onRefresh && <button type="button" className="secondary" disabled={disabled || loading} onClick={onRefresh}>{loading ? text('provider.loadingModels') : refreshLabel ?? text('provider.loadModels')}</button>}
    </div>
    {displayedModel && <div className="model-price-detail" data-model-price={displayedModel}>
      <strong>{modelPriceLabel(selected, locale)}</strong>
      {selected?.pricing && <><small>{text(selected.pricing.source === 'provider-api' ? 'provider.priceAPI' : 'provider.priceReference')} · {text('provider.priceChecked')}: {selected.pricing.checkedAt}</small>
        <small className="model-price-source">{selected.pricing.sourceUrl}</small>{selected.pricing.note && <small>{selected.pricing.note}</small>}</>}
      {selected?.availability === 'reference' && <small>{text('provider.referenceAvailability')}</small>}
      <small>{text('provider.priceNote')}</small>
    </div>}
    {failed && <><p className="inline-error" role="status">{failureMessage || text('provider.catalogError')}</p>
      {failureMessage && failureMessage !== text('provider.catalogError') && <small>{text('provider.catalogError')}</small>}</>}
    {showNotice && <small className="model-catalog-notice">{text('provider.catalogNotice')}</small>}
    <details className="manual-chat-model"><summary>{manualLabel ?? text('provider.modelManual')}</summary><div className="model-manual-row">
      <label>{manualIdLabel ?? text('provider.modelManualId')}<input aria-label={manualIdLabel ?? `${label} ${text('provider.modelManualId')}`} maxLength={240} value={manual} disabled={disabled} placeholder={value} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (validManual && !disabled) onChange(manual.trim()); } }} onChange={(event) => setManual(event.target.value)} /></label>
      <button type="button" className="secondary" disabled={disabled || !validManual} onClick={() => onChange(manual.trim())}>{manualUseLabel ?? text('provider.modelManualUse')}</button>
    </div></details>
  </div>;
};

/** Each bound picker owns its catalog; it never changes a provider's saved model. */
export const BoundModelSelect = ({ provider, value, onChange, label, locale, disabled = false, followDefault }: {
  provider: ProviderConfig | undefined; value: string; onChange(value: string): void; label: string; locale: string; disabled?: boolean;
  followDefault?: string | undefined;
}): JSX.Element => {
  const [catalog, setCatalog] = useState<{ key: string; models: ProviderModel[] }>({ key: '', models: [] });
  const [loading, setLoading] = useState(false), [failed, setFailed] = useState(false), [revision, setRevision] = useState(0);
  const catalogEpoch = useRef(0);
  useEffect(() => {
    const api = window.deskpet.providers;
    if (typeof api.onChanged !== 'function') return;
    let subscribed = true;
    const stop = api.onChanged(() => {
      if (!subscribed) return;
      // A key rotation can keep all public config fields unchanged.
      catalogEpoch.current++; setCatalog({ key: '', models: [] }); setFailed(false);
      setRevision((current) => current + 1);
    });
    return () => { subscribed = false; stop(); };
  }, []);
  const id = provider?.id, kind = provider?.kind, baseUrl = provider?.baseUrl, secretState = provider?.secretState;
  const key = `${id ?? ''}:${kind ?? ''}:${baseUrl ?? ''}:${secretState ?? ''}`;
  useEffect(() => {
    let active = true; const epoch = ++catalogEpoch.current; setCatalog({ key, models: [] }); setFailed(false);
    if (!id) { setLoading(false); return; }
    setLoading(true);
    void window.deskpet.providers.listModels(id).then((models) => { if (active && catalogEpoch.current === epoch) setCatalog({ key, models: models ?? [] }); })
      .catch(() => { if (active && catalogEpoch.current === epoch) setFailed(true); })
      .finally(() => { if (active && catalogEpoch.current === epoch) setLoading(false); });
    return () => { active = false; };
  }, [id, key, revision]);
  return <ModelSelect models={catalog.key === key ? catalog.models : []} value={value} onChange={onChange} label={label} locale={locale} disabled={disabled || !provider} loading={loading} failed={failed}
    onRefresh={() => setRevision((current) => current + 1)} catalogKey={key} followDefault={followDefault} />;
};
