import { useEffect, useId, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ResolvedLocale } from '../../shared';
import { defaultWeChatDigestGroupSettings, wechatDigestGroupSettingsSchema } from '../../shared/wechat-digests';
import type { WeChatDigestGroupSettings, WeChatDigestGroupState, WeChatDigestsAPI, WeChatGroupDigestResult } from '../../shared/wechat-digests';

const copy = {
  en: {
    title: 'Daily group digests', time: 'Daily delivery time (local time)', groups: 'Groups to digest', replying: ' (she replies here)',
    privacy: 'DeskPet summarizes the groups selected here. In groups where she already replies, she keeps replying under that group’s rules; she never replies in the others. Digests go only to the owner’s private chat, during allowed hours.',
    cloudDetail: 'Cloud processing sends recent messages from that group to the selected model. It starts on for a newly selected group. Turn it off to use a local model. If no local model is available, that group is skipped.',
    cloud: 'Allow sending to cloud models', provider: 'Cloud service for digests', followPrivate: 'Use the owner’s private chat cloud service',
    missingProvider: 'Saved service unavailable', keywords: 'Keywords to watch (one per line)', maxGroups: 'You can select up to 12 groups.',
    noGroups: 'There are no groups to select.', removeMissing: 'Clear unavailable selections',
    refresh: 'Refresh', save: 'Save group digests', saving: 'Saving…', saved: 'Group digest settings saved.',
    invalid: 'Enter a valid time and up to 16 keywords with at most 80 characters each.',
    unavailable: 'DeskPet could not read the group list from WeChat. Refresh to try again.',
    loadError: 'Could not read group digest settings.', saveError: 'Could not save group digest settings.',
    loading: 'Loading group digests…', resultsError: 'Could not read the daily digests.',
    empty: 'Daily group digests will appear here after the first run.',
    expand: 'Show details', sent: 'Sent to owner’s private chat', uncertain: 'Delivery could not be confirmed',
    pending: 'Waiting for delivery confirmation', failed: 'Some groups could not be summarized or private delivery was incomplete.',
    interrupted: 'The run stopped early. Results generated so far are shown here.',
  },
  'zh-CN': {
    title: '群聊每日精华', time: '每天发送时间（本机时间）', groups: '选择要整理的群', replying: '（她会回复的群）',
    privacy: '这里选中的群每天整理一份精华。她本来会回复的群照常按群规则回复；其他选中的群只看不说。精华只发给主人私聊，并遵守安静时段。',
    cloudDetail: '新选中的群默认开启云端处理，会将该群的近期消息发给选定模型。每个群都可以单独关闭，关闭后使用本机模型。本机模型不可用时会跳过该群。',
    cloud: '允许发送给云端模型', provider: '精华使用的云端服务', followPrivate: '沿用主人私聊的云端服务',
    missingProvider: '已保存的服务不可用', keywords: '关注关键词（每行一个）', maxGroups: '最多可选择 12 个群。',
    noGroups: '暂时没有可选择的群。', removeMissing: '移除已不可用的群',
    refresh: '刷新', save: '保存群聊精华设置', saving: '正在保存…', saved: '群聊精华设置已保存。',
    invalid: '请输入有效时间，关键词最多 16 个，每个最多 80 个字符。',
    unavailable: '暂时读不到微信里的群列表，请刷新后重试。',
    loadError: '未能读取群聊精华设置。', saveError: '未能保存群聊精华设置。',
    loading: '正在读取群聊精华…', resultsError: '未能读取每日精华。',
    empty: '首次生成后，群聊精华会显示在这里。',
    expand: '查看详细版', sent: '已发到主人私聊', uncertain: '未能确认是否送达',
    pending: '等待确认私聊送达', failed: '部分群未能生成精华，或私聊发送未完成。',
    interrupted: '处理已中断，已生成的结果仍可查看。',
  },
};

const providerKey = (route: WeChatDigestGroupSettings['provider']): string =>
  route === null ? '' : `${route.providerId}\n${route.model}`;
const routeOf = (provider: WeChatDigestGroupState['providers'][number]) =>
  ({ providerId: provider.id, model: provider.model });

export function WeChatGroupDigestSettings({ api, locale, disabled = false }: {
  api: Pick<WeChatDigestsAPI, 'getGroupSettings' | 'setGroupSettings'>;
  locale: ResolvedLocale;
  disabled?: boolean;
}): JSX.Element {
  const t = copy[locale];
  const title = useId();
  const [state, setState] = useState<WeChatDigestGroupState | null>(null);
  const [draft, setDraft] = useState<WeChatDigestGroupSettings>(defaultWeChatDigestGroupSettings);
  const [keywords, setKeywords] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<'loadError' | 'saveError' | 'invalid' | 'saved' | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotice(null);
    void api.getGroupSettings().then(value => {
      if (!active) return;
      setState(value);
      setDraft(value.settings);
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

  const candidate = { ...draft, keywords: [...new Set(keywords.split(/\n/u).map(word => word.trim()).filter(Boolean))] };
  const unchanged = JSON.stringify(candidate) === JSON.stringify(state?.settings);
  const locked = disabled || loading || saving || state?.available !== true;
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (locked || unchanged) return;
    const parsed = wechatDigestGroupSettingsSchema.safeParse(candidate);
    if (!parsed.success) { setNotice('invalid'); return; }
    setSaving(true);
    setNotice(null);
    try {
      await api.setGroupSettings(parsed.data);
      setState(previous => previous && { ...previous, settings: parsed.data });
      setDraft(parsed.data);
      setKeywords(parsed.data.keywords.join('\n'));
      setNotice('saved');
    } catch {
      setNotice('saveError');
    } finally {
      setSaving(false);
    }
  };
  const update = (patch: Partial<WeChatDigestGroupSettings>) => {
    setNotice(null);
    setDraft(previous => ({ ...previous, ...patch }));
  };

  const providers = state?.providers ?? [];
  const available = state?.groups ?? [];
  const missing = draft.groups.some(group => !available.some(option => option.id === group.id));
  const route = providerKey(draft.provider);
  return <section className="wechat-policy" aria-labelledby={title}>
    <h3 id={title}>{t.title}</h3>
    <p>{t.privacy}</p>
    {loading && <p role="status">{t.loading}</p>}
    {!loading && state?.available === false && <p className="muted">{t.unavailable}</p>}
    {notice && <p role={notice === 'saved' ? 'status' : 'alert'} className={notice === 'saved' ? undefined : 'error-banner'}>{t[notice]}</p>}
    <form className="stack-form wechat-cloud-route" onSubmit={event => void submit(event)}>
      {state?.available && <fieldset disabled={locked} className="stack-form wechat-cloud-route">
        <label>{t.time}<input type="time" value={draft.time} required onChange={event => update({ time: event.target.value })} /></label>
        <label>{t.provider}<select value={route} onChange={event => {
          const selected = providers.find(provider => providerKey(routeOf(provider)) === event.target.value);
          update({ provider: selected ? routeOf(selected) : null });
        }}>
          <option value="">{t.followPrivate}</option>
          {draft.provider && !providers.some(provider => providerKey(routeOf(provider)) === route) &&
            <option value={route}>{t.missingProvider}</option>}
          {providers.map(provider => <option value={providerKey(routeOf(provider))} key={providerKey(routeOf(provider))}>{provider.name} · {provider.model}</option>)}
        </select></label>
        <label>{t.keywords}<textarea rows={3} value={keywords} maxLength={16 * 81} onChange={event => { setNotice(null); setKeywords(event.target.value); }} /></label>
        <fieldset className="wechat-cloud-route">
          <legend>{t.groups}</legend>
          <small>{t.cloudDetail}</small>
          {available.length === 0 && <p>{t.noGroups}</p>}
          {available.map(group => {
            const selection = draft.groups.find(item => item.id === group.id);
            const toggle = (selected: boolean): void => {
              const saved = state.settings.groups.find(item => item.id === group.id);
              update({ groups: selected
                ? [...draft.groups, { id: group.id, cloud: saved?.cloud ?? true }]
                : draft.groups.filter(item => item.id !== group.id) });
            };
            return <div key={group.id} className="wechat-cloud-route">
              <label className="wechat-option">
                <input type="checkbox" checked={selection !== undefined} disabled={!selection && draft.groups.length >= 12}
                  onChange={event => toggle(event.target.checked)} /><span>{group.title}{group.replying && t.replying}</span>
              </label>
              {selection && <label className="wechat-option">
                <input type="checkbox" checked={selection.cloud} onChange={event =>
                  update({ groups: draft.groups.map(item => item.id === group.id ? { ...item, cloud: event.target.checked } : item) })} />
                <span>{t.cloud} · {group.title}</span>
              </label>}
            </div>;
          })}
          {draft.groups.length >= 12 && <small className="muted">{t.maxGroups}</small>}
          {missing && <button type="button" className="secondary" onClick={() =>
            update({ groups: draft.groups.filter(group => available.some(option => option.id === group.id)) })}>{t.removeMissing}</button>}
        </fieldset>
      </fieldset>}
      <div className="button-row">
        {state?.available && <button type="submit" disabled={locked || unchanged}>{saving ? t.saving : t.save}</button>}
        <button type="button" className="secondary" disabled={loading || saving || disabled}
          onClick={() => setRevision(value => value + 1)}>{t.refresh}</button>
      </div>
    </form>
  </section>;
}

export function WeChatGroupDigestResults({ api, locale }: {
  api: Pick<WeChatDigestsAPI, 'groupResults'>; locale: ResolvedLocale;
}): JSX.Element {
  const t = copy[locale];
  const [results, setResults] = useState<WeChatGroupDigestResult[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState(false);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  useEffect(() => {
    let active = true;
    setResults(null);
    setError(false);
    void api.groupResults().then(value => {
      if (active) setResults(value);
    }).catch(() => {
      if (active) setError(true);
    });
    return () => { active = false; };
  }, [api, revision]);

  const delivery = (value: string) => value === 'succeeded' ? t.sent
    : value === 'uncertain' ? t.uncertain : value === 'delivering' ? t.pending
      : value === 'interrupted' ? t.interrupted : t.failed;
  return <section role="tabpanel" aria-label={t.title}>
    <div className="button-row">
      <button type="button" className="secondary" disabled={results === null && !error}
        onClick={() => setRevision(value => value + 1)}>{t.refresh}</button>
    </div>
    {error && <p className="error-banner" role="alert">{t.resultsError}</p>}
    {results === null && !error && <p role="status">{t.loading}</p>}
    {results?.length === 0 && <p>{t.empty}</p>}
    {results?.map(result => <section className="panel" key={result.at} aria-label={date.format(result.at)}>
      <div className="panel-heading"><h2>{date.format(result.at)}</h2><small>{delivery(result.delivery)}</small></div>
      <div className="card-grid">
        {result.entries.map((entry, index) => <article key={index} className="memory-card">
          <h3>{entry.title}</h3>
          <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{entry.summary}</p>
          {entry.detail && <details>
            <summary>{t.expand}</summary>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{entry.detail}</p>
          </details>}
        </article>)}
      </div>
    </section>)}
  </section>;
}
