import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { DeskPetApi, ResolvedLocale } from '../../shared';
import { MINECRAFT_OFFLINE_MODEL_LIMIT_MAX } from '../../shared/minecraft-dedicated';
import type { MinecraftDedicatedSnapshot } from '../../shared/minecraft-dedicated';
import './minecraft-dedicated-panel.css';

type DedicatedAPI = NonNullable<DeskPetApi['minecraftDedicated']>;
type Plan = NonNullable<MinecraftDedicatedSnapshot['plan']>;
type Localized = readonly [zh: string, en: string];
const copy = {
  world: ['本地 Minecraft 世界', 'Local Minecraft world'],
  autoStart: ['开启后随 DeskPet 启动。关闭会停止服务器。', 'Starts with DeskPet when enabled. Turning this off stops the server.'],
  unpackaged: ['当前版本未打包专用服 Mod。', 'This build does not include the dedicated-server mod.'],
  loading: ['正在读取专用服状态…', 'Reading dedicated-server status…'],
  readError: ['无法读取专用服状态。', 'Could not read dedicated-server status.'],
  commandError: ['专用服操作未完成。', 'The dedicated-server action did not complete.'],
  retry: ['重试', 'Retry'],
  start: ['启动', 'Start'],
  stop: ['停止', 'Stop'],
  restart: ['重启', 'Restart'],
  eula: ['Minecraft EULA', 'Minecraft EULA'],
  eulaPending: ['同意 Minecraft EULA 后，DeskPet 才会下载和启动服务器。', 'Accept the Minecraft EULA before DeskPet downloads and starts the server.'],
  agree: ['同意 EULA', 'Accept EULA'],
  agreedAt: ['同意时间', 'Accepted at'],
  connect: ['在 Minecraft Java 版「多人游戏」中添加服务器', 'Add this server in Minecraft: Java Edition → Multiplayer'],
  localOnly: ['仅本机可连接。Mineflayer 机器人需要以离线模式连接。', 'Connections are limited to this computer. Mineflayer needs offline mode to join.'],
  memory: ['服务器内存', 'Server memory'],
  memoryHint: ['下次启动时生效', 'Applies on the next start'],
  backups: ['世界备份', 'World backups'],
  backupHint: ['每日及启动前备份，保留最近 3 份。', 'Backed up daily and before startup. The 3 most recent copies are kept.'],
  backupNow: ['立即备份', 'Back up now'],
  openBackups: ['打开备份文件夹', 'Open backup folder'],
  lastBackup: ['上次备份', 'Last backup'],
  never: ['暂无', 'None yet'],
  player: ['主人玩家名', 'Owner player name'],
  bot: ['机器人用户名', 'Bot username'],
  identityHint: ['填写游戏中的准确玩家名。名称区分大小写。', 'Use the exact, case-sensitive names from the game.'],
  identitySave: ['保存玩家名', 'Save player names'],
  planApproval: ['允许游戏内确认施工', 'Allow in-game construction approval'],
  noOwner: ['请先填写主人玩家名', 'Set the owner player name first'],
  modelLimit: ['离线模型每日上限', 'Daily offline model limit'],
  modelLimitHint: ['主人离线时，仅在死亡复盘或任务失败时调用模型。设为 0 可关闭离线调用。', 'While the owner is offline, calls are limited to death and task-failure reviews. Set to 0 to disable them.'],
  modelLimitSave: ['保存上限', 'Save limit'],
  limitReached: ['今日离线模型调用已达上限', 'Today’s offline model limit has been reached'],
  modelUsed: ['今日离线模型调用', 'Offline model calls today'],
  files: ['版本与文件', 'Versions and files'],
  worldPath: ['世界路径', 'World path'],
  sha256: ['Mod SHA-256', 'Mod SHA-256'],
  statusSettings: ['Minecraft 设置', 'Minecraft settings'],
  uptime: ['运行时长', 'Uptime'],
  online: ['在线玩家', 'Players online'],
  botConnection: ['机器人连接', 'Bot connection'],
  connected: ['已连接', 'Connected'],
  disconnected: ['未连接', 'Disconnected'],
  noPlayers: ['无人在线', 'No players online'],
  plan: ['当前施工', 'Current construction'],
  noPlan: ['暂无施工计划', 'No construction plan'],
  reason: ['原因', 'Reason'],
  blocked: ['受阻坐标', 'Obstruction'],
  death: ['死亡坐标', 'Death location'],
  waiting: ['等待原因', 'Waiting for'],
  progress: ['施工进度', 'Construction progress'],
  violations: ['越界', 'Out of bounds'],
  misplacements: ['放错', 'Misplacements'],
  siteChanges: ['现场变化', 'Site changes'],
  lateAttempts: ['迟到操作', 'Late actions'],
} as const satisfies Record<string, Localized>;

const serverStates = {
  unpackaged: ['未打包', 'Not packaged'],
  eula_required: ['待同意 EULA', 'EULA required'],
  stopped: ['已停止', 'Stopped'],
  starting: ['启动中', 'Starting'],
  running: ['运行中', 'Running'],
  stopping: ['停止中', 'Stopping'],
  restarting: ['崩溃重启中', 'Restarting after crash'],
  gave_up: ['已放弃自动重启', 'Automatic restart stopped'],
  error: ['异常', 'Error'],
} as const satisfies Record<MinecraftDedicatedSnapshot['status'], Localized>;

const planStates: Record<string, Localized> = {
  draft: ['草稿', 'Draft'], previewed: ['已预览', 'Previewed'], confirmed: ['已确认，等待机器人接单', 'Approved, waiting for the bot'],
  running: ['施工中', 'Building'], paused: ['已暂停', 'Paused'], completed: ['已完成', 'Completed'],
  failed: ['施工失败', 'Failed'], cancelled: ['已取消', 'Cancelled'], expired: ['已过期', 'Expired'],
};

const templates: Record<string, Localized> = {
  starter_house: ['生存小屋', 'Starter house'], porch_cabin: ['门廊木屋', 'Porch cabin'],
  two_storey_house: ['双层石木房', 'Two-storey house'], wheat_field: ['小麦田', 'Wheat field'],
};

const phases: Record<string, Localized> = {
  terrain: ['整地', 'Clearing terrain'], foundation: ['地基', 'Laying foundation'], scaffold: ['搭脚手架', 'Assembling scaffolding'],
  stair_base: ['安装楼梯起步', 'Starting stairs'], walls: ['砌墙', 'Building walls'], upper_walls: ['砌上部墙体', 'Building upper walls'],
  floor: ['铺楼板与楼梯', 'Laying floors and stairs'], roof: ['盖屋顶', 'Roofing'], furnish: ['布置家具', 'Furnishing'],
  remove_scaffold: ['拆脚手架', 'Removing scaffolding'], irrigate: ['放水', 'Irrigating'], till: ['锄地', 'Tilling'], sow: ['播种', 'Sowing'],
};

const reasons: Record<string, Localized> = {
  disabled: ['游戏内授权未启用', 'In-game approval is disabled'],
  authorization_changed: ['授权对象变更', 'Authorized players changed'],
  authorization_disabled: ['游戏内授权已关闭', 'In-game approval was turned off'],
  night: ['等天亮', 'Daylight'], materials: ['等材料', 'Materials'], chest_full: ['等材料箱腾出空间', 'Space in the supply chest'],
  bot_died: ['机器人死亡', 'The bot died'], bot_wrong_dimension: ['机器人离开了施工维度', 'The bot left the construction dimension'],
  disconnected: ['机器人断线', 'The bot disconnected'], server_restart: ['服务器重启', 'Server restarted'],
  owner_paused: ['主人暂停', 'Paused by owner'], owner_cancelled: ['主人取消', 'Cancelled by owner'],
  preview_expired: ['预览已过期', 'Preview expired'], wrong_owner: ['仅配置的主人可以操作', 'Only the configured owner can operate this plan'],
  no_reachable_stand: ['没有可达的施工站位', 'No reachable work position'],
  no_reachable_station: ['没有可达的施工站位', 'No reachable work position'],
  placement_station_unreachable: ['没有可达的施工站位', 'No reachable work position'],
  worksite_unreachable: ['无法走到施工区域', 'Construction area is unreachable'],
  placement_rejected: ['多次放置仍未达到指定状态', 'Block placement retries failed'],
  misplacement_retries_exhausted: ['多次放置仍未达到指定状态', 'Block placement retries failed'],
  supply_chest_changed: ['材料箱已发生变化', 'Supply chest changed'],
  supply_chest_unreachable: ['无法走到材料箱', 'Supply chest is unreachable'],
  site_changed: ['施工现场已发生变化', 'Construction site changed'],
  server_final_state_changed: ['现场目标格发生变化', 'A target block changed'],
  protected_block_changed: ['受保护格发生变化', 'A protected block changed'],
  expected_block_changed: ['现场方块与预期不符', 'A block differs from the preview'],
  outside_authorized_operations: ['机器人尝试了授权清单外的操作', 'The bot attempted an operation outside the approved plan'],
};

type Translate = (text: Localized) => string;
const translate = (locale: ResolvedLocale): Translate => text => text[locale === 'zh-CN' ? 0 : 1];
const label = (labels: Record<string, Localized>, value: string, t: Translate): string => {
  const entry = Object.hasOwn(labels, value) ? labels[value] : undefined;
  return entry ? t(entry) : value;
};
const dateLabel = (timestamp: string | null, locale: ResolvedLocale): string => {
  const time = timestamp === null ? Number.NaN : Date.parse(timestamp);
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(time)
    : translate(locale)(copy.never);
};

export function useDedicatedState(api: DedicatedAPI | undefined) {
  const [state, setState] = useState<MinecraftDedicatedSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const revision = useRef({ value: 0 });
  const refresh = useCallback(async (): Promise<void> => {
    if (!api) return;
    const request = ++revision.current.value;
    setFailed(false);
    try {
      const next = await api.getState();
      if (request === revision.current.value) setState(next);
    } catch {
      if (request === revision.current.value) setFailed(true);
    }
  }, [api]);
  useEffect(() => {
    const current = revision.current;
    const unlisten = api?.onChanged(next => {
      current.value++;
      setState(next);
      setFailed(false);
    });
    void refresh();
    return () => { current.value++; unlisten?.(); };
  }, [api, refresh]);
  return { state, failed, refresh };
}

function ServerBadge({ status, t }: { status: MinecraftDedicatedSnapshot['status']; t: Translate }): JSX.Element {
  const tone = status === 'running' ? 'succeeded'
    : status === 'error' || status === 'gave_up' ? 'failed'
      : status === 'eula_required' || status === 'restarting' ? 'degraded' : '';
  return <span className={`status-pill ${tone}`}>{t(serverStates[status])}</span>;
}

function ReadState({ failed, refresh, t }: { failed: boolean; refresh(): Promise<void>; t: Translate }): JSX.Element {
  return failed
    ? <div className="error-banner" role="alert">{t(copy.readError)} <button type="button" className="secondary" onClick={() => void refresh()}>{t(copy.retry)}</button></div>
    : <p role="status">{t(copy.loading)}</p>;
}

type Action = (submit: () => Promise<unknown>) => void;

function PlayerNames({ api, ownerName, botName, disabled, run, t }: {
  api: DedicatedAPI; ownerName: string; botName: string; disabled: boolean; run: Action; t: Translate;
}): JSX.Element {
  const [owner, setOwner] = useState(ownerName);
  const [bot, setBot] = useState(botName);
  const duplicate = owner.toLowerCase() === bot.toLowerCase();
  const changed = owner !== ownerName || bot !== botName;
  const attributes = { maxLength: 16, pattern: '[A-Za-z0-9_]{1,16}', autoComplete: 'off', spellCheck: false };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!duplicate && changed) run(() => api.updateIdentity({ ownerName: owner, botName: bot }));
  };
  return <form className="dedicated-inline-form" onSubmit={submit}>
    <label>{t(copy.player)}<input {...attributes} value={owner} disabled={disabled} onChange={event => setOwner(event.target.value)} /></label>
    <label>{t(copy.bot)}<input {...attributes} value={bot} disabled={disabled} onChange={event => setBot(event.target.value)} required /></label>
    <button className="secondary" disabled={disabled || duplicate || !changed}>{t(copy.identitySave)}</button>
    <p className="dedicated-note">{duplicate && owner
      ? t(['主人和机器人需要使用不同的名称。', 'The owner and bot need different names.']) : t(copy.identityHint)}</p>
  </form>;
}

function ModelLimit({ api, limit, disabled, run, t }: { api: DedicatedAPI; limit: number; disabled: boolean; run: Action; t: Translate }): JSX.Element {
  const [value, setValue] = useState(String(limit));
  const next = Number(value);
  const valid = value !== '' && Number.isInteger(next) && next >= 0 && next <= MINECRAFT_OFFLINE_MODEL_LIMIT_MAX;
  return <form className="dedicated-inline-form" onSubmit={event => {
    event.preventDefault();
    if (valid && next !== limit) run(() => api.updateSettings({ offlineModelDailyLimit: next }));
  }}>
    <label>{t(copy.modelLimit)}<input type="number" min={0} max={MINECRAFT_OFFLINE_MODEL_LIMIT_MAX} step={1} required value={value} disabled={disabled} onChange={event => setValue(event.target.value)} /></label>
    <button className="secondary" disabled={disabled || !valid || next === limit}>{t(copy.modelLimitSave)}</button>
    <p className="dedicated-note">{t(copy.modelLimitHint)}</p>
  </form>;
}

export function MinecraftDedicatedSettings({ api, locale }: { api: DedicatedAPI; locale: ResolvedLocale }): JSX.Element {
  const t = translate(locale);
  const { state, failed, refresh } = useDedicatedState(api);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const run: Action = submit => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setCommandError(null);
    void submit().catch(error => {
      const reason = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/u, '') : '';
      setCommandError(reason || t(copy.commandError));
    }).finally(() => {
      pending.current = false;
      setBusy(false);
      void refresh();
    });
  };
  if (!state) return <div><h2>Minecraft</h2><ReadState failed={failed} refresh={refresh} t={t} /></div>;
  const { status, settings, ownerName, botName, versions, error, eulaAcceptedAt } = state;
  const unpackaged = status === 'unpackaged';
  const disabled = busy || unpackaged;
  const live = status === 'running' || status === 'starting' || status === 'restarting';
  const ready = settings.enabled && eulaAcceptedAt !== null;
  return <section className="dedicated-settings" aria-labelledby="dedicated-settings-title">
    <div className="dedicated-heading"><h2 id="dedicated-settings-title">Minecraft</h2><ServerBadge status={status} t={t} /></div>
    {failed && <ReadState failed refresh={refresh} t={t} />}
    {unpackaged && <p className="notice">{t(copy.unpackaged)}</p>}
    {(commandError || error) && <p className="error-banner" role="alert">{commandError || error}</p>}
    <section className="dedicated-settings-group">
      <label className="dedicated-toggle switch-row"><span>{t(copy.world)}<small id="dedicated-world-help">{t(copy.autoStart)}</small></span>
        <input type="checkbox" role="switch" aria-label={t(copy.world)} aria-describedby="dedicated-world-help"
          checked={settings.enabled} disabled={disabled} onChange={event => run(() => api.updateSettings({ enabled: event.target.checked }))} />
      </label>
      <div className="button-row dedicated-actions">
        <button disabled={disabled || !ready || live || status === 'stopping'} onClick={() => run(() => api.start())}>{t(copy.start)}</button>
        <button className="secondary" disabled={disabled || !live} onClick={() => run(() => api.stop())}>{t(copy.stop)}</button>
        <button className="secondary" disabled={disabled || !ready || status !== 'running'} onClick={() => run(() => api.restart())}>{t(copy.restart)}</button>
      </div>
      <div className="dedicated-eula">
        <a href="https://www.minecraft.net/en-us/eula" target="_blank" rel="noreferrer">{t(copy.eula)}</a>
        {eulaAcceptedAt ? <p className="dedicated-note">{t(copy.agreedAt)} · {dateLabel(eulaAcceptedAt, locale)}</p> : <>
          <p className="dedicated-note">{t(copy.eulaPending)}</p>
          <button className="secondary" disabled={disabled} onClick={() => run(() => api.acceptEula())}>{t(copy.agree)}</button>
        </>}
      </div>
      <div className="dedicated-address">
        <p className="dedicated-note">{t(copy.connect)}</p>
        <code>localhost:{state.port}</code>
        <p className="dedicated-note">{t(copy.localOnly)}</p>
      </div>
      <label className="dedicated-memory"><span>{t(copy.memory)}<small>{t(copy.memoryHint)}</small></span>
        <select value={settings.memoryGb} disabled={disabled} onChange={event => run(() => api.updateSettings({ memoryGb: Number(event.target.value) }))}>
          {[2, 3, 4, 5, 6].map(gb => <option key={gb} value={gb}>{gb} GB</option>)}
        </select>
      </label>
    </section>
    <section className="dedicated-settings-group">
      <label className="dedicated-toggle switch-row"><span>{t(copy.planApproval)}<small id="dedicated-approval-identity">
          {t(copy.player)} · {ownerName || t(copy.noOwner)}<br />{t(copy.bot)} · {botName}
        </small></span>
        <input type="checkbox" role="switch" aria-label={t(copy.planApproval)} aria-describedby="dedicated-approval-identity"
          checked={settings.allowPlanApproval} disabled={disabled || (!settings.allowPlanApproval && !ownerName)}
          onChange={event => run(() => api.updateSettings({ allowPlanApproval: event.target.checked }))} />
      </label>
      <PlayerNames key={`${ownerName}:${botName}`} api={api} ownerName={ownerName} botName={botName} disabled={disabled} run={run} t={t} />
      <ModelLimit key={settings.offlineModelDailyLimit} api={api} limit={settings.offlineModelDailyLimit} disabled={disabled} run={run} t={t} />
    </section>
    <section className="dedicated-settings-group">
      <h3>{t(copy.backups)}</h3>
      <p className="dedicated-note">{t(copy.backupHint)} {t(copy.lastBackup)} · {dateLabel(state.lastBackupAt, locale)}</p>
      <div className="button-row dedicated-actions">
        <button className="secondary" disabled={disabled || !eulaAcceptedAt || status === 'starting' || status === 'restarting' || status === 'stopping'} onClick={() => run(() => api.backup())}>{t(copy.backupNow)}</button>
        <button className="secondary" disabled={disabled} onClick={() => run(() => api.openBackups())}>{t(copy.openBackups)}</button>
      </div>
    </section>
    <details className="dedicated-files">
      <summary>{t(copy.files)}</summary>
      <dl className="dedicated-facts">
        <div><dt>Java</dt><dd>{versions.java ?? '—'}</dd></div>
        <div><dt>Minecraft</dt><dd>{versions.minecraft}</dd></div>
        <div><dt>Mod</dt><dd>{versions.mod ?? '—'}</dd></div>
        <div className="dedicated-full-width"><dt>{t(copy.sha256)}</dt><dd><code>{versions.modSha256 ?? '—'}</code></dd></div>
        <div className="dedicated-full-width"><dt>{t(copy.worldPath)}</dt><dd><code>{state.worldPath}</code></dd></div>
      </dl>
    </details>
  </section>;
}

function Uptime({ startedAt, locale }: { startedAt: string; locale: ResolvedLocale }): JSX.Element {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const number = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false });
  return <>{[Math.floor(elapsed / 3600), Math.floor(elapsed / 60) % 60, elapsed % 60].map(value => number.format(value)).join(':')}</>;
}

function PlanProgress({ plan, t }: { plan: Plan; t: Translate }): JSX.Element {
  const status = plan.status.toLowerCase();
  const tone = status === 'completed' ? 'succeeded' : status === 'failed' ? 'failed' : status === 'paused' ? 'degraded' : '';
  const reason = plan.blocked?.reason || plan.reason;
  const position = plan.blocked?.pos;
  return <div className="dedicated-plan">
    <div className="dedicated-heading">
      <strong>{label(templates, plan.template, t)}</strong>
      <span role="status" className={`status-pill ${tone}`}>{label(planStates, status, t)}</span>
    </div>
    <div className="dedicated-progress">
      <progress aria-label={t(copy.progress)} max={Math.max(plan.total, 1)} value={plan.total === 0 && status === 'completed' ? 1 : plan.completed} />
      <span>{plan.completed}/{plan.total}</span>
    </div>
    <dl className="dedicated-facts">
      {plan.phase && <div><dt>{t(['阶段', 'Stage'])}</dt><dd>{label(phases, plan.phase, t)}</dd></div>}
      {plan.waiting && <div><dt>{t(copy.waiting)}</dt><dd>{label(reasons, plan.waiting, t)}</dd></div>}
      {reason && <div><dt>{t(copy.reason)}</dt><dd>{label(reasons, reason, t)}</dd></div>}
      {position && <div><dt>{t(reason === 'bot_died' ? copy.death : copy.blocked)}</dt>
        <dd><code>{position.x}, {position.y}, {position.z}</code>{plan.blocked?.dimension && <> · {plan.blocked.dimension}</>}</dd></div>}
      <div><dt>{t(copy.violations)}</dt><dd>{plan.violations}</dd></div>
      <div><dt>{t(copy.misplacements)}</dt><dd>{plan.misplacements}</dd></div>
      <div><dt>{t(copy.siteChanges)}</dt><dd>{plan.siteChanges}</dd></div>
      <div><dt>{t(copy.lateAttempts)}</dt><dd>{plan.lateAttempts}</dd></div>
    </dl>
  </div>;
}

export function MinecraftDedicatedStatus({ api, locale, onSettings }: { api: DedicatedAPI; locale: ResolvedLocale; onSettings(): void }): JSX.Element {
  const t = translate(locale);
  const { state, failed, refresh } = useDedicatedState(api);
  return <article className="panel dedicated-status" aria-labelledby="dedicated-status-title">
    <div className="dedicated-heading"><h2 id="dedicated-status-title">{t(copy.world)}</h2>
      <button type="button" className="secondary" onClick={onSettings}>{t(copy.statusSettings)}</button>
    </div>
    {(failed || !state) && <ReadState failed={failed} refresh={refresh} t={t} />}
    {state && <>
      <dl className="dedicated-facts">
        <div><dt>{t(['服务器', 'Server'])}</dt><dd role="status"><ServerBadge status={state.status} t={t} /></dd></div>
        <div><dt>{t(copy.uptime)}</dt><dd>{state.startedAt ? <Uptime key={state.startedAt} startedAt={state.startedAt} locale={locale} /> : '—'}</dd></div>
        <div><dt>{t(copy.online)}</dt><dd>{state.players.length > 0 ? state.players.join(', ') : t(copy.noPlayers)}</dd></div>
        <div><dt>{t(copy.botConnection)}</dt><dd>{t(state.botConnected ? copy.connected : copy.disconnected)}</dd></div>
        <div><dt>{t(copy.lastBackup)}</dt><dd>{dateLabel(state.lastBackupAt, locale)}</dd></div>
        <div><dt>{t(copy.modelUsed)}</dt><dd>{state.offlineModelUsed}/{state.settings.offlineModelDailyLimit}</dd></div>
      </dl>
      {state.error && <p className="error-banner" role="alert">{state.error}</p>}
      {state.botError && <p className="error-banner" role="alert">{state.botError}</p>}
      {state.offlineModelUsed >= state.settings.offlineModelDailyLimit && <p className="notice" role="status">{t(copy.limitReached)}</p>}
      <section className="dedicated-status-plan" aria-labelledby="dedicated-plan-title">
        <h3 id="dedicated-plan-title">{t(copy.plan)}</h3>
        {state.plan ? <PlanProgress plan={state.plan} t={t} /> : <p className="dedicated-note">{t(copy.noPlan)}</p>}
      </section>
    </>}
  </article>;
}
