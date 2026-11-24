import { useEffect, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ProviderConfig } from '../../shared';
import type { QqChannelStatus, QqPrivateImageTestResult, QqTransportKind } from '../../shared/qq-channel';
import './qq-settings.css';

const DEFAULT_ONEBOT_URL = 'ws://127.0.0.1:3001';
const careResultText = {
  'zh-CN': { sent:'QQ 已确认发送问候。', quiet:'现在是静默时段，本次问候已跳过。', frequency:'尚在两次问候的间隔内，或已用完今天的次数 / 本时段名额。',
    offline:'QQ 尚未连接。', setup:'请确认已在「主动关心」开启自动问候、授予自动执行权限，并在桌宠空闲时重试。',
    unknown:'QQ 没有返回可靠回执，请先在手机上核对。', failed:'问候未送达，请查看投递诊断。' },
  en: { sent:'QQ confirmed the greeting.', quiet:'Quiet hours are in effect. This greeting was skipped.', frequency:'The cooldown, daily limit or current time window prevents another greeting.',
    offline:'QQ is offline.', setup:'Enable automatic check-ins in Care settings, grant the automatic execution permission, and try when DeskPet is available.',
    unknown:'Delivery was not confirmed. Check your phone first.', failed:'The greeting was not delivered. Check the delivery diagnostics.' },
} as const;
const en = {
  title: 'QQ channel · experimental',
  boundary: 'Paired private and group conversations can research public sources. QQ cannot execute commands, control your computer, access files, change permissions or read desktop conversations. Memory sharing is off by default.',
  pending: 'Group pairing and replies have been verified on QQ. Scheduled push still needs a real QQ check. QQ Cron create/update/resume require your direct /confirm after a separate full summary; pause/cancel do not. Runs only while DeskPet is open, with no missed-run catch-up. QQ tasks pause after restart and require fresh confirmation. Desktop Cron is unchanged.',
  cronLimits: 'QQ Cron limits: 10 uncancelled tasks (including paused tasks), at least 15 minutes apart per task, 4 model requests per run, at most 2048 output tokens per request, and a 120-second run deadline. Chat and Cron share the daily request limit. No files, computer control or nested Cron.',
  loading: 'Loading QQ settings…', failure: 'Could not update QQ settings. Check the configuration and retry.',
  appId: 'QQ AppID', secret: 'AppSecret (leave blank to keep saved secret)', savedSecret: 'AppSecret saved securely', noSecret: 'No AppSecret saved',
  provider: 'QQ provider', choose: 'Choose a provider', model: 'QQ model', followDefault: 'Follow provider default', daily: 'Daily request limit', web: 'Web calls before asking to continue',
  save: 'Save QQ settings', enable: 'Enable experimental QQ', disable: 'Disable QQ', stop: 'Emergency stop QQ',
  'pairing:no-active-code': 'A message arrived, but no pairing code is active. Generate a new code and send it within 5 minutes.', 'pairing:wrong-format': 'A message arrived, but it was not in the form /pair followed by 6 digits.', 'pairing:wrong-code': 'A pairing command arrived, but the code did not match. Check the digits and send it again.', 'pairing:attempts-exhausted': 'Too many wrong codes. Generate a new code.',
  errorUnreadable: 'QQ sent a message DeskPet could not read, so it was ignored.',
  groupTitle: 'Group chats', groupHelp: 'After pairing, the bot replies when someone @-mentions it in that group. Each group has its own conversation and can only look things up on the web: it never sees your private chats, memories, tasks or files. Your character settings do apply.',
  groupPair: 'Generate group pairing code', groupPairHelp: 'In the group, @-mention the bot and send this command. This page updates by itself:', gatewayDelivered: 'handled', gatewayLowSequence: 'lower sequence', gatewayDropped: 'last dropped:', gatewayEvents: 'Connection check', gatewayHelp: 'What QQ has actually sent to DeskPet since it started. Send the bot a private message, then @-mention it in the group. If no event starting with GROUP_ appears, QQ is not sending this group\'s messages to DeskPet.', gatewayNone: 'Nothing received yet.', groupPairWaiting: 'If nothing changes after you send it, the message did not reach DeskPet. Check that the bot is in this group. If sandbox mode is on in the QQ open platform, only groups listed in its sandbox settings may receive messages.', groupConfirm: 'Allow this group', groupCandidate: 'Group waiting for approval',
  groupOpen: 'Everyone in the group can use it', groupRemove: 'Remove', groupUsage: 'Group requests today',
  refresh: 'Retry', pairing: 'Generate pairing code', pairHelp: 'Send this command in a private chat with your bot; the candidate appears here by itself. The desktop must approve the candidate before any conversation is allowed.',
  expires: 'Expires', candidate: 'Candidate QQ identity', confirm: 'Confirm this QQ identity', verify: 'Verify that this is your own account before approving. This platform OpenID is not a QQ number.',
  bound: 'Bound', unbound: 'Not bound', unbind: 'Unbind and stop', clear: 'Clear saved AppSecret and stop', retry: 'Retry failed deliveries',
  retryHelp: 'Unknown delivery outcomes are never retried automatically or by this button.',
  failedDeliveries: 'Failed deliveries', uncertainDeliveries: 'Unconfirmed deliveries', lastPrivatePush: 'Last private push',
  pushStatus: { sent:'Sent', failed:'Rejected', unknown:'Unconfirmed', discarded:'Withdrawn', sending:'Sending', pending:'Queued' },
  pushHelp: 'For the official bot, check that QQ allows proactive messages from this bot. Keep DeskPet running when a reminder is due.',
  imageTest: {
    label: 'Send a test sticker to my paired private chat',
    help: 'Send one image already allowed for QQ from the sticker library. The official bot must have permission to send proactive messages.',
    sent: 'QQ confirmed the test image', failed: 'The test image could not be sent.',
    unknown: 'QQ has not confirmed the test image. Check the private chat before trying again.',
  },
  platformProblems: {
    'qq.imageUnavailable': 'No usable PNG or JPEG is available in the library with QQ sharing allowed.',
    'qq.imageUploadFailed': 'QQ did not accept the image upload.',
    'qq.imageTestOffline': 'The QQ bot is offline.',
    'qq.proactivePermission':'The platform has not granted proactive messaging to this bot.',
    'qq.recipientDeclined':'QQ reports that the recipient declined messages. Check the bot’s message settings in QQ.',
    'qq.proactiveRateLimit':'QQ limited the sending rate. Try again later.',
    'qq.friendRequired':'QQ requires the recipient to be a friend of the bot.',
    'qq.replyExpired':'QQ’s reply window has expired.', 'qq.replyLimit':'This QQ message has reached its reply limit.',
    'qq.unconfirmedReceipt':'The platform did not return a delivery receipt.', 'qq.sendPartial':'Some bubbles may already have arrived. Check your phone.',
  },
  status: 'Connection', usage: 'Requests today', outbox: 'Pending deliveries', stopped: 'Stopped',
  disabled: 'Disabled', connecting: 'Connecting', online: 'Online', offline: 'Offline',
  transport: 'Connection method', official: 'Official QQ bot', onebot: 'Secondary QQ account (NapCat / OneBot)',
  onebotRisk: 'Unofficial protocol: it may breach the QQ terms and the account can be restricted or banned. Use a secondary account you can afford to lose, never your main one.',
  onebotUrl: 'OneBot WebSocket address (this computer only)', token: 'OneBot access token (leave blank to keep saved token)', savedToken: 'Access token saved securely', noToken: 'No access token saved',
  pairHelpOnebot: 'From your main QQ, send this command in a private chat to the secondary account (you must be friends), the candidate appears here by itself. The desktop must approve the candidate before any conversation is allowed.',
  verifyOnebot: 'Verify that this is your own QQ number before approving.', lastError: 'Last problem',
  errorConnect: 'Cannot reach NapCat. Check that its container is running.', errorToken: 'NapCat rejected the access token. Make sure both sides use the same one.', errorOffline: 'The secondary account is logged out or offline. Log in again in NapCat.',
};
const zh: typeof en = {
  title: 'QQ 通道 · 实验功能',
  boundary: '配对后的私聊和群聊可以查询公开网页。QQ 不能执行命令、操作电脑、访问文件、修改权限或读取桌面对话。记忆默认不共享。',
  pending: '已在真实 QQ 上验证群聊配对和回复，定时推送仍待验证。QQ Cron 创建、修改和恢复须先收到独立的完整摘要，再由本人直接发送 /confirm 确认；暂停和取消无需确认。仅在桌宠运行时执行，错过不补跑。重启后 QQ 任务暂停，须重新确认恢复；桌面 Cron 不受影响。',
  cronLimits: 'QQ Cron 限额：最多 10 个未取消任务（含暂停任务），同一任务实际执行至少间隔 15 分钟，每轮最多 4 次模型请求，每请求最多输出 2048 tokens，执行时限 120 秒。聊天与 Cron 共用每日请求限额。不写文件、不操作电脑、不创建嵌套任务。',
  loading: '正在读取 QQ 设置…', failure: '无法更新 QQ 设置，请检查配置后重试。',
  appId: 'QQ AppID', secret: 'AppSecret（留空保留已保存密钥）', savedSecret: 'AppSecret 已安全保存', noSecret: '尚未保存 AppSecret',
  provider: 'QQ 使用的模型服务', choose: '选择模型服务', model: 'QQ 使用的模型', followDefault: '跟随服务默认模型', daily: '每日请求上限', web: '私聊联网次数（追加前）',
  save: '保存 QQ 设置', enable: '启用实验性 QQ 通道', disable: '停用 QQ', stop: '紧急停止 QQ',
  'pairing:no-active-code': '收到了消息，但当前没有有效的配对码。请重新生成，并在 5 分钟内发送。', 'pairing:wrong-format': '收到了消息，但格式不对。请发送 /pair 加 6 位数字。', 'pairing:wrong-code': '收到了配对命令，但配对码不匹配。请核对数字后重发。', 'pairing:attempts-exhausted': '配对码错误次数过多，请重新生成。',
  errorUnreadable: 'QQ 发来一条 DeskPet 读不懂的消息，已被忽略。',
  groupTitle: '群聊', groupHelp: '配对后，有人在群里 @ 机器人时它才会回复。每个群是独立对话，只能联网查资料，看不到你的私聊、记忆、任务和文件。人格设定会在群里生效。',
  groupPair: '生成群配对码', groupPairHelp: '在群里 @ 机器人并发送这条命令，本页会自动更新：', gatewayDelivered: '已处理', gatewayLowSequence: '序号回退', gatewayDropped: '最近丢弃:', gatewayEvents: '连接检查', gatewayHelp: '这里显示桌宠启动后 QQ 实际发来的事件。先私聊机器人发一条，再去群里 @ 它一次。如果没有出现 GROUP_ 开头的事件，说明 QQ 没有把这个群的消息发给桌宠。', gatewayNone: '还没有收到任何事件。', groupPairWaiting: '如果发送后这里没有变化，说明消息没有到达桌宠。请确认机器人已经进群；如果开放平台开了沙箱，可能只有沙箱配置里的群才收得到消息。', groupConfirm: '允许这个群', groupCandidate: '等待确认的群',
  groupOpen: '群里所有人都能用', groupRemove: '移除', groupUsage: '群聊今日请求',
  refresh: '重试', pairing: '生成配对码', pairHelp: '在与机器人的私聊中发送此命令，这里会自动出现待确认的身份。确认前不会允许任何对话。',
  expires: '有效期至', candidate: '候选 QQ 身份', confirm: '确认这是我的 QQ 身份', verify: '请核实是你本人的账号后再确认。此平台 OpenID 不是 QQ 号码。',
  bound: '已绑定', unbound: '未绑定', unbind: '解绑并停止', clear: '清除已保存 AppSecret 并停止', retry: '重试明确失败的投递',
  retryHelp: '结果未知的投递不会自动重发，此按钮也不会重发它们。',
  failedDeliveries: '投递失败', uncertainDeliveries: '投递结果未确认', lastPrivatePush: '最近一次主动私聊',
  pushStatus: { sent:'已发送', failed:'发送失败', unknown:'送达未确认', discarded:'已撤销', sending:'发送中', pending:'待发送' },
  pushHelp: '官方机器人还需在 QQ 客户端允许它主动发送消息。提醒到点时，请保持 DeskPet 运行。',
  imageTest: {
    label: '向已绑定私聊发送测试表情',
    help: '从图库选一张已允许 QQ 使用的图片。官方机器人需要有主动发消息的权限。',
    sent: 'QQ 已确认发送测试表情', failed: '测试表情发送失败。',
    unknown: 'QQ 尚未确认发送结果，请先在私聊里核对。',
  },
  platformProblems: {
    'qq.imageUnavailable': '图库里没有可读取且允许 QQ 使用的 PNG 或 JPEG 图片。',
    'qq.imageUploadFailed': 'QQ 未接受图片上传。',
    'qq.imageTestOffline': 'QQ 机器人当前离线。',
    'qq.proactivePermission':'QQ 平台尚未授予这个机器人主动发送权限。',
    'qq.recipientDeclined':'QQ 报告接收方拒收，请在客户端检查机器人的消息接收设置。',
    'qq.proactiveRateLimit':'QQ 限制了发送频率，请稍后再试。',
    'qq.friendRequired':'QQ 要求接收方与机器人先建立好友关系。',
    'qq.replyExpired':'这条 QQ 消息的回复时限已过。', 'qq.replyLimit':'这条 QQ 消息的回复次数已用完。',
    'qq.unconfirmedReceipt':'平台未返回有效投递回执。', 'qq.sendPartial':'部分气泡可能已经发出，请在手机上核对。',
  },
  status: '连接状态', usage: '今日请求', outbox: '待投递消息', stopped: '已停止',
  disabled: '未启用', connecting: '连接中', online: '在线', offline: '离线',
  transport: '连接方式', official: '官方 QQ 机器人', onebot: 'QQ 小号（NapCat / OneBot）',
  onebotRisk: '非官方协议：可能违反 QQ 用户协议，账号可能被限制或封禁。请使用可以舍弃的小号，不要用大号。',
  onebotUrl: 'OneBot WebSocket 地址（仅限本机）', token: 'OneBot 访问令牌（留空保留已保存令牌）', savedToken: '访问令牌已安全保存', noToken: '尚未保存访问令牌',
  pairHelpOnebot: '用大号在与小号的私聊中发送此命令（双方须是好友），这里会自动出现待确认的身份。桌面确认候选身份前，不会允许任何对话。',
  verifyOnebot: '请核实这是你本人的 QQ 号后再确认。', lastError: '最近的问题',
  errorConnect: '连不上 NapCat，请确认容器正在运行。', errorToken: 'NapCat 拒绝了访问令牌，请确认两边填的是同一个。', errorOffline: '小号已退出或离线，请在 NapCat 中重新登录。',
};

const STOP_UNCONFIRMED = 'deskpet.qq.stopUnconfirmed';

export const QqSettings = ({ providers, locale }: { providers: ProviderConfig[]; locale: string }): JSX.Element => {
  const copy = locale === 'zh-CN' ? zh : en;
  const [state, setState] = useState<QqChannelStatus | null>(null);
  const [appId, setAppId] = useState(''), [secret, setSecret] = useState('');
  const [transport, setTransport] = useState<QqTransportKind>('official'), [onebotUrl, setOnebotUrl] = useState(DEFAULT_ONEBOT_URL);
  const [providerId, setProviderId] = useState(''), [model, setModel] = useState('');
  const [daily, setDaily] = useState(50), [web, setWeb] = useState(10);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [groupPairing, setGroupPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [edited, setDirty] = useState(false);
  const dirty = edited && state !== null && (secret.length > 0 || transport !== state.transport ||
    (transport === 'onebot' ? onebotUrl.trim() !== (state.onebotUrl || DEFAULT_ONEBOT_URL) : appId.trim() !== state.appId) ||
    (providerId || null) !== state.providerId || (model.trim() || null) !== state.model ||
    daily !== state.dailyRequestLimit || web !== state.webCallLimit);
  const request = useRef(0);
  const imageTestActive = useRef(false);
  const [testingImage, setTestingImage] = useState(false);
  const [imageTest, setImageTest] = useState<{ bindingId: string; result: QqPrivateImageTestResult } | null>(null);

  const sendTestImage = async (bindingId: string): Promise<void> => {
    if (imageTestActive.current) return;
    imageTestActive.current = true; setTestingImage(true); setImageTest(null);
    try {
      const result = await window.deskpet.qq.sendPrivateImageTest(bindingId);
      setImageTest({ bindingId, result });
    } catch {
      setImageTest({ bindingId, result: { status: 'unknown', title: '', error: null } });
    } finally {
      imageTestActive.current = false; setTestingImage(false);
    }
  };
  // One reader keeps the status current while this page is open. The form is filled from the first
  // successful read (even after a failed first try) and is never overwritten by later polls.
  const formReady = useRef(false);
  const acting = useRef(false);
  // A stop whose saved state was not confirmed keeps the stop button, so it can be pressed again.
  // Kept for the session so leaving and reopening this page still offers the retry.
  const [stopUnconfirmed, setStopUnconfirmedState] = useState(() => { try { return window.sessionStorage.getItem(STOP_UNCONFIRMED) === '1'; } catch { return false; } });
  const setStopUnconfirmed = (value: boolean): void => {
    setStopUnconfirmedState(value);
    try { if (value) window.sessionStorage.setItem(STOP_UNCONFIRMED, '1'); else window.sessionStorage.removeItem(STOP_UNCONFIRMED); } catch { /* the in-page flag still applies */ }
  };
  useEffect(() => {
    const read = (): void => {
      const id = request.current;
      if (acting.current) return; // an action is running; its own result is the newer state
      void window.deskpet.qq.getState().then(value => {
        if (id !== request.current || acting.current) return; // an action started meanwhile; its result is newer
        setState(value);
        if (!formReady.current) {
          formReady.current = true;
          setAppId(value.appId); setTransport(value.transport); setOnebotUrl(value.onebotUrl || DEFAULT_ONEBOT_URL); setProviderId(value.providerId ?? ''); setModel(value.model ?? '');
          setDaily(value.dailyRequestLimit); setWeb(value.webCallLimit);
        }
      }).catch(() => { if (id === request.current && !formReady.current) setError(true); });
    };
    read();
    const timer = window.setInterval(read, 3_000);
    return () => { window.clearInterval(timer); request.current += 1; };
  }, []);

  useEffect(() => {
    if (!groupPairing) return;
    const timer = window.setInterval(() => { if (Date.parse(groupPairing.expiresAt) < Date.now()) setGroupPairing(null); }, 3_000);
    return () => window.clearInterval(timer);
  }, [groupPairing]);

  const perform = async (operation: () => Promise<QqChannelStatus>): Promise<boolean> => {
    const id = ++request.current; setBusy(true); setError(false); acting.current = true;
    try {
      const value = await operation();
      if (id === request.current) {
        setState(value); if (value.stopped || !value.enabled || value.bound) setPairing(null);
        if (!formReady.current) {
          formReady.current = true;
          setAppId(value.appId); setTransport(value.transport); setOnebotUrl(value.onebotUrl || DEFAULT_ONEBOT_URL); setProviderId(value.providerId ?? ''); setModel(value.model ?? '');
          setDaily(value.dailyRequestLimit); setWeb(value.webCallLimit);
        }
      }
      return true;
    } catch { if (id === request.current) setError(true); return false; }
    finally { acting.current = false; if (id === request.current) setBusy(false); }
  };
  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (!dirty || busy) return;
    const enteredSecret = secret; setSecret('');
    void perform(async () => {
      const result = await window.deskpet.qq.configure({ transport, ...(transport === 'onebot' ? { onebotUrl: onebotUrl.trim() } : { appId: appId.trim() }), providerId: providerId || null, model: model.trim() || null,
        dailyRequestLimit: daily, webCallLimit: web, ...(enteredSecret ? { appSecret: enteredSecret } : {}) });
      setDirty(false); return result;
    });
  };
  const startPairing = async (): Promise<void> => {
    const id = ++request.current; setBusy(true); setError(false);
    try { const value = await window.deskpet.qq.startPairing(); if (id === request.current) setPairing(value); }
    catch { if (id === request.current) setError(true); }
    finally { if (id === request.current) setBusy(false); }
  };
  const running = !!state?.enabled && !state.stopped;
  const viaOnebot = transport === 'onebot';
  const imageTestResult = imageTest && imageTest.bindingId === state?.privateBindingId ? imageTest.result : null;
  const problem = (code: string): string => Object.hasOwn(copy.platformProblems, code) ? copy.platformProblems[code as keyof typeof copy.platformProblems]
    : code === 'qq.messageUnreadable' ? copy.errorUnreadable : code === 'qq.onebotAuthFailed' ? copy.errorToken : code === 'qq.accountOffline' ? copy.errorOffline
    : ['qq.socketError', 'qq.socketClosed', 'qq.handshakeTimeout', 'qq.heartbeatTimeout'].includes(code) && state?.transport === 'onebot' ? copy.errorConnect : code;
  return <section className="qq-settings" aria-label={copy.title}>
    <h2>{copy.title}</h2><p>{copy.boundary}</p>
    <details className="settings-more"><summary>{locale === 'zh-CN' ? '定时任务规则与限额' : 'Scheduled task rules and limits'}</summary><p className="qq-warning">{copy.pending}</p><p>{copy.cronLimits}</p></details>
    {error && <p role="alert">{copy.failure} <button type="button" className="secondary" disabled={busy} onClick={() => void perform(() => window.deskpet.qq.getState())}>{copy.refresh}</button></p>}
    {/* The emergency stop only exists while QQ is actually running. */}
    {(stopUnconfirmed || (state ? !state.stopped && (state.enabled || state.connection !== 'disabled') : error)) && <div className="qq-actions">
      <button type="button" className="danger" onClick={() => { setPairing(null); void perform(() => window.deskpet.qq.stop()).then(ok => setStopUnconfirmed(!ok)); }}>{copy.stop}</button>
    </div>}
    {!state ? <p role="status">{copy.loading}</p> : <>
      <dl className="qq-status"><dt>{copy.status}</dt><dd>{state.stopped ? copy.stopped : copy[state.connection]}</dd>
        <dt>{state.bound ? copy.bound : copy.unbound}</dt><dd>{state.bindingDisplayName ?? '—'}</dd>
        <dt>{copy.usage}</dt><dd>{state.dailyRequests}/{state.dailyRequestLimit}</dd><dt>{copy.outbox}</dt><dd>{state.pendingOutbox}</dd>
        {state.failedOutbox > 0 && <><dt>{copy.failedDeliveries}</dt><dd>{state.failedOutbox}</dd></>}
        {state.uncertainOutbox > 0 && <><dt>{copy.uncertainDeliveries}</dt><dd>{state.uncertainOutbox}</dd></>}
        {state.lastPrivatePush && <><dt>{copy.lastPrivatePush}</dt><dd>{copy.pushStatus[state.lastPrivatePush.status]} · <time dateTime={state.lastPrivatePush.at}>{new Date(state.lastPrivatePush.at).toLocaleString()}</time>
          {state.lastPrivatePush.errorCode && <> · {problem(state.lastPrivatePush.errorCode)}</>}</dd></>}
        {state.lastError && <><dt>{copy.lastError}</dt><dd>{problem(state.lastError)}</dd></>}</dl>
      <form onSubmit={save} onChange={() => setDirty(true)}>
        <label>{copy.transport}<select value={transport} onChange={event => setTransport(event.target.value as QqTransportKind)}>
          <option value="official">{copy.official}</option><option value="onebot">{copy.onebot}</option>
        </select></label>
        {viaOnebot ? <>
          <p className="qq-warning">{copy.onebotRisk}</p>
          <label>{copy.onebotUrl}<input autoComplete="off" value={onebotUrl} maxLength={256} onChange={event => setOnebotUrl(event.target.value)} /></label>
          <label>{copy.token}<input type="password" autoComplete="new-password" value={secret} maxLength={256} onChange={event => setSecret(event.target.value)} /></label>
          <p>{state.secretConfigured && state.transport === 'onebot' ? copy.savedToken : copy.noToken}</p>
        </> : <>
          <label>{copy.appId}<input autoComplete="off" value={appId} onChange={event => setAppId(event.target.value)} /></label>
          <label>{copy.secret}<input type="password" autoComplete="new-password" value={secret} maxLength={256} onChange={event => setSecret(event.target.value)} /></label>
          <p>{state.secretConfigured && state.transport === 'official' ? copy.savedSecret : copy.noSecret}</p>
        </>}
        <label>{copy.provider}<select value={providerId} onChange={event => { setProviderId(event.target.value); setModel(''); }}>
          <option value="">{copy.choose}</option>{providers.filter(provider => provider.enabled).map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select></label>
        <label>{copy.model}<input value={model} maxLength={240} placeholder={copy.followDefault} onChange={event => setModel(event.target.value)} /></label>
        <label>{copy.daily}<input type="number" min={1} max={1000} required value={daily} onChange={event => setDaily(Number(event.target.value))} /></label>
        <label>{copy.web}<input type="number" min={1} max={50} required value={web} onChange={event => setWeb(Number(event.target.value))} /></label>
        <small>{locale === 'zh-CN' ? '本人私聊达到该次数后会暂停询问：回复“继续搜索”为当前任务追加 20 次，或回复“先给结果”整理已有进度。群聊每轮最多 10 次，不提供私聊追加入口；定时任务保留确认时的额度。' : 'Private research pauses at this allowance. Reply “继续搜索” to add 20 web calls to the current task, or “先给结果” to receive progress so far. Groups allow at most 10 web calls per run; scheduled tasks retain their confirmed allowance.'}</small>
        <button type="submit" disabled={busy || !dirty}>{copy.save}</button>
      </form>
      {state.bound && state.privateBindingId && <section aria-label={locale==='zh-CN' ? 'QQ 一次性提醒' : 'QQ one-time reminders'}>
        <label className="check-row"><input type="checkbox" checked={state.privateRemindersEnabled === true} disabled={busy || !running || dirty}
          onChange={event=>void perform(()=>window.deskpet.qq.setPrivateReminders(state.privateBindingId!,event.target.checked))}/>
          {locale==='zh-CN' ? '允许已配对本人设置一次性私聊提醒' : 'Allow one-time reminders in my paired private chat'}
        </label>
        <p>{locale==='zh-CN' ? '在 QQ 私聊发送“十分钟后提醒我喝水”或“明早八点半提醒我出门”。说“取消刚才那条”或“取消喝水提醒”即可取消，发送“我的提醒”可以核对时间和编号。桌宠重新上线后可补发 24 小时内到期的提醒，关闭开关会取消待发提醒。'
          : 'In your private QQ chat, send /remind 10m Drink water. Use /reminders to see times and IDs, then /cancel-reminder with the ID to cancel a reminder. DeskPet delivers reminders up to 24 hours late after reconnecting. Turning this off cancels pending reminders.'}</p>
      </section>}
      <div className="qq-actions">
        <button type="button" disabled={busy || (!running && (dirty || !state.appIdConfigured || !state.secretConfigured || !state.providerId))}
          onClick={() => void perform(() => window.deskpet.qq.configure({ enabled: !running }))}>{running ? copy.disable : copy.enable}</button>
        <button type="button" disabled={busy || !running || state.bound} onClick={() => void startPairing()}>{copy.pairing}</button>
      </div>
      {state.bound && state.privateBindingId && <section className="qq-pairing" aria-label={locale === 'zh-CN' ? 'QQ 私聊关心' : 'Private QQ check-ins'}>
        <label className="check-row"><input type="checkbox" checked={state.privateCareEnabled ?? false} disabled={busy || !running}
          onChange={event => void perform(() => window.deskpet.qq.setPrivateCare(state.privateBindingId!, event.target.checked))} />
          {locale === 'zh-CN' ? '主动关心时发到我配对的 QQ 私聊' : 'Send check-ins to my paired QQ private chat'}
        </label>
        <p>{locale === 'zh-CN'
          ? '请先在「主动关心」开启自动问候并授权。桌宠运行时会在所选时区的 09:00、15:00、20:00 起的 15 分钟内各发至多一条简短问候，遵守静默时段、间隔及每日上限。锁屏或隐藏浮窗也可发送，电脑睡眠时会跳过。问候使用固定文案，只发给本人。'
          : 'Enable automatic check-ins and their permission in Care settings. While DeskPet is running, it can send one short greeting in each 15-minute window starting at 09:00, 15:00 and 20:00 in your care timezone. Quiet hours, cooldown and daily limit apply. The computer can be locked or the pet hidden. Missed windows during sleep expire. Only the paired private chat receives these fixed greetings.'}</p>
        <button type="button" disabled={busy || !running || !state.privateCareEnabled} onClick={() => void perform(() => window.deskpet.qq.sendPrivateCareNow(state.privateBindingId!))}>
          {locale === 'zh-CN' ? '现在发一条 QQ 问候' : 'Send a QQ check-in now'}
        </button>
        {state.privateCareResult && <p role="status">{careResultText[locale === 'zh-CN' ? 'zh-CN' : 'en'][state.privateCareResult]}</p>}
      </section>}
      {state.transport === 'official' && state.bound && state.privateBindingId && <section className="qq-pairing" aria-label={copy.imageTest.label}>
        <p>{copy.imageTest.help}</p>
        <button type="button" disabled={busy || dirty || testingImage || !running || state.connection !== 'online' || imageTestResult?.status === 'unknown'}
          onClick={() => void sendTestImage(state.privateBindingId!)}>{copy.imageTest.label}</button>
        {imageTestResult?.status === 'sent' && <p role="status">{copy.imageTest.sent} · {imageTestResult.title}</p>}
        {imageTestResult?.status === 'unknown' && <p role="status">{copy.imageTest.unknown}</p>}
        {imageTestResult?.status === 'failed' && <p role="alert">{copy.imageTest.failed}{imageTestResult.error ? ` ${problem(imageTestResult.error)}` : ''}</p>}
      </section>}
      {pairing && <div className="qq-pairing"><p>{state.transport === 'onebot' ? copy.pairHelpOnebot : copy.pairHelp}</p><code>/pair {pairing.code}</code><p>{copy.expires}: <time>{pairing.expiresAt}</time></p></div>}
      {state.pairingIssue && <p role="status" className="qq-warning">{copy[`pairing:${state.pairingIssue}`]}</p>}
      {state.pairingCandidate && <div className="qq-pairing"><h3>{copy.candidate}</h3><code>{state.pairingCandidate.senderId}</code><p>{state.transport === 'onebot' ? copy.verifyOnebot : copy.verify}</p>
        <button type="button" disabled={busy || !running} onClick={() => void perform(() => window.deskpet.qq.confirmPairing(state.pairingCandidate!.id))}>{copy.confirm}</button></div>}
      <section className="qq-groups" aria-label={copy.groupTitle}><h3>{copy.groupTitle}</h3><p>{copy.groupHelp}</p>
        <p>{copy.groupUsage}: {state.groupRequests}/{state.groupDailyLimit}</p>
        {state.groups.map(group => <div className="qq-pairing" key={group.id}><code>{group.groupId}</code>
          <label className="check-row"><input type="checkbox" checked={group.openToMembers} disabled={busy} onChange={event => void perform(() => window.deskpet.qq.setGroupOpen(group.id, event.target.checked))} />{copy.groupOpen}</label>
          <button type="button" className="secondary" disabled={busy} onClick={() => void perform(() => window.deskpet.qq.removeGroup(group.id))}>{copy.groupRemove}</button></div>)}
        <div className="qq-actions"><button type="button" disabled={busy || !running} onClick={() => { void window.deskpet.qq.startGroupPairing().then(setGroupPairing).catch(() => setError(true)); }}>{copy.groupPair}</button></div>
        {groupPairing && !state.groupCandidate && <div className="qq-pairing"><p>{copy.groupPairHelp}</p><code>/pair {groupPairing.code}</code><p>{copy.expires}: <time dateTime={groupPairing.expiresAt}>{new Date(groupPairing.expiresAt).toLocaleTimeString()}</time></p>
          {state.groupPairingIssue ? <p role="status" className="qq-warning">{copy[`pairing:${state.groupPairingIssue}`]}</p> : <p className="muted">{copy.groupPairWaiting}</p>}</div>}
        <details className="settings-more" key={groupPairing ? 'waiting' : 'idle'} open={groupPairing !== null}><summary>{copy.gatewayEvents}</summary><p className="muted">{copy.gatewayHelp}</p>
          {state.gatewayEvents.length === 0 ? <p>{copy.gatewayNone}</p> : <ul className="simple-list">{state.gatewayEvents.map(event => <li key={event.type}><code>{event.type}</code><small>× {event.count} · <time dateTime={event.lastAt}>{new Date(event.lastAt).toLocaleTimeString()}</time> · {copy.gatewayDelivered} {event.delivered}{event.lowSequence > 0 ? ` · ${copy.gatewayLowSequence} ${event.lowSequence}` : ''}{event.lastDrop ? ` · ${copy.gatewayDropped} ${event.lastDrop}` : ''}</small></li>)}</ul>}</details>
        {state.groupCandidate && <div className="qq-pairing"><h3>{copy.groupCandidate}</h3><code>{state.groupCandidate.groupId}</code>
          <button type="button" disabled={busy || !running} onClick={() => { setGroupPairing(null); void perform(() => window.deskpet.qq.confirmGroupPairing(state.groupCandidate!.id)); }}>{copy.groupConfirm}</button></div>}
      </section>
      <div className="qq-actions">
        <button type="button" disabled={busy || !state.bound} onClick={() => void perform(() => window.deskpet.qq.unbind())}>{copy.unbind}</button>
        <button type="button" disabled={busy || !state.secretConfigured} onClick={() => { setSecret(''); void perform(() => window.deskpet.qq.configure({ enabled: false, appSecret: null })); }}>{copy.clear}</button>
        <button type="button" disabled={busy || !running || !state.bound} onClick={() => void perform(async () => { await window.deskpet.qq.retryDeliveries(); return window.deskpet.qq.getState(); })}>{copy.retry}</button>
      </div><p>{copy.retryHelp}</p>
      {state.bound && state.transport === 'official' && <p>{copy.pushHelp}</p>}
    </>}
  </section>;
};
