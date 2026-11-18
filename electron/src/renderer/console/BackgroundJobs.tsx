import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ProviderConfig } from '../../shared';
import type { BackgroundJob, BackgroundJobInput, BackgroundJobStatus } from '../../shared/background-jobs';
import './background-jobs.css';

const copy = {
  en: {
    title: 'Background text jobs', instruction: 'Task instruction', material: 'Selected material (paste text)',
    provider: 'Provider', model: 'Model', cloud: 'Allow the instruction and selected material to be sent to this provider, including remote execution',
    privacy: 'Local only is the default. Local-only input requires a provider explicitly confirmed to execute locally. Pasting text is an explicit new input; this page does not select chat history or memory.',
    run: 'Run in background', submitting: 'Saving job…', retry: 'Recover this submission', preview: 'Submission preview',
    empty: 'No background jobs yet.', cancel: 'Cancel job', view: 'View result', close: 'Close result', result: 'Saved result',
    loadFailed: 'Unable to read the authoritative job state. Retry after storage recovers.', refresh: 'Refresh jobs',
    rejected: 'The host rejected this submission before accepting a job. Check the input, privacy choice, provider and request settings, then submit a new job.',
    submitFailed: 'The submission could not be confirmed. Keep this input and recover the same submission before starting another.',
    uncertain: 'Result unknown / waiting for storage recovery. The same submission ID will be reused; this page does not assume the job was accepted or start another generation.',
    cancelFailed: 'Cancellation could not be confirmed. Read the saved state before assuming it took effect.',
    lifecycle: 'Leaving this page, switching chats, reloading the renderer, or hiding the window does not cancel a saved job. Quitting the app stops its process. After restart, a request that may have been sent is shown as interrupted, without automatic regeneration.',
    isolation: 'One text generation attempt, no tools. Results stay here until explicitly viewed and are never inserted into chat or memory. Returned code, HTML, and commands are displayed as text.',
    cancelNotice: 'Cancellation stops new local work and asks the client to abort this request. An HTTP request already sent may still run remotely; cancellation does not prove that the server stopped or that usage is zero.',
    owner: 'Saved in this profile · fixed job result area', created: 'Submitted', destination: 'Destination', local: 'Local only', remote: 'Cloud allowed',
    waiting: 'No enabled provider is configured.', missing: 'No committed text result is available.',
  },
  'zh-CN': {
    title: '后台文本任务', instruction: '任务指令', material: '选入材料（粘贴文本）',
    provider: 'Provider', model: '模型', cloud: '允许将任务指令与选入材料发送到此 Provider，包括远端执行',
    privacy: '默认仅限本机。仅限本机输入要求 Provider 已明确确认为本机执行。粘贴文本是一次明确的新输入；本页不会自动选入聊天历史或记忆。',
    run: '后台运行', submitting: '正在保存任务…', retry: '恢复本次提交', preview: '提交预览',
    empty: '暂无后台任务。', cancel: '取消任务', view: '查看结果', close: '关闭结果', result: '持久结果',
    loadFailed: '无法读取权威任务状态。请在存储恢复后重试。', refresh: '刷新任务',
    rejected: '宿主在接收任务前拒绝了本次提交。请检查输入、隐私选择、Provider 和请求设置，修改后可明确提交新任务。',
    submitFailed: '本次提交未获确认。请保留这些输入并恢复同一次提交，再启动其他任务。',
    uncertain: '结果未知／等待存储恢复。恢复时复用同一个提交 ID；本页不会猜测任务已接收或发起另一轮生成。',
    cancelFailed: '取消尚未确认。请先读取已保存状态，不能据此认为取消已生效。',
    lifecycle: '离开本页、切换聊天、重载界面或隐藏窗口不会取消已保存任务。退出 App 会结束其进程。重启后，可能已经发出的请求显示为中断，不会自动重新生成。',
    isolation: '每个任务仅一次文本生成，不具备工具能力。结果保留在此，需显式查看，不会自动进入聊天或记忆。代码、HTML 和命令均按正文展示。',
    cancelNotice: '取消会阻止新的本地动作，并请求客户端中止该请求。已经发出的 HTTP 仍可能在远端执行；取消不证明服务端已停止，也不证明用量为零。',
    owner: '保存在当前 profile · 固定任务结果区', created: '提交于', destination: '目的地', local: '仅限本机', remote: '允许云端',
    waiting: '尚未配置可用的 Provider。', missing: '没有已提交的文本结果。',
  },
};
const statuses: Record<'en' | 'zh-CN', Record<BackgroundJobStatus, string>> = {
  en: { queued: 'Queued', dispatching: 'Dispatch intent saved', running: 'Running', succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled locally', interrupted: 'Interrupted / result unknown', blocked: 'Blocked' },
  'zh-CN': { queued: '排队中', dispatching: '派发意图已保存', running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已在本地取消', interrupted: '已中断／结果未知', blocked: '受阻' },
};
const cancellable = new Set<BackgroundJobStatus>(['queued', 'dispatching', 'running']);

export const BackgroundJobs = ({ providers, locale, openJobId = null }: { providers: ProviderConfig[]; locale: 'en' | 'zh-CN'; openJobId?: string | null | undefined }): JSX.Element => {
  const text = copy[locale];
  const enabled = providers.filter((provider) => provider.enabled);
  const [providerId, setProviderId] = useState(() => enabled[0]?.id ?? '');
  const provider = enabled.find((item) => item.id === providerId);
  const [model, setModel] = useState(() => enabled[0]?.model ?? '');
  const [instruction, setInstruction] = useState('');
  const [material, setMaterial] = useState('');
  const [cloudAllowed, setCloudAllowed] = useState(false);
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [loadingFailed, setLoadingFailed] = useState(false);
  const [submitError, setSubmitError] = useState<'uncertain' | 'failed' | 'rejected' | null>(null);
  const [actionError, setActionError] = useState<'cancel' | 'read' | null>(null);
  const [pending, setPending] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ target: string | null; job: BackgroundJob } | null>(null);
  const currentTarget = useRef(openJobId); currentTarget.current = openJobId;
  const readSequence = useRef(0); const resultSection = useRef<HTMLElement | null>(null);
  const shown = opened?.target === openJobId ? opened.job : null;
  // This is an IPC retry identity, never authority. The host owns identity,
  // idempotency comparison, immutable snapshots and the single attempt.
  const submission = useRef<BackgroundJobInput | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const saved = await window.deskpet.jobs.list();
      if (mounted.current) { setJobs(saved); setLoadingFailed(false); }
    } catch { if (mounted.current) setLoadingFailed(true); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = window.deskpet.jobs.onChanged(() => void refresh());
    const interval = window.setInterval(() => void refresh(), 1500);
    return () => { mounted.current = false; unsubscribe(); window.clearInterval(interval); };
  }, [refresh]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting.current) return;
    // When an acknowledgement is lost, the form stays frozen and retries use
    // this exact payload. Changed content requires a later explicit new job.
    const input = submission.current ?? {
      operationId: crypto.randomUUID(), instruction: instruction.trim(), material,
      privacy: cloudAllowed ? 'cloud-allowed' : 'local-only', providerId, model: model.trim(),
    };
    if (!input.instruction || !input.providerId || !input.model) return;
    submission.current = input;
    submitting.current = true; setPending(true); setSubmitError(null);
    try {
      const saved = await window.deskpet.jobs.submit(input);
      if (mounted.current) {
        setJobs((current) => [saved, ...current.filter((job) => job.id !== saved.id)]);
        setInstruction(''); setMaterial(''); setSubmitError(null);
      }
      submission.current = null;
      void refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const rejected = /(?:provider\.(?:unavailable|bindingMismatch|contextBudgetExceeded|invalidRequestBudget)|job\.(?:privacyBlocked|inputInvalid|operationConflict|maintenance|capacityExceeded))(?:\b|$)/u.test(message);
      if (rejected) submission.current = null;
      if (mounted.current) setSubmitError(rejected ? 'rejected' : message.includes('repository.commitUncertain') ? 'uncertain' : 'failed');
    } finally { submitting.current = false; if (mounted.current) setPending(false); }
  };
  const cancel = async (id: string): Promise<void> => {
    if (cancelling !== null) return;
    setCancelling(id); setActionError(null);
    try { await window.deskpet.jobs.cancel(id); await refresh(); }
    catch { if (mounted.current) setActionError('cancel'); }
    finally { if (mounted.current) setCancelling(null); }
  };
  const view = useCallback(async (id: string): Promise<void> => {
    const target = currentTarget.current, sequence = ++readSequence.current;
    setOpened(null); setActionError(null);
    try {
      const job = await window.deskpet.jobs.get(id);
      if (job.id !== id || job.resultOwner !== id || job.delegation || job.consolidation) throw new Error('job.unavailable');
      if (mounted.current && currentTarget.current === target && readSequence.current === sequence) setOpened({ target, job });
    } catch { if (mounted.current && currentTarget.current === target && readSequence.current === sequence) setActionError('read'); }
  }, []);
  useEffect(() => {
    readSequence.current++; setOpened(null);
    if (openJobId) void view(openJobId);
  }, [openJobId, view]);
  const shownId = shown?.id;
  useEffect(() => { if (shownId) { resultSection.current?.focus({ preventScroll: true }); resultSection.current?.scrollIntoView?.({ block: 'start' }); } }, [shownId]);
  const frozen = pending || submitError === 'uncertain' || submitError === 'failed';
  return <section className="background-jobs" aria-label={text.title}>
    <header><h1>{text.title}</h1><p>{text.isolation}</p></header>
    <form className="panel background-job-form" onSubmit={(event) => void submit(event)}>
      <label>{text.instruction}<textarea aria-label={text.instruction} required maxLength={32_000} value={instruction} disabled={frozen} onChange={(event) => setInstruction(event.target.value)} /></label>
      <label>{text.material}<textarea aria-label={text.material} maxLength={32_000} value={material} disabled={frozen} onChange={(event) => setMaterial(event.target.value)} /></label>
      <div className="background-job-binding">
        <label>{text.provider}<select aria-label={text.provider} value={providerId} disabled={frozen} onChange={(event) => { setProviderId(event.target.value); setModel(enabled.find((item) => item.id === event.target.value)?.model ?? ''); }}>
          {enabled.length === 0 && <option value="">{text.waiting}</option>}
          {enabled.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select></label>
        <label>{text.model}<input aria-label={text.model} required maxLength={240} value={model} disabled={frozen} onChange={(event) => setModel(event.target.value)} /></label>
      </div>
      <label className="background-job-privacy"><input type="checkbox" checked={cloudAllowed} disabled={frozen} onChange={(event) => setCloudAllowed(event.target.checked)} />{text.cloud}</label>
      <p className="background-job-note">{text.privacy}</p>
      <details open className="background-job-preview"><summary>{text.preview}</summary>
        <dl><dt>{text.provider}</dt><dd>{provider?.name ?? '—'} · {provider?.baseUrl ?? '—'}</dd><dt>{text.model}</dt><dd>{model || '—'}</dd><dt>{text.destination}</dt><dd>{cloudAllowed ? text.remote : text.local}</dd></dl>
        <strong>{text.instruction}</strong><pre>{instruction || '—'}</pre><strong>{text.material}</strong><pre>{material || '—'}</pre>
      </details>
      {submitError && <div role="alert">{submitError === 'uncertain' ? text.uncertain : submitError === 'rejected' ? text.rejected : text.submitFailed}</div>}
      <button type="submit" disabled={pending || (!submission.current && (!instruction.trim() || !provider || !model.trim()))}>{pending ? text.submitting : submitError && submitError !== 'rejected' ? text.retry : text.run}</button>
    </form>
    <p className="background-job-note">{text.lifecycle}</p><p className="background-job-note">{text.cancelNotice}</p>
    {loadingFailed && <p role="alert">{text.loadFailed}</p>}
    {actionError && <p role="alert">{actionError === 'cancel' ? text.cancelFailed : text.loadFailed}</p>}
    <button type="button" className="secondary" onClick={() => void refresh()}>{text.refresh}</button>
    {jobs.length === 0 ? <p>{text.empty}</p> : <div className="background-job-list">{jobs.map((job) => <article className="panel" key={job.id} data-job-id={job.id} aria-label={job.instruction}>
      <div className="panel-heading"><h2>{job.instruction}</h2><span role="status" data-job-status={job.status}>{statuses[locale][job.status]}</span></div>
      <p>{job.binding.provider.name} · {job.binding.model}</p><small>{text.created} {new Date(job.createdAt).toLocaleString(locale)} · {text.owner}</small>
      <code className="background-job-id">{job.id}</code>
      {job.completionReason && <p data-completion-reason={job.completionReason}>{job.completionReason}</p>}
      <div className="background-job-actions">{cancellable.has(job.status) && <button type="button" className="secondary" disabled={cancelling !== null} onClick={() => void cancel(job.id)}>{text.cancel}</button>}
      <button type="button" className="secondary" onClick={() => void view(job.id)}>{text.view}</button></div>
    </article>)}</div>}
    {shown && <section className="panel background-job-result" aria-label={text.result} data-opened-job-id={shown.id} ref={resultSection} tabIndex={-1}>
      <div className="panel-heading"><h2>{text.result}</h2><button type="button" className="secondary" onClick={() => { readSequence.current++; setOpened(null); }}>{text.close}</button></div>
      <p>{shown.instruction} · {statuses[locale][shown.status]}</p><pre>{shown.result ?? text.missing}</pre>
    </section>}
  </section>;
};
