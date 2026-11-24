import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { AutomaticTrigger, AutomationSnapshot, AutomationUIProps, CalendarRule, PersistentSchedule, PersistentScheduleInput } from '../../shared/automation';
import { automaticFailureMessage } from './AttentionCenter';

const text = {
  en: { moreOptions: 'More options (time zone, missed runs, material, privacy)', newSchedule: 'New schedule', title: 'Persistent text schedules', detail: 'Each occurrence creates one no-tool text job. Hiding the window does not stop accepted work. App exit stops execution; restart or wake uses the selected missed policy. A request with an unknown dispatched result is never automatically resent.',
    name: 'Schedule title', kind: 'Time rule', once: 'Once', daily: 'Daily', weekly: 'Weekly', at: 'When', time: 'Local time', day: 'Weekday', zone: 'Time zone (defaults to this computer)', provider: 'Provider', instruction: 'Instruction', material: 'Explicit material', privacy: 'Context privacy', local: 'Local only', cloud: 'Allow remote provider for this material', missed: 'When an execution was missed', skip: 'Skip missed executions', catchup: 'Coalesce missed executions into one job', preview: 'Preview next times', save: 'Save schedule', update: 'Update schedule', cancelEdit: 'Cancel editing', enabled: 'Enabled', pause: 'Pause', resume: 'Resume', cancel: 'Cancel schedule', edit: 'Edit', run: 'Run once now', refresh: 'Refresh history', next: 'Next execution', none: 'None', history: 'Execution history', due: 'Scheduled instant', outcome: 'Outcome', job: 'Job', reason: 'Reason', empty: 'No persistent text schedules.', noHistory: 'No executions recorded.', failed: 'The schedule operation failed. State may contain a durable cancellation or an unknown submission; refresh before taking another action.', dst: 'DST gaps are skipped. A repeated local time runs only at its earlier occurrence. Weekly days use Sunday = 0.', cap: 'History keeps durable trigger identities. At 2,000 shared trigger records, new triggers are refused rather than deleting deduplication evidence.', needProvider: 'Choose an enabled provider.', cancelConfirm: 'Cancel this schedule and suppress its pending results?', cancelled: 'Cancelled', active: 'Active', paused: 'Paused', weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] },
  zh: { moreOptions: '更多选项（时区、错过时的处理、材料、隐私）', newSchedule: '新建文本定时任务', title: '纯文本定时任务', detail: '到点自动让模型写一段文字，只生成文本、不调用工具。退出 App 后不运行，重启或唤醒后按你选的方式处理错过的任务；结果未知的请求不会自动重发。',
    name: '定时任务标题', kind: '时间规则', once: '单次', daily: '每天', weekly: '每周', at: '提醒时间', time: '当地时间', day: '星期', zone: '时区（默认跟随这台电脑）', provider: '模型服务', instruction: '指令', material: '明确提供的材料', privacy: '上下文隐私', local: '仅本地', cloud: '允许将这些材料发送到远程 provider', missed: '错过执行时', skip: '跳过错过的执行', catchup: '将错过的执行合并补一次', preview: '预览下次执行时间', save: '保存定时任务', update: '更新定时任务', cancelEdit: '取消编辑', enabled: '启用', pause: '暂停', resume: '恢复', cancel: '取消定时任务', edit: '编辑', run: '立即执行一次', refresh: '刷新执行历史', next: '下次执行', none: '无', history: '执行历史', due: '计划时间', outcome: '结果', job: 'Job', reason: '原因', empty: '尚无持久文本定时任务。', noHistory: '尚无执行记录。', failed: '定时操作失败。可能已保存取消意图，或提交状态未知；请先刷新再操作。', dst: '夏令时不存在的时刻跳过，重复的当地时刻只取较早一次。星期日为 0。', cap: '历史保留持久触发身份。共享触发记录达到 2,000 条后拒绝新触发，不删除去重证据。', needProvider: '请选择已启用的 provider。', cancelConfirm: '取消此定时任务并阻止待完成结果发布？', cancelled: '已取消', active: '启用中', paused: '已暂停', weekdays: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] },
};

const TRIGGER_STATUS: Record<AutomaticTrigger['status'], [string, string]> = {
  reserved: ['准备中', 'Preparing'], submitted: ['进行中', 'Running'], succeeded: ['已完成', 'Done'], failed: ['没成功', 'Failed'],
  missed: ['错过了', 'Missed'], cancelled: ['已取消', 'Cancelled'], blocked: ['被拦下', 'Blocked'], unknown: ['结果未知', 'Unknown'],
};

const SCHEDULE_REASONS: Record<string, [string, string]> = {
  'schedule.reservationUncertain': ['没能确认这次是否开始了，不会自动重试', 'Could not confirm it started; it will not be retried automatically'],
  'schedule.submissionUnknown': ['没能确认这次是否发出，不会自动重发', 'Could not confirm it was sent; it will not be resent automatically'],
  'schedule.missedSkipped': ['DeskPet 当时没开，已按设置跳过', 'DeskPet was closed then; skipped as set'],
  'schedule.paused': ['任务已暂停', 'The task was paused'], 'schedule.cancelled': ['任务已取消', 'The task was cancelled'],
  'schedule.authorizationChanged': ['权限变了，这次没运行', 'Permission changed, so it did not run'],
  'schedule.configurationChanged': ['设置变了，这次没运行', 'Settings changed, so it did not run'],
  'schedule.capacity': ['同时进行的任务太多，这次没运行', 'Too many tasks at once, so it did not run'],
};
const reasonText = (code: string, locale: string): string => SCHEDULE_REASONS[code]?.[locale === 'zh-CN' ? 0 : 1] ?? automaticFailureMessage(code, locale);

/** ISO instant ⇄ the value of a local <input type="datetime-local">, in this computer's time zone. */
const toLocalInput = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const fromLocalInput = (value: string): string => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toISOString(); };

export const PersistentSchedules = ({ api, providers, locale }: AutomationUIProps): JSX.Element => {
  const copy = locale === 'zh-CN' ? text.zh : text.en;
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const [viewedResult,setViewedResult]=useState<Awaited<ReturnType<typeof api.triggerResult>>|null>(null);
  const [snapshot, setSnapshot] = useState<AutomationSnapshot | null>(null);
  const [editing, setEditing] = useState<PersistentSchedule | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<CalendarRule['kind']>('daily');
  const [at, setAt] = useState(() => new Date(Date.now() + 3_600_000).toISOString());
  const [time, setTime] = useState('09:00');
  const [weekday, setWeekday] = useState(1);
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [providerId, setProviderId] = useState(enabledProviders[0]?.id ?? '');
  const [model, setModel] = useState('');
  const [instruction, setInstruction] = useState('');
  const [material, setMaterial] = useState('');
  const [privacy, setPrivacy] = useState<PersistentScheduleInput['privacy']>('local-only');
  const [missedPolicy, setMissedPolicy] = useState<PersistentScheduleInput['missedPolicy']>('skip');
  const [enabled, setEnabled] = useState(true);
  const [preview, setPreview] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<PersistentSchedule | null>(null);
  const refresh = useCallback(async (): Promise<void> => { setSnapshot(await api.snapshot()); }, [api]);
  useEffect(() => { let live = true; void api.snapshot().then((value) => { if (live) setSnapshot(value); }).catch(() => { if (live) setError(true); }); return () => { live = false; }; }, [api]);
  // View-only IPC refresh; this does not tick a scheduler or request a model.
  useEffect(() => { const timer = setInterval(() => { void refresh().catch(() => setError(true)); }, 5000); return () => clearInterval(timer); }, [refresh]);
  const rule = useCallback((): CalendarRule => kind === 'once' ? { kind, at } : kind === 'weekly' ? { kind, time, weekday } : { kind, time }, [kind, at, time, weekday]);
  // The next run times follow the form by themselves; no separate preview step.
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      void api.schedulePreview({ rule: rule(), timezone, after: new Date().toISOString(), count: kind === 'once' ? 1 : 3 })
        .then(next => { if (live) setPreview(next); }).catch(() => { if (live) setPreview([]); });
    }, 300);
    return () => { live = false; window.clearTimeout(timer); };
  }, [api, rule, timezone, kind]);
  const perform = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError(false);
    try { await operation(); await refresh(); } catch { setError(true); } finally { setBusy(false); }
  };
  const edit = (item: PersistentSchedule | null): void => {
    setEditing(item); setTitle(item?.title ?? ''); setInstruction(item?.instruction ?? ''); setMaterial(item?.material ?? '');
    setPrivacy(item?.privacy ?? 'local-only'); setMissedPolicy(item?.missedPolicy ?? 'skip'); setEnabled(item?.enabled ?? true);
    setTimezone(item?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'); setProviderId(item?.providerId ?? enabledProviders[0]?.id ?? ''); setModel(item?.model ?? '');
    setKind(item?.rule.kind ?? 'daily'); if (item?.rule.kind === 'once') setAt(item.rule.at); else setTime(item?.rule.time ?? '09:00');
    setWeekday(item?.rule.kind === 'weekly' ? item.rule.weekday : 1);
  };
  const input = (item: PersistentSchedule): PersistentScheduleInput => ({ id: item.id, title: item.title, instruction: item.instruction, material: item.material,
    privacy: item.privacy, providerId: item.providerId, model: item.model, rule: item.rule, timezone: item.timezone, missedPolicy: item.missedPolicy, enabled: item.enabled });
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); const provider = enabledProviders.find((item) => item.id === providerId);
    if (!provider || !title.trim() || !instruction.trim()) { setError(true); return; }
    await perform(async () => { await api.scheduleUpsert({ id: editing?.id ?? crypto.randomUUID(), title: title.trim(), instruction: instruction.trim(), material,
      privacy, providerId: provider.id, model: model.trim() || null, rule: rule(), timezone, missedPolicy, enabled }); edit(null); setFormOpen(false); });
  };
  const date = (value: string): string => {
    try { return new Intl.DateTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'long', timeZone: timezone }).format(new Date(value)); }
    catch { return value; }
  };
  const showForm = formOpen || editing !== null || (snapshot?.automationSchedules.length ?? 0) === 0;
  const history = snapshot?.automationTriggers.filter((trigger) => trigger.kind === 'schedule').slice().reverse().slice(0, 100) ?? [];
  return <section className="persistent-schedules"><p className="muted">{copy.detail}</p>
    {error && <p role="alert" className="error-banner">{error && !enabledProviders.length ? copy.needProvider : copy.failed}</p>}
    {showForm ? <div className="panel"><form className="stack-form" onSubmit={(event) => void save(event)}>
      <label>{copy.name}<input aria-label={copy.name} maxLength={240} required disabled={busy} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <div className="schedule-when">
      <label>{copy.kind}<select aria-label={copy.kind} disabled={busy} value={kind} onChange={(event) => { setKind(event.target.value as CalendarRule['kind']); setPreview([]); }}><option value="once">{copy.once}</option><option value="daily">{copy.daily}</option><option value="weekly">{copy.weekly}</option></select></label>
      {kind === 'once' ? <label>{copy.at}<input aria-label={copy.at} type="datetime-local" required disabled={busy} value={toLocalInput(at)} onChange={(event) => { setAt(fromLocalInput(event.target.value)); }} /></label>
        : <label>{copy.time}<input aria-label={copy.time} type="time" required disabled={busy} value={time} onChange={(event) => { setTime(event.target.value); setPreview([]); }} /></label>}
      {kind === 'weekly' && <label>{copy.day}<select aria-label={copy.day} disabled={busy} value={weekday} onChange={(event) => { setWeekday(Number(event.target.value)); setPreview([]); }}>{copy.weekdays.map((name, index) => <option key={name} value={index}>{name}</option>)}</select></label>}
      </div>
      {preview.length > 0 && <p className="muted" aria-label={copy.next}>{copy.next}: {preview.map((value) => <time key={value} dateTime={value}>{date(value)}</time>).reduce<JSX.Element[]>((all, item, index) => index ? [...all, <span key={`sep${index}`}>、</span>, item] : [item], [])}</p>}
      <label>{copy.instruction}<textarea aria-label={copy.instruction} required maxLength={4000} disabled={busy} value={instruction} onChange={(event) => setInstruction(event.target.value)} /></label>
      <label>{copy.provider}<select aria-label={copy.provider} disabled={busy} value={providerId} required onChange={(event) => { setProviderId(event.target.value); setModel(''); }}><option value="">{copy.needProvider}</option>{enabledProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}</select></label>
      <details className="settings-more"><summary>{copy.moreOptions}</summary><div className="stack-form">
      <label>{locale === 'zh-CN' ? '模型' : 'Model'}<input maxLength={240} disabled={busy} value={model}
        placeholder={locale === 'zh-CN' ? '跟随服务默认模型' : 'Follow provider default'}
        onChange={event => setModel(event.target.value)} /></label>
      <label>{copy.zone}<input aria-label={copy.zone} required maxLength={128} disabled={busy} value={timezone} onChange={(event) => { setTimezone(event.target.value); setPreview([]); }} /></label>
      <label>{copy.missed}<select aria-label={copy.missed} disabled={busy} value={missedPolicy} onChange={(event) => setMissedPolicy(event.target.value as PersistentScheduleInput['missedPolicy'])}><option value="skip">{copy.skip}</option><option value="run-once">{copy.catchup}</option></select></label>
      <p className="muted">{copy.dst}</p>
      <label>{copy.material}<textarea aria-label={copy.material} maxLength={32000} disabled={busy} value={material} onChange={(event) => setMaterial(event.target.value)} /></label>
      <label>{copy.privacy}<select aria-label={copy.privacy} disabled={busy} value={privacy} onChange={(event) => setPrivacy(event.target.value as PersistentScheduleInput['privacy'])}><option value="local-only">{copy.local}</option><option value="cloud-allowed">{copy.cloud}</option></select></label>
      </div></details>
      <label className="check-row"><input type="checkbox" disabled={busy} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{copy.enabled}</label>
      <div className="button-row"><button type="submit" disabled={busy || !enabledProviders.length}>{editing ? copy.update : copy.save}</button>{editing && <button type="button" className="secondary" disabled={busy} onClick={() => edit(null)}>{copy.cancelEdit}</button>}</div>
    </form></div> : <div className="schedule-actions"><button type="button" onClick={() => setFormOpen(true)}>{copy.newSchedule}</button></div>}
    {(snapshot?.automationSchedules.length ?? 0) > 0 && <div className="panel"><ul className="simple-list">{snapshot?.automationSchedules.map((item) => <li key={item.id} aria-label={item.title} data-schedule-id={item.id}><div><strong>{item.title}</strong><small>{item.cancelledAt ? copy.cancelled : item.enabled ? copy.active : copy.paused} · {item.timezone}</small><small>{copy.next}: {item.nextRunAt ? `${new Intl.DateTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'long', timeZone: item.timezone }).format(new Date(item.nextRunAt))} (${item.nextRunAt})` : copy.none}</small><small>{item.missedPolicy === 'skip' ? copy.skip : copy.catchup}</small></div>
      {!item.cancelledAt && <div className="button-row"><button type="button" className="secondary" disabled={busy} onClick={() => void perform(() => item.enabled ? api.schedulePause(item.id) : api.scheduleUpsert({ ...input(item), enabled: true }))}>{item.enabled ? copy.pause : copy.resume}</button><button type="button" className="secondary" disabled={busy} onClick={() => edit(item)}>{copy.edit}</button><button type="button" className="secondary" disabled={busy || !item.enabled} onClick={() => void perform(() => api.scheduleRunNow({ id: item.id, operationId: crypto.randomUUID() }))}>{copy.run}</button><button type="button" className="text-button" disabled={busy} onClick={() => setConfirmCancel(item)}>{copy.cancel}</button></div>}</li>)}</ul>{snapshot?.automationSchedules.length === 0 && <p className="muted">{copy.empty}</p>}</div>}
    <div className="panel"><div className="button-row"><h2>{copy.history}</h2></div><p className="muted">{copy.cap}</p>
      {history.length ? <div className="table-wrap"><table><thead><tr><th>{copy.name}</th><th>{copy.due}</th><th>{copy.outcome}</th><th>{copy.reason}</th><th>{locale==='zh-CN'?'查看':'View'}</th></tr></thead><tbody>{history.map((trigger) => <tr key={trigger.id} data-trigger-id={trigger.id}><td>{snapshot?.automationSchedules.find((item) => item.id === trigger.sourceId)?.title ?? trigger.sourceId}</td><td><time dateTime={trigger.dueAt}>{date(trigger.dueAt)}</time></td><td>{TRIGGER_STATUS[trigger.status][locale === 'zh-CN' ? 0 : 1]}</td><td>{trigger.errorCode ? reasonText(trigger.errorCode, locale) : '—'}</td><td><button type="button" className="secondary" disabled={busy} onClick={()=>void perform(async()=>setViewedResult(await api.triggerResult(trigger.id)))}>{locale==='zh-CN'?'查看结果':'View result'}</button></td></tr>)}</tbody></table></div> : <p>{copy.noHistory}</p>}
    </div>
    {viewedResult&&<div className="panel" data-viewed-trigger-id={viewedResult.triggerId}><h2>{locale==='zh-CN'?'选定执行结果':'Selected execution result'}</h2>{viewedResult.result!==null&&<pre>{viewedResult.result}</pre>}<button type="button" className="secondary" onClick={()=>setViewedResult(null)}>{locale==='zh-CN'?'关闭结果':'Close result'}</button></div>}
    {confirmCancel && <div role="alertdialog" aria-modal="true" aria-label={copy.cancelConfirm} className="backup-pending"><div className="panel"><h2>{copy.cancelConfirm}</h2><p>{confirmCancel.title}</p><div className="button-row"><button type="button" className="secondary" disabled={busy} onClick={() => setConfirmCancel(null)}>{copy.cancelEdit}</button><button type="button" disabled={busy} onClick={() => void perform(async () => { await api.scheduleCancel(confirmCancel.id); if (editing?.id === confirmCancel.id) edit(null); setConfirmCancel(null); })}>{copy.cancel}</button></div></div></div>}
  </section>;
};
