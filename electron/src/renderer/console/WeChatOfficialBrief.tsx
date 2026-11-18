import { useEffect, useId, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ResolvedLocale } from '../../shared';
import { defaultWeChatOfficialBriefSettings, wechatOfficialBriefSettingsSchema } from '../../shared/wechat-digests';
import type { WeChatDigestsAPI, WeChatOfficialBriefSettings, WeChatOfficialBriefState } from '../../shared/wechat-digests';

const copy = {
  en: {
    title: 'Official account brief', description: 'Receive a daily brief in the owner’s private chat. Reply “收藏 2” to save an article, “展开 3” to open it, or “问 3” followed by your question.',
    enabled: 'Send a daily official account brief', time: 'Daily delivery time (local time)', limit: 'Maximum articles',
    accounts: 'Official account sources', all: 'All official accounts', specific: 'Selected official accounts only',
    empty: 'No official accounts are currently available from the local WeChat data.',
    clearMissing: 'Clear unavailable selections', keywords: 'Interests (one keyword per line)',
    cloud: 'Allow article content to be sent to cloud models',
    cloudInfo: 'When enabled, DeskPet can send the selected articles’ titles and text to the chosen cloud model for summaries. Otherwise it uses a local model when available.',
    provider: 'Cloud service for the brief', privateRoute: 'Use the owner’s private chat cloud service', missingService: 'Saved service unavailable',
    unavailable: 'WeChat’s official account list could not be read. You can still turn off the brief or stop using cloud models.',
    loading: 'Loading official account brief settings…', refresh: 'Refresh accounts',
    invalid: 'Choose at least one account in the selected list, set an article limit of 1–12, and use up to 16 keywords of 80 characters each.',
    loadError: 'Could not load official account brief settings.', saveError: 'Could not save official account brief settings.',
    saved: 'Official account brief settings saved.', save: 'Save official account brief settings', saving: 'Saving…',
  },
  'zh-CN': {
    title: '公众号简报', description: '简报每天只发给主人私聊。回复「收藏 2」「展开 3」或「问 3 你的问题」，可以收藏、查看或提问。',
    enabled: '每天发送公众号简报', time: '每天发送时间（本机时间）', limit: '最多选取篇数',
    accounts: '公众号来源', all: '全部公众号', specific: '仅选中的公众号',
    empty: '当前从微信本地数据中未读到可选的公众号。',
    clearMissing: '移除已不可用的公众号', keywords: '兴趣关键词（每行一个）',
    cloud: '允许将文章内容发给云端模型',
    cloudInfo: '开启后，所选云端模型可读取入选文章的标题和正文，用于生成摘要。关闭时，在本机模型可用的情况下使用本机模型。',
    provider: '简报使用的云端服务', privateRoute: '沿用主人私聊的云端服务', missingService: '已保存的服务不可用',
    unavailable: '暂时读不到微信里的公众号列表，仍可关闭简报或撤回云端处理权限。',
    loading: '正在读取公众号简报设置…', refresh: '刷新公众号列表',
    invalid: '指定公众号时至少选一个。篇数为 1～12，关键词最多 16 个，每个最多 80 个字符。',
    loadError: '未能读取公众号简报设置。', saveError: '未能保存公众号简报设置。',
    saved: '公众号简报设置已保存。', save: '保存公众号简报设置', saving: '正在保存…',
  },
};

const routeKey = (route: WeChatOfficialBriefSettings['provider']): string =>
  route === null ? '' : `${route.providerId}\n${route.model}`;
const routeOf = (provider: WeChatOfficialBriefState['providers'][number]) =>
  ({ providerId: provider.id, model: provider.model });

export function WeChatOfficialBriefSettingsPanel({ api, locale, disabled = false }: {
  api: Pick<WeChatDigestsAPI, 'getOfficialSettings' | 'setOfficialSettings'>;
  locale: ResolvedLocale;
  disabled?: boolean;
}): JSX.Element {
  const t = copy[locale];
  const id = useId();
  const [state, setState] = useState<WeChatOfficialBriefState | null>(null);
  const [draft, setDraft] = useState(defaultWeChatOfficialBriefSettings);
  const [limit, setLimit] = useState('5');
  const [keywords, setKeywords] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<'loadError' | 'saveError' | 'invalid' | 'saved' | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotice(null);
    void api.getOfficialSettings().then(value => {
      if (!active) return;
      setState(value);
      setDraft(value.settings);
      setLimit(String(value.settings.limit));
      setKeywords(value.settings.keywords.join('\n'));
    }).catch(() => {
      if (!active) return;
      setState(null);
      setNotice('loadError');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [api, revision]);

  const candidate = {
    ...draft, limit: Number(limit),
    keywords: [...new Set(keywords.split(/\n/u).map(keyword => keyword.trim()).filter(Boolean))],
  };
  const locked = disabled || loading || saving || state === null;
  const unchanged = JSON.stringify(candidate) === JSON.stringify(state?.settings);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (locked || unchanged) return;
    const parsed = wechatOfficialBriefSettingsSchema.safeParse(candidate);
    if (!parsed.success) { setNotice('invalid'); return; }
    setSaving(true);
    setNotice(null);
    try {
      await api.setOfficialSettings(parsed.data);
      setState(previous => previous && { ...previous, settings: parsed.data });
      setDraft(parsed.data);
      setLimit(String(parsed.data.limit));
      setKeywords(parsed.data.keywords.join('\n'));
      setNotice('saved');
    } catch {
      setNotice('saveError');
    } finally {
      setSaving(false);
    }
  };
  const update = (patch: Partial<WeChatOfficialBriefSettings>): void => {
    setNotice(null);
    setDraft(previous => ({ ...previous, ...patch }));
  };

  const available = state?.available === true;
  const accounts = state?.accounts ?? [];
  const providers = state?.providers ?? [];
  const selected = draft.accountIds ?? [];
  const missing = selected.some(accountId => !accounts.some(account => account.id === accountId));
  const provider = routeKey(draft.provider);
  return <section className="wechat-policy" aria-labelledby={id}>
    <h3 id={id}>{t.title}</h3>
    <p>{t.description}</p>
    {loading && <p role="status">{t.loading}</p>}
    {!loading && state?.available === false && <p className="muted">{t.unavailable}</p>}
    {notice && <p role={notice === 'saved' ? 'status' : 'alert'} className={notice === 'saved' ? undefined : 'error-banner'}>{t[notice]}</p>}
    <form className="stack-form wechat-cloud-route" onSubmit={event => void submit(event)}>
      {state && <fieldset className="stack-form wechat-cloud-route" disabled={locked}>
        <label className="wechat-option">
          <input type="checkbox" checked={draft.enabled} disabled={!available && !draft.enabled}
            onChange={event => update({ enabled: event.target.checked })} /><span>{t.enabled}</span>
        </label>
        <label>{t.time}<input type="time" required value={draft.time} onChange={event => update({ time: event.target.value })} /></label>
        <label>{t.limit}<input type="number" min={1} max={12} required value={limit}
          onChange={event => { setNotice(null); setLimit(event.target.value); }} /></label>
        <fieldset className="wechat-cloud-route" disabled={!available}>
          <legend>{t.accounts}</legend>
          <label className="wechat-option">
            <input type="radio" name={`${id}-scope`} checked={draft.accountIds === null}
              onChange={() => update({ accountIds: null })} /><span>{t.all}</span>
          </label>
          <label className="wechat-option">
            <input type="radio" name={`${id}-scope`} checked={draft.accountIds !== null}
              onChange={() => update({ accountIds: state.settings.accountIds ?? [] })} /><span>{t.specific}</span>
          </label>
          {available && draft.accountIds !== null && <>
            {accounts.length === 0 && <p>{t.empty}</p>}
            {accounts.map(account => <label key={account.id} className="wechat-option">
              <input type="checkbox" checked={selected.includes(account.id)}
                onChange={event => update({ accountIds: event.target.checked ? [...selected, account.id] : selected.filter(value => value !== account.id) })} />
              <span>{account.title}</span>
            </label>)}
            {missing && <button type="button" className="secondary" onClick={() =>
              update({ accountIds: selected.filter(accountId => accounts.some(account => account.id === accountId)) })}>{t.clearMissing}</button>}
          </>}
        </fieldset>
        <label>{t.keywords}<textarea rows={3} value={keywords} maxLength={16 * 81}
          onChange={event => { setNotice(null); setKeywords(event.target.value); }} /></label>
        <label className="wechat-option">
          <input type="checkbox" checked={draft.cloud} disabled={!available && !draft.cloud} aria-describedby={`${id}-cloud`}
            onChange={event => update({ cloud: event.target.checked })} /><span>{t.cloud}</span>
        </label>
        <small id={`${id}-cloud`} className="muted">{t.cloudInfo}</small>
        {draft.cloud && <label>{t.provider}<select value={provider} disabled={!available} onChange={event => {
          const selectedProvider = providers.find(item => routeKey(routeOf(item)) === event.target.value);
          update({ provider: selectedProvider ? routeOf(selectedProvider) : null });
        }}>
          <option value="">{t.privateRoute}</option>
          {draft.provider && !providers.some(item => routeKey(routeOf(item)) === provider) &&
            <option value={provider}>{t.missingService}</option>}
          {providers.map(item => <option value={routeKey(routeOf(item))} key={routeKey(routeOf(item))}>{item.name} · {item.model}</option>)}
        </select></label>}
      </fieldset>}
      <div className="button-row">
        {state && <button type="submit" disabled={locked || unchanged}>{saving ? t.saving : t.save}</button>}
        <button type="button" className="secondary" disabled={loading || saving || disabled}
          onClick={() => setRevision(value => value + 1)}>{t.refresh}</button>
      </div>
    </form>
  </section>;
}
