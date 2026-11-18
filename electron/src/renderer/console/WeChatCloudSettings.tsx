import { useEffect, useId, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ResolvedLocale } from '../../shared';
import type { WeChatAssistant, WeChatChannelAPI, WeChatChannelState, WeChatCloudRoute, WeChatCloudSettings, WeChatCloudState, WeChatGroupRule, WeChatGroupRuleLevel, WeChatReplyFriend } from '../../shared/wechat-channel';

const en = {
  title: 'Reply source by conversation',
  loading: 'Reading cloud reply settings…',
  unavailable: 'Cloud replies are unavailable here.',
  noProviders: 'Add and enable a cloud model service in Model Services to choose it here.',
  loadError: 'Could not read cloud reply settings. Refresh to try again.',
  saveError: 'Could not save cloud reply settings. Check the selected service and try again.',
  save: 'Save cloud reply settings',
  saving: 'Saving…',
  saved: 'Cloud reply settings saved.',
  refresh: 'Refresh cloud services',
  local: 'Local model',
  localSource: 'Local',
  cloudSource: 'Cloud',
  savedSource: 'Saved reply source',
  missing: 'Cloud model unavailable',
  private: 'Owner’s private chat',
  data: 'The selected cloud service receives the new message, a short same-chat history, and the persona you have allowed for cloud use. Only the owner’s private chat can include approved memories.',
  friends: 'Friend reply sources',
  friendData: 'The selected service receives this friend’s current message, recent messages from this chat, and the DeskPet character’s name.',
  friendSave: 'Save this friend’s reply source',
  friendSaved: 'Friend reply source saved.',
  lifecycle: 'DeskPet must be open to generate cloud replies.',
  confirm: 'Allow this conversation’s message text and recent history to be sent to the selected cloud service.',
  service: 'Reply service',
  assistantTitle: 'Owner’s private chat assistant',
  assistant: 'Answer with the full DeskPet chat: web search, recurring tasks and memory.',
  assistantDetail: 'Works with a cloud reply service. Recurring tasks created in WeChat may only search and read the web; results are sent back to this chat. Files, commands and settings stay on the desktop. The conversation appears as “WeChat assistant” in Chat.',
  allMemories: 'Use all memories in this chat (memories marked local-only still stay on this Mac).',
  assistantError: 'Could not save the assistant setting.',
  moments: 'Prepare one Moments draft a day (10:00–22:00). You get a preview in this chat; it posts to all contacts only after you reply “发”.',
  richTitle: 'Detailed message content',
  richCloud: 'Allow rich message content to be sent to cloud models.',
  richDetail: 'Quoted excerpts, group forward previews and readable attachment content may accompany a cloud reply request. This only applies to conversations where cloud replies are already allowed.',
  richError: 'Could not save permission for detailed message content.',
  forwardCloud: 'Allow cloud models to answer questions about chats you forward.',
  forwardDetail: 'The owner’s approved reply service receives the relevant text from the forwarded record. Reading the record and turning pages happen locally.',
  forwardError: 'Could not save cloud permission for forwarded chats.',
  rulesTitle: 'Group reply rules',
  rulesIntro: 'Every group: no flooding, no impersonation, nothing about you or your other chats, no actions for members, nothing sexual, sensitive politics avoided, a one-line playful decline when it refuses. A member who addresses it more than three times a minute is not answered.',
  level: 'Strictness',
  relaxed: 'Relaxed: memes and banter between friends',
  standard: 'Standard: memes, no teasing a member',
  strict: 'Strict: friendly only, for groups with minors',
  extra: 'Your own rules for this group (optional)',
  extraHint: 'For example: do not discuss exams; answer in English.',
  ruleLegend: 'reply rules',
  web: 'Let members have it search and read public web pages (at most three lookups a reply; uses your model service).',
  saveRule: 'Save rules',
  ruleSaved: 'Group rules saved.',
  ruleError: 'Could not save the group rules.',
};

const zh: typeof en = {
  title: '各会话的回复来源',
  loading: '正在读取云端回复设置…',
  unavailable: '这里暂时无法使用云端回复。',
  noProviders: '请先在「模型服务」添加并启用云端服务，再回到这里选择。',
  loadError: '未能读取云端回复设置，请刷新后重试。',
  saveError: '未能保存云端回复设置，请检查所选服务后重试。',
  save: '保存云端回复设置',
  saving: '正在保存…',
  saved: '云端回复设置已保存。',
  refresh: '刷新云端服务',
  local: '使用本机模型',
  localSource: '本机',
  cloudSource: '云端',
  savedSource: '已保存的回复来源',
  missing: '云端模型不可用',
  private: '主人私聊',
  data: '启用云端回复后，所选服务会收到本条消息、同一会话的少量近期记录，以及你已允许用于云端的人设。只有主人私聊可带上已授权的记忆。',
  friends: '好友的回复来源',
  friendData: '所选云端服务会收到这位好友的当前消息、同一会话的少量近期记录，以及桌宠的角色名。',
  friendSave: '保存这位好友的回复来源',
  friendSaved: '好友回复来源已保存。',
  lifecycle: '云端回复需要保持 DeskPet 运行。',
  confirm: '允许将这个会话的新消息文字和近期文字记录发送给所选云端服务。',
  service: '回复服务',
  assistantTitle: '主人私聊助手',
  assistant: '用完整的桌宠聊天来回复：联网搜索、定时任务和记忆。',
  assistantDetail: '需要私聊使用云端回复服务。在微信里创建的定时任务只能搜索和读取网页，结果会发回这个私聊；文件、命令和设置仍只能在桌面操作。对话会以「微信私聊助手」出现在聊天列表里。',
  allMemories: '这个私聊可使用全部记忆（标为仅本机的记忆仍不会发出）。',
  assistantError: '未能保存助手设置。',
  moments: '每天准备一条朋友圈草稿（10:00–22:00 之间）。预览会发到这个私聊，你回复「发」后才会发布，所有人可见。',
  richTitle: '详细消息内容',
  richCloud: '允许将详细消息内容发送给云端模型。',
  richDetail: '引用摘录、群聊里的合并转发摘录和可读取的附件内容可能随回复请求一同发送。只对已允许云端回复的会话生效。',
  richError: '未能保存详细消息的云端权限。',
  forwardCloud: '允许云端模型回答转发记录里的问题。',
  forwardDetail: '问答会把相关文字发给主人已批准的服务。读取和翻页在本机完成。',
  forwardError: '未能保存转发聊天记录的云端权限。',
  rulesTitle: '群聊回复规则',
  rulesIntro: '所有群都遵守：不刷屏、不冒充、不透露你和其他会话的事、不替群成员执行操作、不涉及性内容、回避敏感时政；需要拒绝时用一句话俏皮地婉拒。同一个人一分钟内 @ 它超过 3 次，超出的不回。',
  level: '严格程度',
  relaxed: '宽松：可以玩梗、朋友间互损',
  standard: '标准：可以玩梗，不取笑具体成员',
  strict: '严格：只做友好回应，适合有未成年人的群',
  extra: '你为这个群补充的规则（可选）',
  extraHint: '例如：不聊考试成绩；用英文回答。',
  ruleLegend: '的回复规则',
  web: '允许群里让它联网搜索、读网页（每次回复最多查三次，会用你的模型额度）',
  saveRule: '保存规则',
  ruleSaved: '群聊规则已保存。',
  ruleError: '未能保存群聊规则。',
};

type Provider = WeChatCloudState['providers'][number];
const routeKey = (route: WeChatCloudRoute | null): string => route ? `${route.providerId}\n${route.model}` : '';
const routeOf = (provider: Provider): WeChatCloudRoute => ({ providerId: provider.id, model: provider.model });

function CloudRouteControl({ copy, title, saved, value, providers, localModel, disabled, approved, change, approve, data = copy.data }: {
  copy: typeof en; title: string; saved: WeChatCloudRoute | null; value: WeChatCloudRoute | null; providers: Provider[];
  localModel: string;
  disabled: boolean; approved: boolean; change(value: WeChatCloudRoute | null): void; approve(approved: boolean): void; data?: string;
}): JSX.Element {
  const info = useId();
  const key = routeKey(value);
  const listed = providers.some(provider => routeKey(routeOf(provider)) === key);
  const savedProvider = providers.find(provider => routeKey(routeOf(provider)) === routeKey(saved));
  const source = saved === null ? `${copy.localSource} · ${localModel}`
    : savedProvider ? `${copy.cloudSource} · ${savedProvider.name} · ${saved.model}`
      : `${copy.cloudSource} · ${saved.model} · ${copy.missing}`;
  const needsApproval = value !== null && key !== routeKey(saved);
  return <fieldset className="wechat-cloud-route">
    <legend>{title}</legend>
    <small className="muted">{copy.savedSource} <strong>{source}</strong></small>
    <label>{copy.service}<select value={key} disabled={disabled} aria-describedby={value ? info : undefined} onChange={event => {
      const selected = providers.find(provider => routeKey(routeOf(provider)) === event.target.value);
      change(selected ? routeOf(selected) : null);
    }}>
      <option value="">{copy.local}</option>
      {value && !listed && <option value={key}>{value.model} · {copy.missing}</option>}
      {providers.map(provider => <option key={provider.id} value={routeKey(routeOf(provider))}>{provider.name} · {provider.model}</option>)}
    </select></label>
    {value && <small id={info}>{data}</small>}
    {needsApproval && <label className="wechat-option">
      <input type="checkbox" checked={approved} disabled={disabled || !listed} onChange={event => approve(event.target.checked)} />
      <span>{copy.confirm}</span>
    </label>}
  </fieldset>;
}

function AssistantControl({ copy, value, disabled, error, update }: {
  copy: typeof en; value: WeChatAssistant; disabled: boolean; error: boolean; update(value: WeChatAssistant): void;
}): JSX.Element {
  return <fieldset className="wechat-cloud-route">
    <legend>{copy.assistantTitle}</legend>
    <label className="wechat-option">
      <input type="checkbox" checked={value.enabled} disabled={disabled} onChange={event => update({ ...value, enabled: event.target.checked })} />
      <span>{copy.assistant}</span>
    </label>
    <small className="muted">{copy.assistantDetail}</small>
    <label className="wechat-option">
      <input type="checkbox" checked={value.memories === 'all'} disabled={disabled || !value.enabled}
        onChange={event => update({ ...value, memories: event.target.checked ? 'all' : 'selected' })} />
      <span>{copy.allMemories}</span>
    </label>
    <label className="wechat-option">
      <input type="checkbox" checked={value.moments} disabled={disabled || !value.enabled}
        onChange={event => update({ ...value, moments: event.target.checked })} />
      <span>{copy.moments}</span>
    </label>
    {error && <p role="alert" className="error-banner">{copy.assistantError}</p>}
  </fieldset>;
}

function GroupRuleControl({ copy, title, value, disabled, save }: {
  copy: typeof en; title: string; value: WeChatGroupRule; disabled: boolean; save(value: WeChatGroupRule): Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [status, setStatus] = useState<'ruleSaved' | 'ruleError' | null>(null);
  useEffect(() => { setDraft(value); }, [value]);
  const changed = draft.level !== value.level || draft.extra.trim() !== value.extra || draft.web !== value.web;
  return <fieldset className="wechat-cloud-route">
    <legend>{title}{copy === zh ? '' : ' '}{copy.ruleLegend}</legend>
    <label>{copy.level}<select value={draft.level} disabled={disabled}
      onChange={event => { setStatus(null); setDraft({ ...draft, level: event.target.value as WeChatGroupRuleLevel }); }}>
      {(['relaxed', 'standard', 'strict'] as const).map(level => <option key={level} value={level}>{copy[level]}</option>)}
    </select></label>
    <label className="wechat-option">
      <input type="checkbox" checked={draft.web} disabled={disabled}
        onChange={event => { setStatus(null); setDraft({ ...draft, web: event.target.checked }); }} />
      <span>{copy.web}</span>
    </label>
    <label>{copy.extra}<textarea value={draft.extra} maxLength={500} disabled={disabled} placeholder={copy.extraHint}
      onChange={event => { setStatus(null); setDraft({ ...draft, extra: event.target.value }); }} /></label>
    <div className="button-row">
      <button type="button" disabled={disabled || !changed}
        onClick={() => void save({ level: draft.level, extra: draft.extra.trim(), web: draft.web }).then(() => setStatus('ruleSaved'), () => setStatus('ruleError'))}>{copy.saveRule}</button>
      {status && <span role={status === 'ruleError' ? 'alert' : 'status'}>{copy[status]}</span>}
    </div>
  </fieldset>;
}

export function WeChatCloudSettingsPanel({ api, groups, friends = [], localModel, locale, disabled }: {
  api: Pick<WeChatChannelAPI, 'getCloud' | 'configureCloud' | 'configureFriendCloud' | 'configureAssistant' | 'configureGroupRule'>;
  groups: WeChatChannelState['groups']; friends?: readonly WeChatReplyFriend[];
  localModel: string; locale: ResolvedLocale; disabled: boolean;
}): JSX.Element {
  const copy = locale === 'zh-CN' ? zh : en;
  const richDetail = useId();
  const forwardDetail = useId();
  const [state, setState] = useState<WeChatCloudState | null>(null);
  const [draft, setDraft] = useState<Record<string, WeChatCloudRoute | null>>({});
  const [approvals, setApprovals] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingFriend, setSavingFriend] = useState<string | null>(null);
  const [friendNotice, setFriendNotice] = useState<{ id: string; status: 'friendSaved' | 'saveError' } | null>(null);
  const [savingAssistant, setSavingAssistant] = useState(false);
  const [assistantError, setAssistantError] = useState<'assistantError' | 'richError' | 'forwardError' | null>(null);
  const [error, setError] = useState<'loadError' | 'saveError' | null>(null);
  const [saved, setSaved] = useState(false);
  const friendRevision = friends.map(friend => friend.id).join(',');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void api.getCloud().then(value => {
      if (active) setState(value);
    }).catch(() => {
      if (active) setError('loadError');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [api, revision, friendRevision]);

  const scopes = [{ id: 'private', title: copy.private }, ...groups];
  const savedRoute = (id: string): WeChatCloudRoute | null => (id === 'private' ? state?.settings.private
    : id.startsWith('friend:') ? state?.settings.friends?.[id.slice('friend:'.length)] : state?.settings.groups[id]) ?? null;
  const currentRoute = (id: string): WeChatCloudRoute | null => Object.hasOwn(draft, id) ? draft[id]! : savedRoute(id);
  const changed = scopes.filter(({ id }) => routeKey(currentRoute(id)) !== routeKey(savedRoute(id)));
  const locked = disabled || saving || savingAssistant || savingFriend !== null || loading || state?.available !== true || error === 'loadError';
  const approvedRoute = (id: string): boolean => {
    const route = currentRoute(id);
    return route === null || (approvals[id] === routeKey(route) && state?.providers.some(provider => routeKey(routeOf(provider)) === routeKey(route)) === true);
  };
  const canSave = !locked && state !== null && changed.length > 0 && changed.every(({ id }) => approvedRoute(id));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave || state === null) return;
    const settings: WeChatCloudSettings = { private: currentRoute('private'), groups: { ...state.settings.groups } };
    for (const { id } of groups) {
      const route = currentRoute(id);
      if (route) settings.groups[id] = route;
      else delete settings.groups[id];
    }
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      setState(await api.configureCloud(settings));
      setDraft(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id.startsWith('friend:'))));
      setApprovals(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id.startsWith('friend:'))));
      setSaved(true);
    } catch {
      setError('saveError');
    } finally {
      setSaving(false);
    }
  };
  const submitFriend = async (friendId: string) => {
    const scope = `friend:${friendId}`;
    const route = currentRoute(scope);
    if (locked || !state?.settings.friends || routeKey(route) === routeKey(savedRoute(scope)) || !approvedRoute(scope)) return;
    setSavingFriend(friendId);
    setFriendNotice(null);
    try {
      setState(await api.configureFriendCloud({ friendId, route }));
      setDraft(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== scope)));
      setApprovals(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== scope)));
      setFriendNotice({ id: friendId, status: 'friendSaved' });
    } catch {
      setFriendNotice({ id: friendId, status: 'saveError' });
    } finally {
      setSavingFriend(null);
    }
  };
  const updateAssistant = async (value: WeChatAssistant, errorCopy: 'assistantError' | 'richError' | 'forwardError'): Promise<void> => {
    setAssistantError(null);
    setSavingAssistant(true);
    try {
      const { forwardCloud, ...assistant } = value;
      setState(await api.configureAssistant(errorCopy === 'forwardError' ? { ...assistant, forwardCloud } : assistant));
    } catch {
      setAssistantError(errorCopy);
    } finally {
      setSavingAssistant(false);
    }
  };

  return <form className="stack-form wechat-policy" onSubmit={event => void submit(event)}>
    <h3>{copy.title}</h3>
    {error && <p role="alert" className="error-banner">{copy[error]}</p>}
    {saved && <p role="status">{copy.saved}</p>}
    {loading && state === null && <p role="status">{copy.loading}</p>}
    {state && !state.available && <p className="muted">{copy.unavailable}</p>}
    {state?.available && <>
      <p className="muted">{copy.data} {copy.lifecycle}</p>
      {state.providers.length === 0 && <p className="muted">{copy.noProviders}</p>}
      {state.settings.private && <AssistantControl copy={copy} value={state.assistant} disabled={locked}
        error={assistantError === 'assistantError'} update={value => void updateAssistant(value, 'assistantError')} />}
      <fieldset className="wechat-cloud-route">
        <legend>{copy.richTitle}</legend>
        <label className="wechat-option">
          <input type="checkbox" checked={state.assistant.richCloud === true} disabled={locked} aria-describedby={richDetail}
            onChange={event => void updateAssistant({ ...state.assistant, richCloud: event.target.checked }, 'richError')} />
          <span>{copy.richCloud}</span>
        </label>
        <small id={richDetail} className="muted">{copy.richDetail}</small>
        {assistantError === 'richError' && <p role="alert" className="error-banner">{copy.richError}</p>}
        <label className="wechat-option">
          <input type="checkbox" checked={state.assistant.forwardCloud === true} disabled={locked} aria-describedby={forwardDetail}
            onChange={event => void updateAssistant({ ...state.assistant, forwardCloud: event.target.checked }, 'forwardError')} />
          <span>{copy.forwardCloud}</span>
        </label>
        <small id={forwardDetail} className="muted">{copy.forwardDetail}</small>
        {assistantError === 'forwardError' && <p role="alert" className="error-banner">{copy.forwardError}</p>}
      </fieldset>
      {groups.length > 0 && <section aria-label={copy.rulesTitle}>
        <h4>{copy.rulesTitle}</h4>
        <p className="muted">{copy.rulesIntro}</p>
        {groups.map(group => <GroupRuleControl key={group.id} copy={copy} title={group.title}
          value={state.groupRules[group.id] ?? { level: 'standard', extra: '', web: false }} disabled={locked}
          save={async rule => { setState(await api.configureGroupRule({ groupId: group.id, rule })); }} />)}
      </section>}
      {scopes.map(({ id, title }) => <CloudRouteControl key={id} copy={copy} title={title} saved={savedRoute(id)} value={currentRoute(id)}
        providers={state.providers} localModel={localModel} disabled={locked} approved={approvals[id] === routeKey(currentRoute(id))}
        change={route => {
          setSaved(false);
          setDraft(previous => ({ ...previous, [id]: route }));
          setApprovals(previous => ({ ...previous, [id]: '' }));
        }} approve={approved => setApprovals(previous => ({ ...previous, [id]: approved ? routeKey(currentRoute(id)) : '' }))} />)}
      {friends.length > 0 && <section aria-label={copy.friends} className="wechat-groups">
        <h4>{copy.friends}</h4>
        {friends.map(friend => {
          const id = `friend:${friend.id}`;
          const saved = savedRoute(id);
          const value = currentRoute(id);
          const unavailable = state.settings.friends === undefined;
          return <article key={friend.id} className="wechat-group" aria-label={friend.title}>
            <CloudRouteControl copy={copy} title={friend.title} saved={saved} value={value} providers={state.providers} localModel={localModel}
              data={copy.friendData} disabled={locked || unavailable} approved={approvals[id] === routeKey(value)} change={route => {
                setFriendNotice(null);
                setDraft(previous => ({ ...previous, [id]: route }));
                setApprovals(previous => ({ ...previous, [id]: '' }));
              }} approve={approved => setApprovals(previous => ({ ...previous, [id]: approved ? routeKey(value) : '' }))} />
            <div className="button-row">
              <button type="button" disabled={locked || unavailable || routeKey(value) === routeKey(saved) || !approvedRoute(id)}
                onClick={() => void submitFriend(friend.id)}>{savingFriend === friend.id ? copy.saving : copy.friendSave}</button>
              {friendNotice?.id === friend.id && <span role={friendNotice.status === 'saveError' ? 'alert' : 'status'}>{copy[friendNotice.status]}</span>}
            </div>
            {unavailable && <p className="muted">{copy.unavailable}</p>}
          </article>;
        })}
      </section>}
    </>}
    <div className="button-row">
      {state?.available && <button type="submit" disabled={!canSave}>{saving ? copy.saving : copy.save}</button>}
      <button type="button" className="secondary" disabled={saving || savingAssistant || savingFriend !== null || loading} onClick={() => setRevision(value => value + 1)}>{copy.refresh}</button>
    </div>
  </form>;
}
