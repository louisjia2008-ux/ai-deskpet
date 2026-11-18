import { useEffect, useId, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ResolvedLocale } from '../../shared';
import { defaultWeChatFriendsMomentsSettings, wechatFriendsMomentsSettingsSchema } from '../../shared/wechat-digests';
import type { WeChatDigestsAPI, WeChatFriendsMomentsSettings, WeChatFriendsMomentsState } from '../../shared/wechat-digests';

const copy = {
  en: {
    title: 'Friends’ Moments digest', enabled: 'Send a digest of friends’ Moments',
    scope: 'DeskPet uses its own WeChat account. It reads only the Moments already cached for friends of that account. Freshness depends on WeChat’s own sync. The digest goes to the owner’s private chat.',
    cloud: 'Allow friends’ Moments content to be sent to cloud models',
    cloudInfo: 'When the digest is enabled, the selected cloud model may receive posts’ text. DeskPet adds author labels and image counts locally. Turn this off to use a local model when available.',
    cadence: 'How often', daily: 'Daily', weekly: 'Weekly', day: 'Day of the week', time: 'Delivery time (local time)',
    weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    provider: 'Cloud service for the digest', privateRoute: 'Use the owner’s private chat cloud service', missingProvider: 'Saved service unavailable',
    loading: 'Reading friends’ Moments digest settings…', refresh: 'Refresh Moments settings',
    unavailable: 'The account’s Moments cache is unavailable. You can still turn off the digest or revoke cloud permission.',
    loadError: 'Could not load friends’ Moments digest settings.', saveError: 'Could not save friends’ Moments digest settings.',
    invalid: 'Choose a valid delivery time and schedule.', save: 'Save friends’ Moments digest settings',
    saving: 'Saving…', saved: 'Friends’ Moments digest settings saved.',
  },
  'zh-CN': {
    title: '好友朋友圈摘要', enabled: '发送好友朋友圈摘要',
    scope: '桌宠使用独立的微信号，只读取该账号自己好友已经同步到本机缓存的朋友圈。内容更新取决于微信自身的同步，摘要只发给主人私聊。',
    cloud: '允许将好友朋友圈内容发给云端模型',
    cloudInfo: '开启摘要后，所选云端模型可收到动态文字。桌宠在本机加上作者显示名和图片数量。关闭云端权限后，在本机模型可用的情况下使用本机模型。',
    cadence: '发送频率', daily: '每天', weekly: '每周', day: '星期', time: '发送时间（本机时间）',
    weekdays: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
    provider: '摘要使用的云端服务', privateRoute: '沿用主人私聊的云端服务', missingProvider: '已保存的服务不可用',
    loading: '正在读取好友朋友圈摘要设置…', refresh: '刷新朋友圈摘要设置',
    unavailable: '暂时无法读取该账号的朋友圈缓存，仍可关闭摘要或撤回云端权限。',
    loadError: '未能读取好友朋友圈摘要设置。', saveError: '未能保存好友朋友圈摘要设置。',
    invalid: '请选择有效的时间和频率。', save: '保存好友朋友圈摘要设置',
    saving: '正在保存…', saved: '好友朋友圈摘要设置已保存。',
  },
};

const routeKey = (route: WeChatFriendsMomentsSettings['provider']): string =>
  route === null ? '' : `${route.providerId}\n${route.model}`;
const routeOf = (provider: WeChatFriendsMomentsState['providers'][number]) =>
  ({ providerId: provider.id, model: provider.model });

export function WeChatFriendsMomentsSettingsPanel({ api, locale, disabled = false }: {
  api: Pick<WeChatDigestsAPI, 'getFriendsMomentsSettings' | 'setFriendsMomentsSettings'>;
  locale: ResolvedLocale;
  disabled?: boolean;
}): JSX.Element {
  const t = copy[locale];
  const id = useId();
  const [state, setState] = useState<WeChatFriendsMomentsState | null>(null);
  const [draft, setDraft] = useState(defaultWeChatFriendsMomentsSettings);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<'loadError' | 'saveError' | 'invalid' | 'saved' | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotice(null);
    void api.getFriendsMomentsSettings().then(value => {
      if (!active) return;
      setState(value);
      setDraft(value.settings);
    }).catch(() => {
      if (!active) return;
      setState(null);
      setNotice('loadError');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [api, revision]);

  const locked = disabled || loading || saving || state === null;
  const unchanged = JSON.stringify(draft) === JSON.stringify(state?.settings);
  const update = (patch: Partial<WeChatFriendsMomentsSettings>): void => {
    setNotice(null);
    setDraft(previous => ({ ...previous, ...patch }));
  };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (locked || unchanged) return;
    const parsed = wechatFriendsMomentsSettingsSchema.safeParse(draft);
    if (!parsed.success) { setNotice('invalid'); return; }
    setSaving(true);
    setNotice(null);
    try {
      await api.setFriendsMomentsSettings(parsed.data);
      setState(previous => previous && { ...previous, settings: parsed.data });
      setDraft(parsed.data);
      setNotice('saved');
    } catch {
      setNotice('saveError');
    } finally {
      setSaving(false);
    }
  };

  const available = state?.available === true;
  const providers = state?.providers ?? [];
  const provider = routeKey(draft.provider);
  return <section className="wechat-policy" aria-labelledby={id}>
    <h3 id={id}>{t.title}</h3>
    <p>{t.scope}</p>
    {loading && <p role="status">{t.loading}</p>}
    {!loading && state?.available === false && <p className="muted">{t.unavailable}</p>}
    {notice && <p role={notice === 'saved' ? 'status' : 'alert'} className={notice === 'saved' ? undefined : 'error-banner'}>{t[notice]}</p>}
    <form className="stack-form wechat-cloud-route" onSubmit={event => void submit(event)}>
      {state && <fieldset className="stack-form wechat-cloud-route" disabled={locked}>
        <label className="wechat-option">
          <input type="checkbox" checked={draft.enabled} disabled={!available && !draft.enabled}
            onChange={event => update({ enabled: event.target.checked })} /><span>{t.enabled}</span>
        </label>
        <label>{t.cadence}<select value={draft.cadence} onChange={event => update({ cadence: event.target.value === 'weekly' ? 'weekly' : 'daily' })}>
          <option value="daily">{t.daily}</option>
          <option value="weekly">{t.weekly}</option>
        </select></label>
        {draft.cadence === 'weekly' && <label>{t.day}<select value={draft.weekday}
          onChange={event => update({ weekday: Number(event.target.value) })}>
          {t.weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}
        </select></label>}
        <label>{t.time}<input type="time" required value={draft.time} onChange={event => update({ time: event.target.value })} /></label>
        <label className="wechat-option">
          <input type="checkbox" checked={draft.cloud} disabled={!available && !draft.cloud} aria-describedby={`${id}-cloud`}
            onChange={event => update({ cloud: event.target.checked })} /><span>{t.cloud}</span>
        </label>
        <small id={`${id}-cloud`} className="muted">{t.cloudInfo}</small>
        {draft.cloud && <label>{t.provider}<select value={provider} disabled={!available} onChange={event => {
          const selected = providers.find(item => routeKey(routeOf(item)) === event.target.value);
          update({ provider: selected ? routeOf(selected) : null });
        }}>
          <option value="">{t.privateRoute}</option>
          {draft.provider && !providers.some(item => routeKey(routeOf(item)) === provider) &&
            <option value={provider}>{t.missingProvider}</option>}
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
