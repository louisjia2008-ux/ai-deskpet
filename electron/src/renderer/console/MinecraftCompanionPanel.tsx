import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';

import type { ResolvedLocale } from '../../shared';
import { minecraftCompanionConfigSchema, minecraftCompanionMaterialSchema, minecraftCompanionTaskSchema } from '../../shared/minecraft-companion';
import type { MinecraftCompanionConfig, MinecraftCompanionSnapshot, MinecraftCompanionTaskInput, MinecraftCompanionTaskStatus } from '../../shared/minecraft-companion';
import './minecraft-companion-panel.css';

const defaults: MinecraftCompanionConfig = { host: '127.0.0.1', port: 25565, username: 'DeskPetCore', auth: 'offline', version: 'auto' };
const activeStates = new Set(['accepted', 'running', 'unknown']);
const copy = {
  en: { title: 'Minecraft Companion', description: 'Connect to a Java Edition server. Chat can request supported tasks; the engine executes them and reports its actual state.', connection: 'Connection', runtime: 'Engine process', loading: 'Loading connection state…', unavailable: 'Minecraft Companion is unavailable in this app build.', host: 'Server address', port: 'Port', username: 'Bot username', auth: 'Authentication', offline: 'Offline server', microsoft: 'Microsoft account', version: 'Version', owner: 'Your player name', ownerHelp: 'Only this player can give orders in game chat, starting with the bot name, e.g. "DeskPetCore, collect 3 logs". Leave empty to turn in-game orders off.', connect: 'Connect basic chat', disconnect: 'Disconnect basic chat', cancel: 'Cancel task', cancelling: 'Cancelling…', cancelHelp: 'Cancelling a task leaves survival safety behavior active. Disconnect to close the bot connection.', task: 'Task', start: 'Start basic task', logs: 'Collect logs', materials: 'Collect materials into a chest', house: 'Build a home', farm: 'Prepare a farm', follow: 'Follow me', count: 'Count', material: 'Material', chest: 'Chest coordinates', plots: 'Farm plots', bread: 'Bread', taskId: 'Task ID', status: 'Status', progress: 'Engine counters', noTask: 'No task has been submitted.', observations: 'Latest world observation', health: 'Health', food: 'Food', dimension: 'Dimension', position: 'Position', inventory: 'Inventory', unknown: 'Not observed', events: 'Recent engine events', noEvents: 'No engine events yet.', readyHelp: 'The engine process being ready does not mean the player has joined the world. Tasks require the connection to be ready.', scope: 'Logs and chest materials are bounded basic tasks. Home and farm tasks can take longer. Counts shown here are engine observations, not a guessed completion percentage.', configuration: 'Open Minecraft configuration', configurationHint: 'Connection details are in the Minecraft page. Task progress and cancellation remain available here.', safety: 'Safety behavior active', authHelp: 'Complete Microsoft sign-in in your browser using this address and code.', validation: 'Check the server settings or task parameters.', error: 'The operation failed. See the latest engine error.', paused: 'Paused', blocked: 'Engine blocked', x: 'X', y: 'Y', z: 'Z' },
  'zh-CN': { title: 'Minecraft 陪玩', description: '连接 Java 版服务器。聊天负责下达支持的任务，引擎负责执行并回传真实状态。', connection: '连接状态', runtime: '引擎进程', loading: '正在读取连接状态…', unavailable: '当前应用版本尚未提供 Minecraft 陪玩。', host: '服务器地址', port: '端口', username: '机器人用户名', auth: '认证方式', offline: '离线服务器', microsoft: '微软账号', version: '版本', owner: '你的玩家名', ownerHelp: '只有这个玩家能在游戏聊天里下指令，开头叫机器人名字，例如「DeskPetCore，收集 3 个原木」。留空则关闭游戏内指令。', connect: '连接机器人', disconnect: '断开连接', cancel: '取消任务', cancelling: '正在取消…', cancelHelp: '取消任务后，生存安全行为仍会运行。断开连接才会关闭机器人连接。', task: '任务', start: '开始基础任务', logs: '收集原木', materials: '收集物资到箱子', house: '建家', farm: '准备农田', follow: '跟随我', count: '数量', material: '物资', chest: '箱子坐标', plots: '农田格数', bread: '面包数量', taskId: '任务 ID', status: '状态', progress: '引擎计数', noTask: '尚未下达任务。', observations: '最新世界观测', health: '生命值', food: '饥饿值', dimension: '维度', position: '位置', inventory: '背包', unknown: '尚未观测', events: '最近引擎事件', noEvents: '暂无引擎事件。', readyHelp: '等待机器人进入世界，连接状态显示「已就绪」后即可下达任务。', scope: '原木和入箱物资是有数量上限的基础任务。建家和农田可能耗时较长。这里显示引擎实际观测，不估算完成百分比。', configuration: '查看 Minecraft 配置', configurationHint: '连接信息可在 Minecraft 页面设置。这里保留任务进度和取消入口。', safety: '安全行为正在执行', authHelp: '请在浏览器打开以下地址，输入验证码完成微软登录。', validation: '请检查服务器设置或任务参数。', error: '操作失败，请查看引擎错误。', paused: '已暂停', blocked: '引擎被阻塞', x: 'X', y: 'Y', z: 'Z' },
};

type Copy = typeof copy.en;
type CompanionState = MinecraftCompanionSnapshot['connectionState'] | MinecraftCompanionSnapshot['runtimeState'] | MinecraftCompanionTaskStatus;
const zhStates: Record<CompanionState, string> = {
  disconnected: '未连接', connecting: '正在连接', ready: '已就绪', error: '出错', disposed: '已关闭',
  stopped: '已停止', starting: '正在启动', stopping: '正在停止',
  accepted: '已受理', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消', unknown: '状态未知',
};
const stateLabel = (state: CompanionState, locale: ResolvedLocale): string => locale === 'zh-CN' ? zhStates[state] : state;
const taskLabels = { gatherLogs: 'logs', gatherMaterials: 'materials', homestead: 'house', farm: 'farm', followOwner: 'follow' } as const;
const zhMaterials = { log: '原木', planks: '木板', stick: '木棍', cobblestone: '圆石' };
const zhDimensions: ReadonlyMap<string, string> = new Map([
  ['overworld', '主世界'], ['the_nether', '下界'], ['the_end', '末地'],
]);
const printable = (value: unknown): string => {
  if (value === undefined || value === null) return '—';
  try { return typeof value === 'string' ? value.slice(0, 6000) : JSON.stringify(value, null, 2).slice(0, 6000); }
  catch { return '—'; }
};

const companionApi = () => {
  const api = window.deskpet.minecraftCompanion;
  if (!api) throw new Error('minecraftCompanion.unavailable');
  return api;
};

const useCompanion = () => {
  const [snapshot, setSnapshot] = useState<MinecraftCompanionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const mounted = useRef(false), pushes = useRef(0), operation = useRef(0), busyOwner = useRef(0), cancelOwner = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const api = window.deskpet.minecraftCompanion;
    const revision = pushes.current, requestOrder = operation;
    if (!api) { setError('minecraftCompanion.unavailable'); return () => { mounted.current = false; requestOrder.current++; }; }
    const unsubscribe = api.onChanged((next) => { pushes.current++; if (mounted.current) setSnapshot(next); });
    void Promise.resolve().then(() => api.getState()).then((next) => { if (mounted.current && pushes.current === revision) setSnapshot(next); }).catch((cause: unknown) => { if (mounted.current) setError(cause instanceof Error ? cause.message : 'minecraftCompanion.error'); });
    return () => { mounted.current = false; requestOrder.current++; unsubscribe(); };
  }, []);
  const perform = useCallback(async (name: string, action: () => Promise<MinecraftCompanionSnapshot>): Promise<void> => {
    const id = ++operation.current, revision = pushes.current;
    if (name === 'cancel') { cancelOwner.current = id; setCancelling(true); }
    else { busyOwner.current = id; setBusy(name); }
    setError(null);
    try {
      const next = await action();
      if (mounted.current && id === operation.current && pushes.current === revision) setSnapshot(next);
    } catch (cause) { if (mounted.current && id === operation.current) setError(cause instanceof Error ? cause.message : 'minecraftCompanion.error'); }
    finally {
      if (mounted.current && name === 'cancel' && cancelOwner.current === id) setCancelling(false);
      if (mounted.current && name !== 'cancel' && busyOwner.current === id) setBusy(null);
    }
  }, []);
  return { snapshot, error, busy, cancelling, perform, cancel: () => perform('cancel', () => companionApi().cancel()) };
};

const TaskState = ({ snapshot, text, locale }: { snapshot: MinecraftCompanionSnapshot; text: Copy; locale: ResolvedLocale }): JSX.Element => <div className="companion-task-state">
  {snapshot.task ? <><strong>{text[taskLabels[snapshot.task.name]]}</strong><dl><div><dt>{text.taskId}</dt><dd><code>{snapshot.task.taskId}</code></dd></div><div><dt>{text.status}</dt><dd title={snapshot.task.status}>{stateLabel(snapshot.task.status, locale)}{snapshot.task.paused ? ` · ${text.paused}` : ''}</dd></div></dl>{snapshot.task.progress !== null && snapshot.task.progress !== undefined && <details open><summary>{text.progress}</summary><pre>{printable(snapshot.task.progress)}</pre></details>}{snapshot.task.error && <p role="alert">{snapshot.task.error}</p>}</> : <p>{text.noTask}</p>}
  {snapshot.engine?.blocked && <p role="status">{text.blocked}</p>}
  {snapshot.safetyActive && <p role="status">{text.safety}</p>}
</div>;

export const MinecraftCompanionPanel = ({ locale }: { locale: ResolvedLocale }): JSX.Element => {
  const text = copy[locale];
  const { snapshot, error, busy, cancelling, perform, cancel } = useCompanion();
  const [config, setConfig] = useState<MinecraftCompanionConfig>(defaults);
  const edited = useRef(false);
  useEffect(() => { if (!edited.current && snapshot?.config) setConfig(snapshot.config); }, [snapshot?.config]);
  const [name, setName] = useState<MinecraftCompanionTaskInput['name']>('gatherLogs');
  const [count, setCount] = useState(4), [material, setMaterial] = useState<(typeof minecraftCompanionMaterialSchema.options)[number]>('log'), [plots, setPlots] = useState(8), [bread, setBread] = useState(1);
  const [chest, setChest] = useState({ x: 0, y: 64, z: 0 });
  const [invalid, setInvalid] = useState(false);
  const ready = snapshot?.connectionState === 'ready';
  const connecting = snapshot?.connectionState === 'connecting' || snapshot?.runtimeState === 'starting';
  const activeTask = Boolean(snapshot?.task && activeStates.has(snapshot.task.status));
  const frozen = snapshot === null || Boolean(busy) || ready || connecting || snapshot?.controlPending === 'disconnect';
  const cancelPending = cancelling || snapshot?.controlPending === 'cancel';
  const canCancel = Boolean(snapshot && (activeTask || ready || connecting || busy === 'start' || busy === 'connect'));
  const update = <K extends keyof MinecraftCompanionConfig>(key: K, value: MinecraftCompanionConfig[K]): void => { edited.current = true; setConfig((current) => ({ ...current, [key]: value })); };
  const connect = (event: FormEvent): void => {
    event.preventDefault(); const result = minecraftCompanionConfigSchema.safeParse(config); setInvalid(!result.success);
    if (result.success && !frozen) void perform('connect', () => companionApi().connect(result.data));
  };
  const start = (event: FormEvent): void => {
    event.preventDefault();
    const input = name === 'gatherLogs' ? { name, parameters: { count } } : name === 'gatherMaterials' ? { name, parameters: { chest, requirements: [{ key: material, count }] } } : name === 'farm' ? { name, parameters: { plots, bread } } : name === 'followOwner' ? { name, parameters: { stay: true } } : { name, parameters: {} };
    const result = minecraftCompanionTaskSchema.safeParse(input); setInvalid(!result.success);
    if (result.success && ready && !busy && !activeTask && !snapshot?.controlPending) void perform('start', () => companionApi().start(result.data));
  };
  const observation = snapshot?.observation;
  const dimension = observation?.dimension ?? text.unknown;
  return <section className="minecraft-companion-panel">
    <header className="page-header"><h1>{text.title}</h1><p>{text.description}</p></header>
    {(error || snapshot?.lastError || invalid) && <div className="error-banner" role="alert">{invalid ? text.validation : error === 'minecraftCompanion.unavailable' ? text.unavailable : error === 'minecraftCompanion.error' ? text.error : error ?? snapshot?.lastError}</div>}
    {!snapshot && <p role="status">{text.loading}</p>}
    <div className="companion-connection" role="status" aria-live="polite"><span>{text.connection}: <strong title={snapshot?.connectionState}>{snapshot ? stateLabel(snapshot.connectionState, locale) : '—'}</strong></span><span>{text.runtime}: <strong title={snapshot?.runtimeState}>{snapshot ? stateLabel(snapshot.runtimeState, locale) : '—'}</strong></span></div>
    <article className="panel"><h2>{text.connection}</h2><p>{text.readyHelp}</p><form className="stack-form" onSubmit={connect}>
      <fieldset className="companion-config-grid" disabled={frozen}>
        <label>{text.host}<input required maxLength={253} value={config.host} onChange={(e) => update('host', e.target.value)} autoComplete="off" /></label>
        <label>{text.port}<input required type="number" min={1} max={65535} value={config.port} onChange={(e) => update('port', Number(e.target.value))} /></label>
        <label>{text.username}<input required maxLength={config.auth === 'offline' ? 16 : 254} value={config.username} onChange={(e) => update('username', e.target.value)} autoComplete="off" /></label>
        <label>{text.auth}<select value={config.auth} onChange={(e) => update('auth', e.target.value as MinecraftCompanionConfig['auth'])}><option value="offline">{text.offline}</option><option value="microsoft">{text.microsoft}</option></select></label>
        <label>{text.version}<input required maxLength={32} value={config.version} onChange={(e) => update('version', e.target.value)} /></label>
        <label>{text.owner}<input maxLength={16} value={config.ownerName ?? ''} onChange={(e) => update('ownerName', e.target.value)} autoComplete="off" /><small>{text.ownerHelp}</small></label>
      </fieldset>
      <div className="button-row"><button type="submit" disabled={frozen}>{text.connect}</button><button type="button" className="secondary" disabled={!snapshot || snapshot.runtimeState === 'stopped' || snapshot.controlPending === 'disconnect' || busy === 'disconnect'} onClick={() => void perform('disconnect', () => companionApi().disconnect())}>{text.disconnect}</button></div>
    </form></article>
    {snapshot?.auth && <article className="panel"><h2>{text.microsoft}</h2><p>{text.authHelp}</p><code>{snapshot.auth.verificationURI}</code><p><strong>{snapshot.auth.userCode}</strong></p></article>}
    <article className="panel"><h2>{text.task}</h2><form className="stack-form" onSubmit={start}><fieldset disabled={!ready || Boolean(busy) || activeTask || Boolean(snapshot?.controlPending)} className="companion-task-fields">
      <label>{text.task}<select value={name} onChange={(e) => setName(e.target.value as MinecraftCompanionTaskInput['name'])}><option value="gatherLogs">{text.logs}</option><option value="gatherMaterials">{text.materials}</option><option value="homestead">{text.house}</option><option value="farm">{text.farm}</option><option value="followOwner">{text.follow}</option></select></label>
      {(name === 'gatherLogs' || name === 'gatherMaterials') && <label>{text.count}<input type="number" required min={1} max={64} value={count} onChange={(e) => setCount(Number(e.target.value))} /></label>}
      {name === 'gatherMaterials' && <><label>{text.material}<select value={material} onChange={(e) => setMaterial(e.target.value as typeof material)}>{minecraftCompanionMaterialSchema.options.map((key) => <option key={key} value={key}>{locale === 'zh-CN' ? zhMaterials[key] : key}</option>)}</select></label><fieldset className="companion-coordinates"><legend>{text.chest}</legend>{(['x', 'y', 'z'] as const).map((key) => <label key={key}>{text[key]}<input type="number" required step={1} value={chest[key]} onChange={(e) => setChest((current) => ({ ...current, [key]: Number(e.target.value) }))} /></label>)}</fieldset></>}
      {name === 'farm' && <><label>{text.plots}<input type="number" required min={1} max={16} value={plots} onChange={(e) => setPlots(Number(e.target.value))} /></label><label>{text.bread}<input type="number" required min={1} max={16} value={bread} onChange={(e) => setBread(Number(e.target.value))} /></label></>}
      <button type="submit">{text.start}</button>
    </fieldset></form><p>{text.scope}</p>{snapshot && <TaskState snapshot={snapshot} text={text} locale={locale} />}
    <button type="button" className="secondary companion-cancel" disabled={!canCancel || cancelPending} onClick={() => void cancel()}>{cancelPending ? text.cancelling : text.cancel}</button><p>{text.cancelHelp}</p></article>
    <article className="panel"><h2>{text.observations}</h2><dl className="companion-observations"><div><dt>{text.health}</dt><dd>{observation?.health ?? text.unknown}</dd></div><div><dt>{text.food}</dt><dd>{observation?.food ?? text.unknown}</dd></div><div><dt>{text.dimension}</dt><dd>{locale === 'zh-CN' ? zhDimensions.get(dimension) ?? dimension : dimension}</dd></div><div><dt>{text.position}</dt><dd>{observation?.position ? [observation.position.x, observation.position.y, observation.position.z].map((v) => v.toFixed(1)).join(', ') : text.unknown}</dd></div></dl><h3>{text.inventory}</h3><pre>{observation ? printable(observation.inventory) : text.unknown}</pre></article>
    <article className="panel"><h2>{text.events}</h2>{snapshot?.events.length ? <ol className="companion-events">{snapshot.events.slice(-30).reverse().map((event, index) => <li key={`${event.at}:${event.type}:${index}`}><time>{new Date(event.at).toLocaleTimeString(locale)}</time> <strong>{event.type}</strong> <span>{event.summary}</span></li>)}</ol> : <p>{text.noEvents}</p>}</article>
  </section>;
};

export const MinecraftCompanionChatStatus = ({ locale, onOpenConfiguration }: { locale: ResolvedLocale; onOpenConfiguration?: () => void }): JSX.Element | null => {
  const text = copy[locale];
  const { snapshot, error, cancelling, cancel } = useCompanion();
  if (!snapshot || (!snapshot.task && snapshot.connectionState === 'disconnected' && snapshot.runtimeState === 'stopped')) return null;
  const pending = cancelling || snapshot.controlPending === 'cancel';
  const cancellable = Boolean(snapshot.task && activeStates.has(snapshot.task.status)) || snapshot.connectionState === 'ready' || snapshot.connectionState === 'connecting';
  return <aside className="minecraft-companion-chat-status" aria-label={text.title}>
    <div role="status" aria-live="polite"><strong>{text.title}</strong> · {stateLabel(snapshot.connectionState, locale)}{snapshot.task && <> · {text[taskLabels[snapshot.task.name]]} · {stateLabel(snapshot.task.status, locale)}</>}{snapshot.task?.progress !== null && snapshot.task?.progress !== undefined && <pre>{printable(snapshot.task.progress)}</pre>}{snapshot.safetyActive && <span> · {text.safety}</span>}</div>
    {error && <p role="alert">{error === 'minecraftCompanion.unavailable' ? text.unavailable : error === 'minecraftCompanion.error' ? text.error : error}</p>}
    <div className="button-row"><button type="button" className="secondary" disabled={!cancellable || pending} onClick={() => void cancel()}>{pending ? text.cancelling : text.cancel}</button>{onOpenConfiguration && <button type="button" className="secondary" onClick={onOpenConfiguration}>{text.configuration}</button>}</div><small>{text.configurationHint} {text.cancelHelp}</small>
  </aside>;
};
