import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { proactiveMode } from '../../shared/automation';
import type { AutomationSnapshot, AutomationUIProps, ProactiveEventKind, ProactiveMode, ProactiveObservationReason, ProactivePolicy, ProactivePolicyInput } from '../../shared/automation';

const eventKinds: ProactiveEventKind[] = ['task-completed', 'focus-completed', 'explicit-check-in'];
const eventTitle = (kind: ProactiveEventKind, zh: boolean): string => ({
  'task-completed': zh ? '应用内任务完成' : 'App task completed',
  'focus-completed': zh ? '专注完成' : 'Focus completed',
  'explicit-check-in': zh ? '手动测试事件' : 'Manual test event',
})[kind];
const modeTitle = (mode: ProactiveMode, zh: boolean): string => ({ off: zh ? '关闭' : 'Off', observe: zh ? '仅观察' : 'Observe only', auto: zh ? '自动问候' : 'Automatic check-ins' })[mode];
const observationReason = (reason: ProactiveObservationReason, zh: boolean): string => {
  const messages: Record<ProactiveObservationReason, [string, string]> = {
    'rules-matched': ['选定事件符合当前时间和频率规则；未执行。', 'Selected event matched timing and frequency rules; nothing was executed.'],
    disabled: ['策略已关闭。', 'Policy was off.'], 'event-unselected': ['事件未选中。', 'Event was not selected.'],
    'invalid-event': ['事件信息无效。', 'Event information was invalid.'], 'event-expired': ['事件已超过24小时。', 'Event was more than 24 hours old.'],
    'clock-before-event': ['事件时间晚于当前时间。', 'Event time was in the future.'], quiet: ['当前处于静默时段。', 'Quiet hours were active.'],
    cooldown: ['距离上次符合规则的事件过近。', 'Another matching event was too recent.'], 'daily-limit': ['已达到今日问候频率。', 'Daily check-in frequency had been reached.'],
    suspended: ['应用处于休眠状态。', 'App was suspended.'], locked: ['屏幕已锁定。', 'Screen was locked.'], busy: ['你正在使用其他交互功能。', 'Another interaction was active.'],
    hidden: ['桌宠与主窗口均不可见。', 'Both companion and main window were hidden.'], permission: ['自动执行权限不满足。', 'Automatic execution permission was unavailable.'],
    'no-provider': ['自动执行尚未选择模型。', 'No model was selected for automatic execution.'], closed: ['应用正在退出。', 'App was closing.'],
    cancelled: ['本次已取消。', 'This event was cancelled.'], 'policy-changed': ['策略已变更。', 'Policy changed.'], 'observation-only': ['仅记录观察，不执行。', 'Observation only; nothing was executed.'],
  };
  return messages[reason][zh ? 0 : 1];
};
const inputFromPolicy = ({ revision, ...input }: ProactivePolicy): ProactivePolicyInput => {
  void revision;
  return structuredClone(input);
};

/** The host API owns all rule evaluation and execution; this view only edits policy and reads records. */
export const EventProactiveSettings = ({ api, providers, locale }: AutomationUIProps): JSX.Element => {
  const zh = locale === 'zh-CN';
  const [snapshot, setSnapshot] = useState<AutomationSnapshot | null>(null);
  const [form, setForm] = useState<ProactivePolicyInput | null>(null);
  const [topics, setTopics] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const [visibleResult, setVisibleResult] = useState<{ id: string; text: string } | null>(null);
  const refresh = useCallback(async (): Promise<void> => { setSnapshot(await api.snapshot()); }, [api]);
  useEffect(() => {
    let disposed = false;
    void api.snapshot().then((loaded) => {
      if (disposed) return;
      setSnapshot(loaded); setForm(inputFromPolicy(loaded.proactivePolicy)); setTopics(loaded.proactivePolicy.topics.join('\n'));
    }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; };
  }, [api]);
  const perform = async (operation: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(false);
    try { await operation(); await refresh(); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); if (!form) return;
    await perform(async () => {
      const saved = await api.configureProactive({ ...form, topics: topics.split('\n').map((topic) => topic.trim()).filter(Boolean) });
      setForm(inputFromPolicy(saved)); setTopics(saved.topics.join('\n'));
    });
  };
  const toggleEvent = (kind: ProactiveEventKind): void => setForm((current) => current === null ? null : {
    ...current, eventKinds: current.eventKinds.includes(kind) ? current.eventKinds.filter((value) => value !== kind) : [...current.eventKinds, kind],
  });
  const providerOptions = providers.filter((provider) => provider.enabled);
  const selectedProvider = providerOptions.find(provider => provider.id === form?.providerId);
  const history = snapshot?.automationTriggers.filter((trigger) => trigger.kind === 'proactive').slice().reverse() ?? [];
  const observations = (snapshot?.proactiveObservations ?? []).slice().reverse();
  const savedMode = snapshot ? proactiveMode(snapshot.proactivePolicy) : 'off';
  const draftMode = form ? proactiveMode(form) : 'off';
  return <section aria-label={zh ? '事件观察与主动问候' : 'Event observation and check-ins'}>
    <h2>{zh ? '事件观察与主动问候' : 'Event observation and check-ins'}</h2>
    <p>{zh ? '仅使用你选择的应用内事件。不读取聊天历史、记忆、屏幕或其他应用正文。' : 'Uses only the app events you select. No chat history, memory lookup, screen or other app content.'}</p>
    <p role="status">{zh ? '已保存状态：' : 'Saved policy: '}{snapshot ? modeTitle(savedMode, zh) : zh ? '加载中' : 'Loading'}</p>
    {error && <p role="alert">{zh ? '操作未完成。请刷新核对已保存状态。' : 'The operation did not complete. Refresh to check the saved policy.'}</p>}
    {form && <form className="stack-form" onSubmit={(event) => void save(event)}>
      <label>{zh ? '运行模式' : 'Mode'}<select value={draftMode} disabled={busy} onChange={(event) => { const mode = event.target.value as ProactiveMode; setForm({ ...form, mode, enabled: mode === 'auto' }); }}>
        <option value="off">{modeTitle('off', zh)}</option><option value="observe">{modeTitle('observe', zh)}</option><option value="auto">{modeTitle('auto', zh)}</option>
      </select></label>
      <p className="muted">{draftMode === 'observe'
        ? zh ? '仅在本机检查事件、时间与频率规则，记录“本来会做什么及原因”。不调用模型、不创建任务、不发送聊天或系统通知，也不需要自动执行权限。规则满足不代表已获执行许可。' : 'Checks event, timing and frequency rules locally and records what would happen and why. No model calls, jobs, chat or system notifications, and no automatic-execution permission required. A rule match is not execution authorization.'
        : draftMode === 'auto'
          ? zh ? '自动问候会调用所选模型。仍需已保存的自动执行权限，并在派发和发布时检查隐私、静默与取消状态。' : 'Automatic check-ins call the selected model. Saved execution permission, privacy, quiet hours and cancellation are checked before dispatch and publication.'
          : zh ? '关闭后不收集新的事件，也不执行问候。' : 'Off collects no new events and does not run check-ins.'}</p>
      <fieldset disabled={busy}><legend>{zh ? '选择事件' : 'Selected events'}</legend>{eventKinds.map((kind) => <label key={kind}><input type="checkbox" checked={form.eventKinds.includes(kind)} onChange={() => toggleEvent(kind)} />{eventTitle(kind, zh)}</label>)}</fieldset>
      {draftMode === 'auto' && <>
        <label>{zh ? '服务提供方' : 'Provider'}<select value={form.providerId ?? ''} disabled={busy} onChange={(event) => {
          const provider = providerOptions.find((item) => item.id === event.target.value); setForm({ ...form, providerId: provider?.id ?? null, model: provider ? null : '' });
        }}><option value="">{zh ? '选择服务提供方' : 'Choose provider'}</option>{providerOptions.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</select></label>
        <label>{zh ? '模型' : 'Model'}<input value={form.model ?? ''} disabled={busy} maxLength={240}
          placeholder={selectedProvider ? `${zh ? '跟随服务默认模型' : 'Follow service default'} (${selectedProvider.model})` : undefined}
          onChange={(event) => setForm({ ...form, model: event.target.value || null })} /></label>
        <label>{zh ? '资料隐私' : 'Material privacy'}<select value={form.privacy} disabled={busy} onChange={(event) => setForm({ ...form, privacy: event.target.value as ProactivePolicyInput['privacy'] })}><option value="local-only">{zh ? '仅本地' : 'Local only'}</option><option value="cloud-allowed">{zh ? '允许所选服务接收此事件材料' : 'Allow selected provider to receive this event material'}</option></select></label>
      </>}
      <div className="setting-row"><label>{zh ? '静默开始' : 'Quiet start'}<input type="time" value={form.quietStart} disabled={busy} onChange={(event) => setForm({ ...form, quietStart: event.target.value })} /></label><label>{zh ? '静默结束' : 'Quiet end'}<input type="time" value={form.quietEnd} disabled={busy} onChange={(event) => setForm({ ...form, quietEnd: event.target.value })} /></label></div>
      <label>{zh ? 'IANA 时区' : 'IANA timezone'}<input value={form.timezone} disabled={busy} maxLength={128} onChange={(event) => setForm({ ...form, timezone: event.target.value })} /></label>
      <p className="muted">{zh ? '起止相同表示不设静默。仅观察记录当时的规则判断，不在稍后自动补做；自动问候中超过24小时的事件不补发。' : 'Equal endpoints mean no quiet interval. Observations record the decision at that moment and never run it later. Automatic check-ins do not replay events older than 24 hours.'}</p>
      <label>{zh ? '最短问候间隔（分钟）' : 'Minimum check-in interval (minutes)'}<input type="number" min={1} max={10080} value={form.cooldownMinutes} disabled={busy} onChange={(event) => setForm({ ...form, cooldownMinutes: Number(event.target.value) })} /></label>
      <label>{zh ? '每日最多问候次数' : 'Daily check-in frequency'}<input type="number" min={1} max={12} value={form.dailyLimit} disabled={busy} onChange={(event) => setForm({ ...form, dailyLimit: Number(event.target.value) })} /></label>
      {draftMode === 'auto' && <label>{zh ? '可选偏好主题，每行一个' : 'Optional preferred topics, one per line'}<textarea value={topics} disabled={busy} maxLength={968} onChange={(event) => setTopics(event.target.value)} /></label>}
      <button type="submit" disabled={busy}>{zh ? '保存主动策略' : 'Save check-in policy'}</button>
    </form>}
    <div className="button-row"><button type="button" className="secondary" disabled={busy} onClick={() => void perform(refresh)}>{zh ? '刷新状态' : 'Refresh status'}</button><button type="button" disabled={busy || savedMode === 'off' || !snapshot?.proactivePolicy.eventKinds.includes('explicit-check-in')} onClick={() => void perform(() => api.explicitCheckIn({ operationId: crypto.randomUUID() }))}>{savedMode === 'observe' ? zh ? '测试一次观察' : 'Test one observation' : zh ? '明确发起一次问候' : 'Request one check-in'}</button></div>
    <section aria-label={zh ? '观察记录' : 'Observation records'}><h3>{zh ? '观察记录' : 'Observation records'}</h3><p>{zh ? '仅保存最近200条本机规则观察；这里的记录不会转为模型任务。' : 'The latest 200 local rule observations are retained. These records never become model jobs.'}</p>
      {observations.length === 0 ? <p>{zh ? '暂无观察记录。保存“仅观察”并选择事件后，等待对应事件或手动测试。' : 'No observations yet. Save Observe only with selected events, then wait for an event or run a manual test.'}</p> : <div className="table-wrap"><table><thead><tr><th>{zh ? '时间' : 'Time'}</th><th>{zh ? '事件' : 'Event'}</th><th>{zh ? '规则判断' : 'Rule decision'}</th><th>{zh ? '原因' : 'Reason'}</th></tr></thead><tbody>{observations.map((entry) => <tr key={entry.id} data-observation-id={entry.id}><td><time dateTime={entry.observedAt}>{entry.observedAt}</time></td><td>{eventTitle(entry.kind, zh)}<small>{entry.summary}</small></td><td>{entry.decision === 'would-act' ? zh ? '规则满足 · 未执行' : 'Would act · not executed' : zh ? '规则不满足 · 未执行' : 'Would skip · not executed'}</td><td>{observationReason(entry.reason, zh)}</td></tr>)}</tbody></table></div>}
    </section>
    <h3>{zh ? '自动问候历史' : 'Automatic check-in history'}</h3>
    {history.length === 0 ? <p>{zh ? '尚无自动问候。' : 'No automatic check-ins yet.'}</p> : <div className="table-wrap"><table><thead><tr><th>{zh ? '时间' : 'Time'}</th><th>{zh ? '状态' : 'Status'}</th><th>{zh ? '操作' : 'Actions'}</th></tr></thead><tbody>{history.map((trigger) => <tr key={trigger.id} data-trigger-id={trigger.id}><td><time dateTime={trigger.createdAt}>{trigger.createdAt}</time></td><td>{trigger.status}{trigger.errorCode ? ` · ${trigger.errorCode}` : ''}</td><td>{['reserved', 'submitted'].includes(trigger.status) && <button type="button" disabled={busy} onClick={() => void perform(() => api.cancelTrigger(trigger.id))}>{zh ? '取消本次' : 'Cancel this trigger'}</button>}{trigger.jobId && <button type="button" className="secondary" disabled={busy} onClick={() => void perform(async () => {
      const opened = await api.triggerResult(trigger.id); setVisibleResult({ id: opened.triggerId, text: opened.result ?? (zh ? '尚无可查看结果。' : 'No result available.') });
    })}>{zh ? '明确查看结果' : 'View result explicitly'}</button>}</td></tr>)}</tbody></table></div>}
    {visibleResult && <article aria-label={zh ? '已明确打开的主动结果' : 'Explicitly opened check-in result'} data-result-trigger-id={visibleResult.id}><pre>{visibleResult.text}</pre><button type="button" className="secondary" onClick={() => setVisibleResult(null)}>{zh ? '隐藏结果' : 'Hide result'}</button></article>}
    <p className="muted">{zh ? '应用退出时不运行。事件身份保留用于去重；达到接收上限会停止接收。可能已经派发但结果未知的请求不会自动重试。' : 'Does not run after App exit. Event identities are retained for deduplication; intake stops at capacity. Possibly dispatched requests with unknown results are never automatically retried.'}</p>
  </section>;
};
