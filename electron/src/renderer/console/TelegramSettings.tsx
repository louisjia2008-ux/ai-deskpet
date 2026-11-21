import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ProviderConfig, ResolvedLocale } from '../../shared';
import type { TelegramChannelStatus, TelegramConfigureInput, TelegramPendingResult } from '../../shared/telegram-channel';
import './qq-settings.css';

const en = {
  title: 'Telegram remote control', setup: 'Connect a dedicated bot for DeskPet. Create a new bot when you are ready to connect Telegram. DeskPet accepts private messages only from the account you approve here.',
  boundary: 'Web and task tools are available on your phone. Each workspace operation needs separate approval on the phone. Commands, permission changes and credentials stay on the desktop.',
  loading: 'Loading Telegram settings…', error: 'The change could not be completed. Refresh the status and try again.', refresh: 'Refresh status',
  provider: 'Telegram provider', choose: 'Select a provider', model: 'Telegram model', followDefault: 'Follow provider default', token: 'Dedicated bot token', tokenHelp: 'Leave blank to keep the existing token.',
  stored: 'A bot token is saved.', missing: 'No bot token is saved.', save: 'Save Telegram settings', clear: 'Remove bot token', enable: 'Enable Telegram', disable: 'Disable Telegram',
  memory: 'Allow approved memories in Telegram', memoryHelp: 'Only memories individually enabled for Telegram are eligible. Their existing privacy rules still apply.',
  status: 'Connection', disabled: 'Disabled', connecting: 'Connecting', online: 'Online', offline: 'Offline', lastError: 'Last connection problem',
  pairing: 'Pair your phone', start: 'Generate pairing code', codeHelp: 'Send this command to your DeskPet bot in a private chat. Return here to check the account and approve it.', expires: 'Expires',
  candidate: 'Account requesting access', verify: 'Verify the account ID on your own phone before granting access.', confirm: 'Approve this Telegram account',
  owner: 'Paired account', none: 'No account paired', unbind: 'Unpair Telegram account',
  diagnostics: 'Connection check', diagnosticsHelp: 'Recent events received from Telegram, including fields rejected during validation.', noEvents: 'No events received yet.',
  accepted: 'Accepted', rejected: 'Rejected', field: 'Field', inbox: 'Queued messages', outbox: 'Pending deliveries', uncertain: 'Unconfirmed deliveries',
  retry: 'Retry failed deliveries', uncertainHelp: 'Check your phone for unconfirmed deliveries. DeskPet does not resend them automatically.',
};
const zh: typeof en = {
  title: 'Telegram 手机遥控', setup: '准备连接时，请为桌宠新建专用机器人。只有在这里确认过的本人账号才能通过私聊使用桌宠。',
  boundary: '手机可使用联网和任务工具。工作区的每次操作都需要在手机上单独批准。命令、权限修改和凭据仅在桌面操作。',
  loading: '正在读取 Telegram 设置…', error: '操作未完成，请刷新状态后重试。', refresh: '刷新状态',
  provider: 'Telegram 使用的模型服务', choose: '选择模型服务', model: 'Telegram 使用的模型', followDefault: '跟随服务默认模型', token: '专用机器人 Token', tokenHelp: '留空可保留原有凭据。',
  stored: '已保存机器人凭据。', missing: '尚未保存机器人凭据。', save: '保存 Telegram 设置', clear: '移除机器人凭据', enable: '启用 Telegram', disable: '停用 Telegram',
  memory: '允许 Telegram 使用已授权的记忆', memoryHelp: '只有在记忆页中逐条允许 Telegram 使用的记忆才有资格发送，且仍遵守该记忆的隐私设置。',
  status: '连接状态', disabled: '已停用', connecting: '正在连接', online: '已连接', offline: '连接中断', lastError: '最近的连接问题',
  pairing: '配对手机', start: '生成配对码', codeHelp: '把这条命令私发给桌宠专用机器人，然后回到这里核对并批准账号。', expires: '过期时间',
  candidate: '申请配对的账号', verify: '确认手机上的本人账号 ID 与这里一致后再批准。', confirm: '批准这个 Telegram 账号',
  owner: '已配对账号', none: '尚未配对', unbind: '解除 Telegram 配对',
  diagnostics: '连接检查', diagnosticsHelp: '最近从 Telegram 收到的事件，以及校验未通过的字段。', noEvents: '尚未收到事件。',
  accepted: '已接受', rejected: '已拒绝', field: '字段', inbox: '排队中的消息', outbox: '等待投递', uncertain: '投递结果未知',
  retry: '重试已知失败的投递', uncertainHelp: '请在手机上核对结果未知的投递，桌宠不会自动重发。',
};

type PairingCode = { code: string; expiresAt: string };

const ConnectionForm = ({ state, providers, busy, copy, save }: {
  state: TelegramChannelStatus; providers: ProviderConfig[]; busy: boolean; copy: typeof en;
  save: (input: TelegramConfigureInput) => Promise<boolean>;
}): JSX.Element => {
  const [providerId, setProviderId] = useState(state.providerId ?? '');
  const [model, setModel] = useState(state.model ?? '');
  const [memoryAllowed, setMemoryAllowed] = useState(state.memoryAllowed);
  const token = useRef<HTMLInputElement>(null);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const value = token.current?.value.trim();
    if (token.current) token.current.value = '';
    await save({ providerId: providerId || null, model: model.trim() || null, memoryAllowed, ...(value ? { token: value } : {}) });
  };
  return <form onSubmit={event => void submit(event)}>
    <label>{copy.token}<input type="password" ref={token} autoComplete="new-password" disabled={busy} /></label>
    <small>{state.secretConfigured ? copy.stored : copy.missing} {copy.tokenHelp}</small>
    <label>{copy.provider}<select value={providerId} disabled={busy} onChange={event => {
      setProviderId(event.target.value); setModel('');
    }}><option value="">{copy.choose}</option>{providers.filter(item => item.enabled).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label>{copy.model}<input value={model} maxLength={240} placeholder={copy.followDefault} disabled={busy} onChange={event => setModel(event.target.value)} /></label>
    <label className="check-row"><input type="checkbox" checked={memoryAllowed} disabled={busy || !state.bound} onChange={event => setMemoryAllowed(event.target.checked)} />{copy.memory}</label>
    <small>{copy.memoryHelp}</small>
    <button type="submit" disabled={busy}>{copy.save}</button>
  </form>;
};

export const TelegramSettings = ({ providers, locale }: { providers: ProviderConfig[]; locale: ResolvedLocale }): JSX.Element => {
  const copy = locale === 'zh-CN' ? zh : en;
  const api = window.deskpet.telegram;
  const [state, setState] = useState<TelegramChannelStatus | null>(null);
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [review,setReview]=useState<{bindingId:string|null;results:TelegramPendingResult[]}|null>(null);
  const reviewing=useRef(false);
  const closeReview=()=>{reviewing.current=false;setReview(null);};
  const working = useRef(false);
  const generation = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    if (working.current) return;
    const request = ++generation.current;
    try {
      const next = await api.getState();
      if (request === generation.current) { setState(next); setError(false);
        if (reviewing.current && next.bound && next.enabled) {
          const results=await api.pendingResults();
          if(request===generation.current && reviewing.current)setReview({bindingId:next.bindingId,results});
        }
      }
    } catch { if (request === generation.current) setError(true); }
  }, [api]);
  useEffect(() => {
    void refresh();
    const counter = generation;
    return () => { counter.current++; };
  }, [refresh]);
  useEffect(() => {
    if (!state?.enabled) return;
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [state?.enabled, refresh]);
  const perform = async (operation: () => Promise<TelegramChannelStatus>): Promise<boolean> => {
    if (working.current) return false;
    closeReview(); working.current = true; setBusy(true); setError(false);
    const request = ++generation.current;
    try {
      const next = await operation();
      if (request === generation.current) setState(next);
      return true;
    } catch { if (request === generation.current) setError(true); return false; }
    finally { working.current = false; if (request === generation.current) setBusy(false); }
  };
  const configure = (input: TelegramConfigureInput): Promise<boolean> => perform(async () => {
    const next = await api.configure(input);
    setPairing(null);
    return next;
  });
  const candidate = state?.pairingCandidate;
  const when = (iso: string): string => new Date(iso).toLocaleTimeString(locale);
  return <section className="qq-settings" data-testid="telegram-settings" aria-label={copy.title}>
    <h2>{copy.title}</h2><p>{copy.setup}</p><p>{copy.boundary}</p>
    {error && <p role="alert">{copy.error}</p>}
    <button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}>{copy.refresh}</button>
    {!state ? <p role="status">{copy.loading}</p> : <>
      <dl className="qq-status"><dt>{copy.status}</dt><dd>{copy[state.connection]}</dd>
        <dt>{copy.owner}</dt><dd>{state.bound ? state.bindingDisplayName : copy.none}</dd>
        {state.lastError && <><dt>{copy.lastError}</dt><dd>{state.lastError}</dd></>}
        <dt>{copy.inbox}</dt><dd>{state.pendingInbox}</dd><dt>{copy.outbox}</dt><dd>{state.pendingOutbox}</dd>
        <dt>{copy.uncertain}</dt><dd>{state.uncertainOutbox}</dd></dl>
      {state.uncertainOutbox > 0 && <p role="status">{copy.uncertainHelp}</p>}
      <ConnectionForm key={JSON.stringify([state.providerId, state.model, state.memoryAllowed])} state={state} providers={providers} busy={busy} copy={copy} save={configure} />
      <div className="qq-actions">
        <button type="button" disabled={busy || (!state.enabled && (!state.secretConfigured || !state.providerId))} onClick={() => void configure({ enabled: !state.enabled })}>{state.enabled ? copy.disable : copy.enable}</button>
        <button type="button" className="secondary" disabled={busy || !state.secretConfigured} onClick={() => void configure({ token: null, enabled: false })}>{copy.clear}</button>
      </div>
      <h3>{copy.pairing}</h3>
      {state.bound ? <button type="button" disabled={busy} onClick={() => void perform(async () => { const next = await api.unbind(); setPairing(null); return next; })}>{copy.unbind}</button> :
        <button type="button" disabled={busy || !state.enabled} onClick={() => void perform(async () => {
          const code = await api.startPairing(); setPairing(code); return api.getState();
        })}>{copy.start}</button>}
      {pairing && state.enabled && !state.bound && !candidate && Date.parse(pairing.expiresAt) > Date.now() && <div className="qq-pairing"><p>{copy.codeHelp}</p>
        <code data-testid="telegram-pairing-code">/pair {pairing.code}</code><p>{copy.expires} <time dateTime={pairing.expiresAt}>{when(pairing.expiresAt)}</time></p></div>}
      {candidate && <div className="qq-pairing"><h4>{copy.candidate}</h4><p>{candidate.displayName} · <code>{candidate.userId}</code></p><p>{copy.verify}</p>
        <button type="button" data-testid="telegram-confirm" disabled={busy || !state.enabled} onClick={() => void perform(() => api.confirmPairing(candidate.id))}>{copy.confirm}</button></div>}
      {state.bound && state.enabled && <section aria-label={locale==='zh-CN'?'待批准结果':'Pending results'}>
        <h3>{locale==='zh-CN'?'待批准结果':'Results awaiting approval'}</h3>
        <button type="button" onClick={()=>{if(reviewing.current){closeReview();return;} reviewing.current=true;void refresh();}}>
          {review && review.bindingId===state.bindingId?(locale==='zh-CN'?'隐藏原文':'Hide original results'):(locale==='zh-CN'?'查看待批准结果':'Review pending results')}
        </button>
        {review?.bindingId===state.bindingId && review && <>{review.results.length===0?<p>{locale==='zh-CN'?'当前没有待批准结果。':'No results are awaiting approval.'}</p>:
          review.results.map(r=><article key={r.id}><h4>{r.reference}</h4><p>{locale==='zh-CN'?'来源消息':'Source message'} <code>{r.sourceId}</code></p><pre style={{whiteSpace:'pre-wrap'}}>{r.content}</pre></article>)}</>}
      </section>}
      <section data-testid="telegram-diagnostics"  aria-label={copy.diagnostics}><h3>{copy.diagnostics}</h3><p>{copy.diagnosticsHelp}</p>
        {state.diagnostics.length === 0 ? <p>{copy.noEvents}</p> : <ul className="simple-list">{state.diagnostics.map((event, index) => <li key={index}>
          <time dateTime={event.at}>{when(event.at)}</time> · <code>{event.type}</code> · {copy[event.outcome]}{event.field ? <> · {copy.field} <code>{event.field}</code></> : null}
        </li>)}</ul>}
        <button type="button" className="secondary" disabled={busy || !state.bound || !state.enabled} onClick={() => void perform(() => api.retryDeliveries())}>{copy.retry}</button>
      </section>
    </>}
  </section>;
};
