import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ProviderConfig } from '../../shared';
import type { ResearchTask, ResearchTaskInput, ResearchTasksApi, ResearchTaskStatus } from '../../shared/research-tasks';
import './background-jobs.css';

const copy = {
  en: {
    title: 'Background research', goal: 'Research goal', material: 'Selected public material', provider: 'Provider', model: 'Model',
    minutes: 'Minutes per attempt', calls: 'Maximum tool calls per attempt',
    scope: 'Research public sources, compare evidence and save a Markdown report in this task’s own folder. Only your selected goal and material are supplied; other chats and memory are not selected.',
    limits: 'The task can search and read public pages, calculate, check time and update its own plan and files. It cannot run commands, change settings or send messages.',
    remote: 'Allow this goal and selected material to be sent to a remote model',
    local: 'Unchecked means a verified local model is required. Public web requests are part of the selected research scope.',
    run: 'Start background research', saving: 'Saving task…', recover: 'Recover this submission', preview: 'Review selected scope',
    output: 'Report location', location: 'A dedicated research/<task>/report.md in the workspace',
    lifecycle: 'Research continues while you switch chats or hide the window. Quitting stops execution. After restart, an interrupted attempt is not replayed automatically; choose Continue unfinished work to start a new bounded attempt.',
    empty: 'No research tasks yet.', refresh: 'Refresh tasks', loadError: 'Unable to read saved research tasks.',
    uncertain: 'Submission not confirmed. Recover the same submission before changing its input or starting another.',
    rejected: 'The task was not accepted. Check the selected model, permissions, input and limits.',
    actionError: 'The operation was not confirmed. Refresh the saved status before trying again.',
    bindingChanged: 'The model or permissions have changed. Create a new task with the scope you want to authorize.',
    privacyBlocked: 'Choose a verified local model or explicitly allow the selected input to be sent to a remote model.',
    cancel: 'Cancel task', resume: 'Continue unfinished work', resumeRecover: 'Recover continuation',
    resumeHelp: 'Continuation uses the same task and conversation, reuses saved evidence, preserves prior results and starts a new attempt with the selected limits.',
    conversation: 'Open task conversation', report: 'Open saved report', sources: 'Sources', history: 'Previous attempts',
    noProvider: 'Configure an enabled provider first.', noSources: 'No verified sources have been saved yet.',
    statuses: { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Cancelled', partial: 'Partially completed' } satisfies Record<ResearchTaskStatus, string>,
  },
  'zh-CN': {
    title: '后台研究', goal: '研究目标', material: '选入的公开材料', provider: 'Provider', model: '模型',
    minutes: '每次执行最多分钟', calls: '每次执行最多工具调用',
    scope: '查找公开资料、比较证据，并把 Markdown 报告保存到这项任务自己的目录。只选入你填写的目标与材料，不自动选入其他聊天或记忆。',
    limits: '可搜索和读取公开网页、计算、查看时间、更新自己的计划和文件。不执行命令、不修改设置、不发送消息。',
    remote: '允许将这些目标与选入材料发送给远端模型',
    local: '未勾选时需要已验证的本地模型。查询公开网页属于本次研究范围。',
    run: '开始后台研究', saving: '正在保存任务…', recover: '恢复本次提交', preview: '确认本次研究范围',
    output: '报告位置', location: '工作区内独立的 research/<任务>/report.md',
    lifecycle: '切换聊天或隐藏窗口后仍会继续；退出应用会停止执行。重启后不会自动重跑中断的任务，可选择“继续未完成部分”，按设定上限开始新一次执行。',
    empty: '暂无后台研究任务。', refresh: '刷新任务', loadError: '无法读取已保存的研究任务。',
    uncertain: '本次提交尚未确认。请恢复同一次提交，再修改输入或新建任务。',
    rejected: '任务未获接收，请检查所选模型、权限、输入和执行上限。',
    actionError: '操作尚未确认，请先刷新已保存状态再重试。',
    bindingChanged: '模型或权限已变化，请按希望授权的范围重新创建任务。',
    privacyBlocked: '请选择已验证的本地模型，或明确允许将选入材料发送给远端模型。',
    cancel: '取消任务', resume: '继续未完成部分', resumeRecover: '恢复本次续做',
    resumeHelp: '续做沿用同一任务和会话，复用已保存证据并保留原有成果，按所选上限开始新一次执行。',
    conversation: '打开任务会话', report: '打开已保存报告', sources: '资料来源', history: '历次执行',
    noProvider: '请先配置已启用的 Provider。', noSources: '尚无已保存的来源。',
    statuses: { queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', partial: '部分完成' } satisfies Record<ResearchTaskStatus, string>,
  },
};
const active = (task: ResearchTask): boolean => task.status === 'queued' || task.status === 'running';
const definiteRejection = (cause: unknown): boolean => /research\.(?:invalidInput|privacyBlocked|operationConflict|capacity|notResumable|attemptLimit|bindingChanged|unavailable)(?:\b|$)/u
  .test(cause instanceof Error ? cause.message : '');

export const ResearchTasks = ({ api, providers, locale, onOpenSession }: {
  api: ResearchTasksApi; providers: ProviderConfig[]; locale: 'en' | 'zh-CN'; onOpenSession?: (sessionId: string) => void;
}): JSX.Element => {
  const text = copy[locale], enabled = providers.filter(provider => provider.enabled);
  const [goal, setGoal] = useState(''), [material, setMaterial] = useState('');
  const [providerId, setProviderId] = useState(enabled[0]?.id ?? ''), [model, setModel] = useState(enabled[0]?.model ?? '');
  const [allowRemote, setAllowRemote] = useState(false), [maxMinutes, setMaxMinutes] = useState(10), [maxToolCalls, setMaxToolCalls] = useState(20);
  const [tasks, setTasks] = useState<ResearchTask[]>([]), [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false), [submissionError, setSubmissionError] = useState<'uncertain' | 'rejected' | null>(null);
  const [actionError, setActionError] = useState('');
  const submission = useRef<ResearchTaskInput | null>(null), submitting = useRef(false);
  const continuations = useRef(new Map<string, { id: string; operationId: string }>());
  const mounted = useRef(true), readSequence = useRef(0);
  const provider = enabled.find(item => item.id === providerId);
  const refresh = useCallback(async (): Promise<void> => {
    const sequence = ++readSequence.current;
    try { const saved = await api.list(); if (mounted.current && sequence === readSequence.current) { setTasks(saved); setLoadError(false); } }
    catch { if (mounted.current && sequence === readSequence.current) setLoadError(true); }
  }, [api]);
  useEffect(() => {
    mounted.current = true; void refresh();
    const unsubscribe = api.onChanged(() => void refresh());
    const interval = window.setInterval(() => void refresh(), 1500);
    return () => { mounted.current = false; unsubscribe(); window.clearInterval(interval); };
  }, [api, refresh]);

  const explain = (cause: unknown): string => {
    const reason = cause instanceof Error ? cause.message : '';
    return reason.includes('research.bindingChanged') ? text.bindingChanged : reason.includes('research.privacyBlocked') ? text.privacyBlocked : text.actionError;
  };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); if (submitting.current) return;
    const input = submission.current ?? { operationId: crypto.randomUUID(), goal: goal.trim(), material,
      providerId, model: model.trim(), allowRemote, maxMinutes, maxToolCalls };
    if (!input.goal || !input.providerId || !input.model) return;
    submission.current = input; submitting.current = true; setBusy(true); setSubmissionError(null); setActionError('');
    try {
      await api.submit(input); submission.current = null;
      if (mounted.current) { setGoal(''); setMaterial(''); }
      await refresh();
    } catch (cause) {
      const rejected = definiteRejection(cause);
      if (rejected) submission.current = null;
      if (mounted.current) { setSubmissionError(rejected ? 'rejected' : 'uncertain'); if (rejected) setActionError(explain(cause)); }
    } finally { submitting.current = false; if (mounted.current) setBusy(false); }
  };
  const act = async (operation: () => Promise<unknown>): Promise<void> => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setActionError('');
    try { await operation(); await refresh(); }
    catch (cause) { if (mounted.current) setActionError(explain(cause)); }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
  };
  const resume = async (task: ResearchTask): Promise<void> => {
    const input = continuations.current.get(task.id) ?? { id: task.id, operationId: crypto.randomUUID() };
    continuations.current.set(task.id, input);
    try { await api.resume(input); continuations.current.delete(task.id); }
    catch (cause) { if (definiteRejection(cause)) continuations.current.delete(task.id); throw cause; }
  };
  const frozen = busy || submission.current !== null;

  return <section className="background-jobs research-tasks">
    <section className="panel">
      <h1>{text.title}</h1><p>{text.scope}</p><p className="background-job-note">{text.limits}</p>
      <form className="background-job-form" onSubmit={event => void submit(event)}>
        <label>{text.goal}<textarea required maxLength={8000} value={goal} disabled={frozen} onChange={event => setGoal(event.target.value)} /></label>
        <label>{text.material}<textarea maxLength={64000} value={material} disabled={frozen} onChange={event => setMaterial(event.target.value)} /></label>
        <div className="background-job-binding">
          <label>{text.provider}<select value={providerId} disabled={frozen} onChange={event => {
            setProviderId(event.target.value); setModel(enabled.find(item => item.id === event.target.value)?.model ?? ''); setAllowRemote(false);
          }}>{!enabled.length && <option value="">{text.noProvider}</option>}{enabled.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>{text.model}<input value={model} maxLength={240} required disabled={frozen} onChange={event => setModel(event.target.value)} /></label>
        </div>
        <div className="background-job-binding">
          <label>{text.minutes}<input type="number" min={2} max={30} step={1} required value={maxMinutes} disabled={frozen} onChange={event => setMaxMinutes(Number(event.target.value))} /></label>
          <label>{text.calls}<input type="number" min={4} max={40} step={1} required value={maxToolCalls} disabled={frozen} onChange={event => setMaxToolCalls(Number(event.target.value))} /></label>
        </div>
        <label className="background-job-privacy"><input type="checkbox" checked={allowRemote} disabled={frozen} onChange={event => setAllowRemote(event.target.checked)} />{text.remote}</label>
        <p className="background-job-note">{text.local}</p>
        <details className="background-job-preview" open><summary>{text.preview}</summary><dl>
          <dt>{text.provider}</dt><dd>{provider?.name ?? text.noProvider}</dd><dt>{text.model}</dt><dd>{model}</dd>
          <dt>{text.minutes}</dt><dd>{maxMinutes}</dd><dt>{text.calls}</dt><dd>{maxToolCalls}</dd><dt>{text.output}</dt><dd>{text.location}</dd>
        </dl><pre>{goal}{material ? `\n\n${material}` : ''}</pre></details>
        <p className="background-job-note">{text.lifecycle}</p>
        <div><button type="submit" className="primary" disabled={busy || !provider || !goal.trim() || !model.trim() || maxMinutes < 2 || maxMinutes > 30 || maxToolCalls < 4 || maxToolCalls > 40}>
          {busy ? text.saving : submission.current ? text.recover : text.run}</button></div>
      </form>
      {submissionError && <p role="alert">{text[submissionError]}</p>}
      {actionError && <p role="alert">{actionError}</p>}
    </section>
    <div className="background-job-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}>{text.refresh}</button></div>
    {loadError && <p role="alert">{text.loadError}</p>}
    <div className="background-job-list">
      {!tasks.length && !loadError && <p>{text.empty}</p>}
      {tasks.map(task => <article className="panel" key={task.id} aria-label={task.input.goal}>
        <h2>{task.input.goal}</h2><strong role="status">{text.statuses[task.status]}</strong>
        <p className="background-job-note">{task.input.model} · {task.input.maxMinutes} min · {task.input.maxToolCalls} {locale === 'zh-CN' ? '次工具调用上限' : 'tool calls maximum'}</p>
        {task.summary && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' }}>{task.summary}</pre>}
        {task.errorCode === 'research.bindingChanged' && <p>{text.bindingChanged}</p>}
        <code className="background-job-id">{task.reportPath}</code>
        <div className="background-job-actions">
          {active(task) && <button type="button" className="secondary" disabled={busy} onClick={() => void act(() => api.cancel(task.id))}>{text.cancel}</button>}
          {!active(task) && task.status !== 'completed' && <button type="button" className="primary" disabled={busy} onClick={() => void act(() => resume(task))}>{continuations.current.has(task.id) ? text.resumeRecover : text.resume}</button>}
          {task.artifacts.some(artifact => artifact.path === task.reportPath) && <button type="button" className="secondary" disabled={busy} onClick={() => void act(() => api.openResult(task.id))}>{text.report}</button>}
          {task.sessionId && onOpenSession && <button type="button" className="secondary" onClick={() => onOpenSession(task.sessionId!)}>{text.conversation}</button>}
        </div>
        {!active(task) && task.status !== 'completed' && <p className="background-job-note">{text.resumeHelp}</p>}
        {task.sources.length > 0 && <details><summary>{text.sources}</summary><ul>{task.sources.map(source => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a></li>)}</ul></details>}
        {task.attempts.length > 0 && <details><summary>{text.history} ({task.attempts.length})</summary><ol>{task.attempts.map(attempt => <li key={attempt.id}>
          <strong>{text.statuses[attempt.status]}</strong> · <time dateTime={attempt.startedAt}>{new Date(attempt.startedAt).toLocaleString(locale)}</time>{attempt.summary && <p>{attempt.summary}</p>}
        </li>)}</ol></details>}
      </article>)}
    </div>
  </section>;
};
