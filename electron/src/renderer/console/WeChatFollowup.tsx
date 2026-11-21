import { WeChatDigestModel } from './WeChatDigestModel';
import { useEffect, useId, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ResolvedLocale } from '../../shared';
import { defaultWeChatFollowupSettings, wechatFollowupSettingsSchema } from '../../shared/wechat-followup';
import type { WeChatFollowupAction, WeChatFollowupAPI, WeChatFollowupItem, WeChatFollowupSettings, WeChatFollowupSettingsState } from '../../shared/wechat-followup';

const copy = {
  en: {
    title: 'Waiting for you', time: 'Daily delivery time (local time)', wait: 'Minutes to wait for a reply',
    description: 'Follow mentions that tag your WeChat account in the selected groups. If DeskPet has not seen you answer, she sends the summary only to your private chat.',
    groupLabel: 'Groups to follow', noGroups: 'There are no groups to select.', reachedLimit: 'You can select up to 12 groups.',
    cloud: 'Allow cloud processing', cloudHelp: 'Cloud processing sends chat excerpts from that group to the selected service. Each new group starts with this off.',
    provider: 'Cloud service for follow-ups', followPrivate: 'Use the service approved for the owner’s private chat', missingProvider: 'Saved service unavailable',
    removeMissing: 'Clear unavailable selections', refresh: 'Refresh', saving: 'Saving…', save: 'Save follow-up settings',
    saved: 'Follow-up settings saved.', unavailable: 'Could not read the group list from WeChat. Refresh to try again.',
    loadError: 'Could not read follow-up settings.', saveError: 'Could not save follow-up settings.',
    invalid: 'Enter a valid time and a wait of 5 to 1440 minutes.', loading: 'Loading follow-up settings…',
    listLoading: 'Loading pending follow-ups…', listError: 'Could not read pending follow-ups.', empty: 'No group mentions waiting for you.',
    deadline: 'Deadline', until: 'Snoozed until', details: 'Show context', done: 'Mark handled', snooze: 'Snooze for an hour',
    actionError: 'Could not update this follow-up. Refresh to try again.', handled: 'Follow-up marked handled.', snoozed: 'Follow-up snoozed for an hour.',
  },
  'zh-CN': {
    title: '等你处理', time: '每天发送时间（本机时间）', wait: '等待回复（分钟）',
    description: '在所选群里，有人 @ 你的微信账号时，她会留意你有没有回应。还没看到回应的事项只汇报到主人私聊。',
    groupLabel: '选择要跟进的群', noGroups: '暂时没有可选择的群。', reachedLimit: '最多可选择 12 个群。',
    cloud: '允许发送给云端模型', cloudHelp: '开启后会把该群的相关消息片段发给选定模型。新选中的群默认关闭。',
    provider: '跟进使用的云端服务', followPrivate: '沿用主人私聊已授权的云端服务', missingProvider: '已保存的服务不可用',
    removeMissing: '移除已不可用的群', refresh: '刷新', saving: '正在保存…', save: '保存跟进设置',
    saved: '跟进设置已保存。', unavailable: '暂时读不到微信里的群列表，请刷新后重试。',
    loadError: '未能读取跟进设置。', saveError: '未能保存跟进设置。', invalid: '请输入有效时间，等待时长为 5 至 1440 分钟。',
    loading: '正在读取跟进设置…', listLoading: '正在读取待跟进事项…', listError: '未能读取待跟进事项。', empty: '暂时没有等待你处理的群消息。',
    deadline: '截止时间', until: '延后提醒至', details: '展开上下文', done: '标为已处理', snooze: '延后 1 小时',
    actionError: '未能更新这条待跟进事项，请刷新后重试。', handled: '已标为处理。', snoozed: '已延后一个小时。',
  },
};

const groupLimit = 12;

export function WeChatFollowupSettingsPanel({ api, locale, disabled = false }: {
  api: Pick<WeChatFollowupAPI, 'getSettings' | 'configure'>;
  locale: ResolvedLocale;
  disabled?: boolean;
}): JSX.Element {
  const t = copy[locale];
  const title = useId();
  const [state, setState] = useState<WeChatFollowupSettingsState | null>(null);
  const [draft, setDraft] = useState<WeChatFollowupSettings>(defaultWeChatFollowupSettings);
  const [wait, setWait] = useState(String(draft.waitMinutes));
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'invalid' | 'loadError' | 'saveError' | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotice(null);
    void api.getSettings().then(value => {
      if (!active) return;
      setState(value);
      setDraft(value.settings);
      setWait(String(value.settings.waitMinutes));
    }).catch(() => {
      if (!active) return;
      setState(null);
      setNotice('loadError');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [api, revision]);

  const update = (patch: Partial<WeChatFollowupSettings>): void => {
    setNotice(null);
    setDraft(previous => ({ ...previous, ...patch }));
  };
  const unchanged = state !== null && JSON.stringify({ ...draft, waitMinutes: Number(wait) }) === JSON.stringify(state.settings);
  const locked = disabled || loading || saving || state?.available !== true;
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (locked || unchanged) return;
    const parsed = wechatFollowupSettingsSchema.safeParse({ ...draft, waitMinutes: Number(wait) });
    if (!parsed.success) { setNotice('invalid'); return; }
    setSaving(true);
    setNotice(null);
    try {
      await api.configure(parsed.data);
      setState(previous => previous && { ...previous, settings: parsed.data });
      setDraft(parsed.data);
      setWait(String(parsed.data.waitMinutes));
      setNotice('saved');
    } catch {
      setNotice('saveError');
    } finally {
      setSaving(false);
    }
  };

  const groups = state?.groups ?? [];
  const providers = state?.providers ?? [];
  const hasMissing = draft.groups.some(group => !groups.some(option => option.id === group.id));
  return <section className="wechat-policy" aria-labelledby={title}>
    <h3 id={title}>{t.title}</h3>
    <p>{t.description}</p>
    {loading && <p role="status">{t.loading}</p>}
    {!loading && state?.available === false && <p className="muted">{t.unavailable}</p>}
    {notice && <p role={notice === 'saved' ? 'status' : 'alert'} className={notice === 'saved' ? undefined : 'error-banner'}>{t[notice]}</p>}
    <form className="stack-form wechat-cloud-route" onSubmit={event => void submit(event)}>
      {state?.available && <fieldset disabled={locked} className="stack-form wechat-cloud-route">
        <label>{t.time}<input type="time" value={draft.time} required onChange={event => update({ time: event.target.value })} /></label>
        <label>{t.wait}<input type="number" min={5} max={1440} step={1} required value={wait}
          onChange={event => { setNotice(null); setWait(event.target.value); }} /></label>
        <fieldset className="wechat-cloud-route">
          <legend>{t.groupLabel}</legend>
          <small>{t.cloudHelp}</small>
          {groups.length === 0 && <p>{t.noGroups}</p>}
          {groups.map(group => {
            const selected = draft.groups.find(item => item.id === group.id);
            return <div key={group.id} className="wechat-cloud-route">
              <label className="wechat-option">
                <input type="checkbox" checked={selected !== undefined} disabled={!selected && draft.groups.length >= groupLimit}
                  onChange={event => update({ groups: event.target.checked
                    ? [...draft.groups, { id: group.id, cloud: false }]
                    : draft.groups.filter(item => item.id !== group.id) })} />
                <span>{group.title}</span>
              </label>
              {selected && <label className="wechat-option">
                <input type="checkbox" checked={selected.cloud} onChange={event =>
                  update({ groups: draft.groups.map(item => item.id === group.id ? { ...item, cloud: event.target.checked } : item) })} />
                <span>{t.cloud} · {group.title}</span>
              </label>}
            </div>;
          })}
          {draft.groups.length >= groupLimit && <small className="muted">{t.reachedLimit}</small>}
          {hasMissing && <button type="button" className="secondary" onClick={() =>
            update({ groups: draft.groups.filter(group => groups.some(option => option.id === group.id)) })}>{t.removeMissing}</button>}
        </fieldset>
        {draft.groups.some(group => group.cloud) && <WeChatDigestModel locale={locale} label={t.provider} inherited={t.followPrivate} unavailable={t.missingProvider}
          providers={providers} value={draft.provider} change={provider => update({ provider })} />}
      </fieldset>}
      <div className="button-row">
        {state?.available && <button type="submit" disabled={locked || unchanged}>{saving ? t.saving : t.save}</button>}
        <button type="button" className="secondary" disabled={loading || saving || disabled}
          onClick={() => setRevision(value => value + 1)}>{t.refresh}</button>
      </div>
    </form>
  </section>;
}

export function WeChatFollowupList({ api, locale }: {
  api: Pick<WeChatFollowupAPI, 'list' | 'act'>;
  locale: ResolvedLocale;
}): JSX.Element {
  const t = copy[locale];
  const [items, setItems] = useState<WeChatFollowupItem[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<'listError' | 'actionError' | null>(null);
  const [notice, setNotice] = useState<'handled' | 'snoozed' | null>(null);
  const [working, setWorking] = useState(false);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  useEffect(() => {
    let active = true;
    setItems(null);
    setError(null);
    void api.list().then(value => { if (active) setItems(value); }).catch(() => { if (active) setError('listError'); });
    return () => { active = false; };
  }, [api, revision]);

  const act = async (action: WeChatFollowupAction): Promise<void> => {
    if (working || !items) return;
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      await api.act(action);
      setNotice(action.action === 'done' ? 'handled' : 'snoozed');
      setRevision(value => value + 1);
    } catch {
      setError('actionError');
    } finally {
      setWorking(false);
    }
  };

  return <section role="tabpanel" aria-label={t.title}>
    <div className="button-row"><button type="button" className="secondary" disabled={working || (items === null && !error)}
      onClick={() => { setNotice(null); setRevision(value => value + 1); }}>{t.refresh}</button></div>
    {error && <p className="error-banner" role="alert">{t[error]}</p>}
    {notice && <p role="status">{t[notice]}</p>}
    {!items && !error && <p role="status">{t.listLoading}</p>}
    {items?.length === 0 && <p>{t.empty}</p>}
    <div className="card-grid">{items?.map(item => <article key={item.id} className="memory-card">
      <h3>{item.groupTitle}</h3>
      <time dateTime={new Date(item.at).toISOString()}>{date.format(item.at)}</time>
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.summary}</p>
      {item.deadline && <p><strong>{t.deadline}</strong> {item.deadline}</p>}
      {item.snoozedUntil !== null && <p><strong>{t.until}</strong> <time dateTime={new Date(item.snoozedUntil).toISOString()}>{date.format(item.snoozedUntil)}</time></p>}
      {item.detail && <details><summary>{t.details}</summary><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.detail}</p></details>}
      <div className="button-row">
        <button type="button" className="secondary" disabled={working} onClick={() => void act({ id: item.id, action: 'done' })}>{t.done}</button>
        <button type="button" className="secondary" disabled={working}
          onClick={() => void act({ id: item.id, action: 'snooze', minutes: 60 })}>{t.snooze}</button>
      </div>
    </article>)}</div>
  </section>;
}
