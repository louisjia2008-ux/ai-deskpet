import { useState } from 'react';
import type { JSX } from 'react';
import type { ProviderConfig, UsageAPI, UsageCurrency, UsagePriceSnapshot, UsageRate, UsageRateInput, UsageSnapshot } from '../../shared';

const labels = {
  en: {
    title: 'Model prices', intro: 'Official reference prices apply automatically to supported exact models and endpoints. For a proxy, discount or custom model, save your own token prices.',
    provider: 'Provider', model: 'Exact model ID', currency: 'Currency', input: 'Input / million tokens', output: 'Output / million tokens', cached: 'Cache read / million tokens', write: 'Cache write / million tokens',
    optional: 'Leave cache prices blank if unknown. Enter 0 only when that category is free.',
    save: 'Save custom price', remove: 'Remove custom price', fill: 'Fill from current price', refresh: 'Refresh model catalog', working: 'Saving…',
    saved: 'Custom price saved. Existing request price snapshots are retained.', removed: 'Custom price removed. Available automatic prices apply to future requests.',
    refreshed: 'Model catalog refreshed. Supported API prices are used when available.', failed: 'Could not save or refresh prices. Saved records are retained; try again.',
    invalid: 'Enter finite, nonnegative prices and an exact model ID. Complete all long-context prices when a threshold is set.',
    missingProvider: 'Add a provider in Settings to configure a custom price.', unknown: 'No automatic or custom price for this model and endpoint.',
    reference: 'Official reference', api: 'Provider catalog', manual: 'Custom price', checked: 'Price checked', endpoint: 'Endpoint',
    legacy: 'An older custom price has no saved endpoint. Fill and save it to bind it to this endpoint.', fillLegacy: 'Fill from older price',
    scope: 'A custom price overrides the automatic price for this provider, exact model ID and endpoint. New requests retain their price snapshot. Requests without a saved price may be supplemented with the current price and are labelled accordingly.',
    tier: 'Long-context price (optional)', threshold: 'Input threshold (tokens)', tierInput: 'Long input / million', tierOutput: 'Long output / million', tierCached: 'Long cache read / million', tierWrite: 'Long cache write / million',
    tierNote: 'The higher tier applies to the whole request when reported input exceeds this threshold. Leave the threshold blank for a single rate.',
  },
  'zh-CN': {
    title: '模型费率', intro: '支持的官方模型会按精确模型与接口地址自动使用参考价。中转、折扣或自定义模型可以填写自己的 Token 单价。',
    provider: '模型服务', model: '精确模型 ID', currency: '币种', input: '输入单价／百万 Token', output: '输出单价／百万 Token', cached: '缓存读取单价／百万 Token', write: '缓存写入单价／百万 Token',
    optional: '缓存单价未知时留空；只有该项免费时才填写 0。',
    save: '保存自定义费率', remove: '移除自定义费率', fill: '填入当前费率', refresh: '刷新模型目录', working: '正在保存…',
    saved: '自定义费率已保存，已有请求的费率快照保留。', removed: '自定义费率已移除；后续请求使用可用的自动参考价。',
    refreshed: '模型目录已刷新；如有支持的接口价格，将用于估算。', failed: '无法保存或刷新费率。已保存记录保留，请重试。',
    invalid: '请填写有效的非负单价与精确模型 ID；设置长上下文门槛时，请补齐该档输入、输出价。',
    missingProvider: '请先在设置中添加模型服务，再配置自定义费率。', unknown: '该模型与接口地址暂无自动或自定义费率。',
    reference: '官方参考价', api: '官方标价', manual: '自定义费率', checked: '价格核对时间', endpoint: '接口地址',
    legacy: '旧自定义费率未记录接口地址；填入后保存，才会绑定到当前接口。', fillLegacy: '填入旧费率',
    scope: '自定义费率覆盖此模型服务、精确模型 ID 和接口地址的自动参考价。新请求保留当时的费率快照；没有费率快照的请求可按当前价格补算，并单独标注。',
    tier: '长上下文费率（可选）', threshold: '输入门槛（Token）', tierInput: '长上下文输入单价／百万', tierOutput: '长上下文输出单价／百万', tierCached: '长上下文缓存读取单价／百万', tierWrite: '长上下文缓存写入单价／百万',
    tierNote: '实报输入超过门槛时，整次请求使用高档费率。只有一个档位时将门槛留空。',
  },
};

/** Legacy USD rates remain editable without rewriting their historical records. */
export const displayUsageRate = (rate: UsageRate): UsagePriceSnapshot => 'price' in rate ? rate.price : {
  currency: 'USD', inputPerMillion: rate.inputUSDPerMillion, outputPerMillion: rate.outputUSDPerMillion,
  source: 'manual', endpoint: 'legacy:unrecorded', checkedAt: rate.updatedAt,
};

interface Fields { currency: UsageCurrency; input: string; output: string; cached: string; write: string; threshold: string; tierInput: string; tierOutput: string; tierCached: string; tierWrite: string }
const emptyFields = (): Fields => ({ currency: 'USD', input: '', output: '', cached: '', write: '', threshold: '', tierInput: '', tierOutput: '', tierCached: '', tierWrite: '' });
const fromPrice = (price: UsagePriceSnapshot): Fields => ({ currency: price.currency, input: String(price.inputPerMillion), output: String(price.outputPerMillion),
  cached: price.cachedInputPerMillion == null ? '' : String(price.cachedInputPerMillion), write: price.cacheWriteInputPerMillion == null ? '' : String(price.cacheWriteInputPerMillion),
  threshold: price.longContext ? String(price.longContext.inputThreshold) : '', tierInput: price.longContext ? String(price.longContext.inputPerMillion) : '', tierOutput: price.longContext ? String(price.longContext.outputPerMillion) : '',
  tierCached: price.longContext?.cachedInputPerMillion == null ? '' : String(price.longContext.cachedInputPerMillion), tierWrite: price.longContext?.cacheWriteInputPerMillion == null ? '' : String(price.longContext.cacheWriteInputPerMillion) });
const amount = (value: string): number => value.trim() === '' ? Number.NaN : Number(value);
const optionalAmount = (value: string): number | null => value.trim() === '' ? null : amount(value);
const validPrice = (value: number | null): boolean => value === null || Number.isFinite(value) && value >= 0 && value <= 1_000_000;
const normalizedEndpoint = (provider?: ProviderConfig): string => {
  if (!provider) return '';
  try { const url = new URL(provider.baseUrl); url.pathname = url.pathname.replace(/\/+$/u, ''); return url.toString(); }
  catch { return ''; }
};

export const UsageRateEditor = ({ api, providers, snapshot, locale, onSnapshot, refreshPrices }: {
  api: UsageAPI; providers: ProviderConfig[]; snapshot: UsageSnapshot; locale: string;
  onSnapshot(snapshot: UsageSnapshot): void; refreshPrices?: ((providerId: string) => Promise<void>) | undefined;
}): JSX.Element => {
  const text = labels[locale === 'zh-CN' ? 'zh-CN' : 'en'];
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const provider = providers.find(item => item.id === providerId) ?? providers[0];
  const [model, setModel] = useState(provider?.model ?? ''), [fields, setFields] = useState<Fields>(emptyFields);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [error, setError] = useState('');
  const matching = snapshot.rates.filter(rate => rate.providerId === provider?.id && rate.model === model.trim());
  const scoped = matching.filter(rate => 'price' in rate && rate.price.endpoint === normalizedEndpoint(provider));
  const currentRate = scoped.find(rate => displayUsageRate(rate).source === 'manual') ?? scoped.find(rate => displayUsageRate(rate).source === 'provider-api') ?? scoped[0];
  const current = currentRate ? displayUsageRate(currentRate) : undefined;
  const legacyRate = matching.find(rate => !('price' in rate));
  const editable = current ?? (legacyRate ? displayUsageRate(legacyRate) : undefined);
  const custom = current?.source === 'manual';
  const set = (name: keyof Fields, value: string): void => { setFields(previous => ({ ...previous, [name]: value })); setStatus(''); setError(''); };
  const run = async (operation: () => Promise<UsageSnapshot>, success: string): Promise<void> => {
    setBusy(true); setError(''); setStatus('');
    try { const next = await operation(); onSnapshot(next); setStatus(success); }
    catch { setError(text.failed); }
    finally { setBusy(false); }
  };
  const save = async (): Promise<void> => {
    if (!provider || !api.upsertRate) return;
    const input: UsageRateInput = { providerId: provider.id, model: model.trim(), currency: fields.currency,
      inputPerMillion: amount(fields.input), outputPerMillion: amount(fields.output), cachedInputPerMillion: optionalAmount(fields.cached), cacheWriteInputPerMillion: optionalAmount(fields.write) };
    if (fields.threshold.trim() !== '') input.longContext = { inputThreshold: amount(fields.threshold), inputPerMillion: amount(fields.tierInput), outputPerMillion: amount(fields.tierOutput),
      cachedInputPerMillion: optionalAmount(fields.tierCached), cacheWriteInputPerMillion: optionalAmount(fields.tierWrite) };
    if (!input.model || input.model.length > 240 || [...input.model].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || ![input.inputPerMillion, input.outputPerMillion, input.cachedInputPerMillion ?? null, input.cacheWriteInputPerMillion ?? null].every(validPrice)
      || input.longContext && (!Number.isSafeInteger(input.longContext.inputThreshold) || input.longContext.inputThreshold <= 0
        || ![input.longContext.inputPerMillion, input.longContext.outputPerMillion, input.longContext.cachedInputPerMillion ?? null, input.longContext.cacheWriteInputPerMillion ?? null].every(validPrice))) {
      setError(text.invalid); setStatus(''); return;
    }
    await run(() => api.upsertRate!(input), text.saved);
  };
  const field = (name: Exclude<keyof Fields, 'currency'>, label: string, integer = false): JSX.Element => <label>{label}<input type="number" min={integer ? 1 : 0} max={integer ? Number.MAX_SAFE_INTEGER : 1_000_000} step={integer ? 1 : 'any'} value={fields[name]} onChange={event => set(name, event.target.value)} /></label>;
  return <details className="usage-rate-editor"><summary>{text.title}</summary>
    <p>{text.intro}</p>
    {providers.length === 0 ? <p>{text.missingProvider}</p> : <>
      <form aria-label={text.title} onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy}><div className="usage-rate-fields">
          <label>{text.provider}<select aria-label={text.provider} value={provider?.id ?? ''} onChange={event => { const next = providers.find(item => item.id === event.target.value); setProviderId(event.target.value); setModel(next?.model ?? ''); setFields(emptyFields()); setStatus(''); setError(''); }}>
            {providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <label>{text.model}<input value={model} maxLength={240} required onChange={event => { setModel(event.target.value); setFields(emptyFields()); setStatus(''); setError(''); }} /></label>
          <label>{text.currency}<select aria-label={text.currency} value={fields.currency} onChange={event => set('currency', event.target.value)}><option value="USD">USD</option><option value="CNY">CNY</option></select></label>
          {field('input', text.input)}{field('output', text.output)}{field('cached', text.cached)}{field('write', text.write)}
        </div><p className="usage-note">{text.optional}</p>
          <details className="usage-rate-tier"><summary>{text.tier}</summary><p className="usage-note">{text.tierNote}</p><div className="usage-rate-fields">
            {field('threshold', text.threshold, true)}{field('tierInput', text.tierInput)}{field('tierOutput', text.tierOutput)}{field('tierCached', text.tierCached)}{field('tierWrite', text.tierWrite)}
          </div></details>
          <div className="usage-rate-actions"><button type="submit" disabled={!api.upsertRate}>{busy ? text.working : text.save}</button>
            {editable && <button type="button" className="secondary" onClick={() => { setFields(fromPrice(editable)); setError(''); setStatus(''); }}>{current ? text.fill : text.fillLegacy}</button>}
            {custom && api.removeRate && <button type="button" className="secondary" onClick={() => void run(() => api.removeRate!({ providerId: provider!.id, model: model.trim() }), text.removed)}>{text.remove}</button>}
            {refreshPrices && <button type="button" className="secondary" onClick={() => void run(async () => { await refreshPrices(provider!.id); return api.snapshot(); }, text.refreshed)}>{text.refresh}</button>}
          </div>
        </fieldset>
      </form>
      {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
      <div className="usage-active-price">{current ? <>
        <strong>{current.source === 'manual' ? text.manual : current.source === 'provider-api' ? text.api : text.reference} · {current.currency}</strong>
        <span>{text.input}: {current.inputPerMillion} · {text.output}: {current.outputPerMillion}</span>
        <small>{text.checked}: {new Date(current.checkedAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}</small>
        {current.sourceUrl && <code>{current.sourceUrl}</code>}{current.note && <small>{current.note}</small>}
      </> : <span>{text.unknown}</span>}<small>{text.endpoint}: {provider?.baseUrl}</small></div>
      {legacyRate && <p className="usage-note">{text.legacy}</p>}
    </>}
    <p className="usage-note">{text.scope}</p>
  </details>;
};
