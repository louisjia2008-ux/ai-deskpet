import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ChatModelSelection, ProviderConfig } from '../../shared';
import { API_VERSION, MAX_IPC_BYTES } from '../../shared';
import type { DelegationBatch, DelegationDraft, DelegationResult, DelegationSubmit } from '../../shared/delegations';
import type { Requirement } from '../../shared/delegation-checks';
import { BoundModelSelect } from './ModelSelect';
import { providerSetupText } from '../../shared/provider-setup-i18n';
import './background-jobs.css';
import './delegations.css';

const copy = {
  en: {
    title: 'Text delegations', draft: 'Delegation draft', goal: 'Delegation goal', child: 'Child', cloudShort: 'cloud allowed', localShort: 'local only', instruction: 'instruction', material: 'selected material (paste text)',
    provider: 'provider', model: 'model', choose: 'Choose an existing provider', add: 'Add child', remove: 'Remove child',
    cloud: 'Allow this child instruction and material to be sent to the selected provider, including remote execution',
    privacy: 'Local only by default. Pasted text is user-provided input; no source proof is invented. No parent chat, memory, sibling output or tool permissions are added.',
    exact: 'Exact full-text requirement', expected: 'expected full text', words: 'English word-count requirement', min: 'minimum English words', max: 'maximum English words', other: 'other requirements (unchecked)',
    policy: 'Exact text: normalize Unicode to NFC and CRLF to LF; no trimming or case folding. English words: ASCII letter sequences, with internal apostrophes, curly apostrophes or hyphens counted within one word. These checks cover the entire saved result text, including code or markup; digits and other characters separate words.',
    frozenDeadline: 'Frozen deadline', requests: 'Child requests', deadline: 'Deadline (minutes)',
    usageNote: 'Each child generates at most once. Tokens are recorded when reported by the provider; missing usage stays unknown.',
    preview: 'Delegation submission preview', submit: 'Submit delegation', saving: 'Saving delegation…', retry: 'Recover this submission', closeDraft: 'Close draft',
    missing: 'Choose a provider for every child. A child can follow that service’s default model or use a selected model.',
    follow: 'Follow service default',
    rejected: 'This draft was rejected before acceptance. Review the fields, current goal, binding, privacy, deadline and selected children.',
    uncertain: 'Submission unconfirmed / result unknown. Recover the identical submission before creating another; its operation ID, inputs and deadline stay fixed.',
    replacementRequired: 'This chat already has a current delegation. Use Replace goal on that batch to preserve it as history and open a new draft.',
    empty: 'No submitted delegations in this chat.', refresh: 'Refresh delegations', loadFailed: 'The authoritative delegation state could not be read. Retry after storage recovers.',
    current: 'Current goal', historical: 'Historical goal', execution: 'Execution status', checks: 'Requirement checks', fact: 'Fact verification', unverified: 'Unverified',
    exactName: 'Exact full text', wordName: 'English word range', otherName: 'Other requirement', noChecks: 'No mechanical requirements selected',
    passed: 'Passed', failed: 'Failed', unchecked: 'Unchecked', inspectLimit: 'Mechanical checks do not establish overall answer quality or factual accuracy.',
    view: 'View result', result: 'Child result', closeResult: 'Close result', noResult: 'No committed text result is available.', originalReason: 'Original finish reason', completion: 'Completion reason', actualWords: 'Actual English words',
    cancelChild: 'Cancel child', cancelBatch: 'Cancel batch', replacement: 'Replacement goal', replace: 'Replace goal', recoverReplacement: 'Recover goal replacement',
    replaceNote: 'Replacing preserves the old goal and saved results as history, cancels unfinished work and opens a new draft. The new draft does not run automatically.',
    actionFailed: 'This action was not confirmed. Read the saved state before assuming cancellation or replacement succeeded.',
    cancelNote: 'Cancellation prevents new local work and asks the client to abort the target request. Requests already sent may still run remotely. Completed results remain saved.',
    resultNote: 'Each result stays with its own child. Text, HTML, code and commands are displayed as text, never executed or automatically added to chat or memory.',
    recordedTokens: 'Reported tokens', unknownUsage: 'Children with unknown usage', unknown: 'Unknown',
    active: 'Active', completed: 'Execution ended', partial: 'Mixed outcomes', cancelled: 'Cancelled locally', expired: 'Expired', interrupted: 'Interrupted / result unknown', historicalStatus: 'Historical',
    queued: 'Queued', dispatching: 'Dispatch intent saved', running: 'Running', succeeded: 'Execution ended', failedExecution: 'Execution failed', blocked: 'Blocked',
  },
  'zh-CN': {
    title: '文本委派', draft: '委派草稿', goal: '委派目标', child: '子任务', cloudShort: '可发云端', localShort: '仅本机', instruction: '任务指令', material: '选入材料（粘贴文本）',
    provider: '模型服务', model: '模型', choose: '请选择已有模型服务', add: '添加子任务', remove: '移除子任务',
    cloud: '允许将此子任务的指令和材料发送至所选模型服务，包括远端执行',
    privacy: '默认仅限本机。粘贴内容如实标为用户提供，不虚构来源证明；不会添加父聊天、记忆、兄弟结果或工具权限。',
    exact: '精确全文要求', expected: '预期完整文本', words: '英文词数要求', min: '最少英文词数', max: '最多英文词数', other: '其他要求（未检查）',
    policy: '精确文本：Unicode 规范化为 NFC、CRLF 转为 LF，不裁剪空白，不忽略大小写。英文词：ASCII 字母序列，内部直撇号、弯撇号或连字符仍计为一个词。检查范围为最终保存正文全文，包括代码或标记中的文本；数字及其他字符分隔英文词。',
    frozenDeadline: '冻结截止时间', requests: 'Child 请求数', deadline: '截止时间（分钟后）',
    usageNote: '每个子任务最多生成一次。Token 用量按模型服务报告记录，未返回的用量保持未知。',
    preview: '委派提交预览', submit: '提交委派', saving: '正在保存委派…', retry: '恢复本次提交', closeDraft: '关闭草稿',
    missing: '请为每个子任务选择服务。可以跟随该服务的默认模型，也可以指定模型。',
    follow: '跟随服务默认模型',
    rejected: '草稿在接收前被拒绝。请核对字段、当前目标、绑定、隐私、截止时间和所选子任务。',
    uncertain: '提交未确认／结果未知。请恢复完全相同的提交，操作 ID、输入和截止时间保持不变，不先创建另一组任务。',
    replacementRequired: '此聊天已有当前委派。请使用该批次的“替换目标”，将旧目标保留为历史并打开新草稿。',
    empty: '此聊天暂无已提交的委派。', refresh: '刷新委派', loadFailed: '无法读取权威委派状态。请在存储恢复后重试。',
    current: '当前目标', historical: '历史目标', execution: '执行状态', checks: '要求检查', fact: '事实核验', unverified: '未核验',
    exactName: '精确全文', wordName: '英文词数区间', otherName: '其他要求', noChecks: '未选择机械要求检查',
    passed: '通过', failed: '未通过', unchecked: '未检查', inspectLimit: '机械规则检查不代表整体回答质量或事实正确。',
    view: '查看结果', result: 'Child 结果', closeResult: '关闭结果', noResult: '没有已提交的正文结果。', originalReason: '原始完成原因', completion: '结束原因', actualWords: '实际英文词数',
    cancelChild: '取消子任务', cancelBatch: '取消批次', replacement: '替换目标', replace: '替换目标', recoverReplacement: '恢复目标替换',
    replaceNote: '替换会将旧目标和已保存结果保留为历史，取消未完成工作并打开新草稿；新草稿不会自动运行。',
    actionFailed: '此操作尚未确认。请读取已保存状态，不能据此认为取消或替换已经生效。',
    cancelNote: '取消阻止新的本地动作，并请求客户端中止目标请求；已经发送的请求仍可能在远端执行。已完成结果继续保留。',
    resultNote: '结果分别保存在各自子任务中。文本、HTML、代码和命令均作为正文展示，不执行，也不会自动进入聊天或记忆。',
    recordedTokens: '已实报 Token', unknownUsage: '用量未知的子任务', unknown: '未知',
    active: '进行中', completed: '执行结束', partial: '包含不同结果', cancelled: '已在本地取消', expired: '已到期', interrupted: '已中断／结果未知', historicalStatus: '历史',
    queued: '排队中', dispatching: '正在发出', running: '运行中', succeeded: '执行结束', failedExecution: '执行失败', blocked: '受阻',
  },
};
type Copy = typeof copy.en;
interface ChildEditor {
  id: string; instruction: string; material: string; providerId: string; model: string; cloud: boolean;
  exact: boolean; expected: string; exactId: string; words: boolean; min: number; max: number; wordsId: string; other: string; otherId: string;
}
const newChild = (instruction = '', selection?: ChatModelSelection): ChildEditor => ({ id: crypto.randomUUID(), instruction, material: '',
  providerId: selection?.providerId ?? '', model: selection?.model ?? '', cloud: false,
  exact: false, expected: '', exactId: crypto.randomUUID(), words: false, min: 200, max: 220, wordsId: crypto.randomUUID(), other: '', otherId: crypto.randomUUID() });
const rulesFor = (child: ChildEditor): Requirement[] => [
  ...(child.exact ? [{ id: child.exactId, kind: 'exact-text' as const, expected: child.expected }] : []),
  ...(child.words ? [{ id: child.wordsId, kind: 'english-word-count' as const, min: child.min, max: child.max }] : []),
  ...(child.other.trim() ? [{ id: child.otherId, kind: 'unimplemented' as const, description: child.other.trim() }] : []),
];
const definiteRejection = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : '';
  return /(?:delegation\.(?:operationConflict|invalidDraft|budgetExceeded|replaceRequired|staleIntent|deadlineExceeded|unavailable)|provider\.(?:unavailable|bindingMismatch|contextBudgetExceeded|invalidRequestBudget)|job\.(?:privacyBlocked|maintenance|capacityExceeded))(?:\b|$)/u.test(message);
};
const checkLabel = (kind: Requirement['kind'], text: Copy): string => kind === 'exact-text' ? text.exactName : kind === 'english-word-count' ? text.wordName : text.otherName;
const checkStatus = (status: 'passed' | 'failed' | 'unchecked', text: Copy): string => text[status];
const canCancel = (status: string): boolean => ['queued', 'dispatching', 'running'].includes(status);
const executionLabel = (status: string, text: Copy): string => status === 'failed' ? text.failedExecution : text[status as keyof Copy] ?? status;
const reportedTokens = (batch: DelegationBatch): number | null => {
  const known = batch.children.flatMap((child) => child.reservation.reportedTokens === null ? [] : [child.reservation.reportedTokens]);
  const total = known.reduce((sum, value) => sum + value, 0);
  return known.length > 0 && Number.isSafeInteger(total) ? total : null;
};

const DelegationForm = ({ draft, providers, text, locale, onSaved, onClose }: { draft: DelegationDraft; providers: ProviderConfig[]; text: Copy; locale: 'en' | 'zh-CN'; onSaved(batch: DelegationBatch): void; onClose(): void }): JSX.Element => {
  const setupText = providerSetupText(locale);
  const [goal, setGoal] = useState(draft.goal);
  const [children, setChildren] = useState<ChildEditor[]>(() => [newChild(draft.goal, draft.childModelSelections?.[0])]);
  const [minutes, setMinutes] = useState(10);
  const [pending, setPending] = useState(false); const [error, setError] = useState<'rejected' | 'unknown' | null>(null);
  const attempt = useRef<DelegationSubmit | null>(null); const submitting = useRef(false); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const enabled = providers.filter((provider) => provider.enabled);
  const frozen = pending || error === 'unknown';
  const update = (id: string, change: Partial<ChildEditor>): void => setChildren((current) => current.map((child) => child.id === id ? { ...child, ...change } : child));
  const valid = goal.trim().length > 0 && children.length >= 1 && children.length <= 3
    && Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440 && children.every((child) => child.instruction.trim().length > 0 && child.instruction.trim().length <= 16000 && child.material.length <= 16000
      && enabled.some((provider) => provider.id === child.providerId)
      && (!child.exact || child.expected.length > 0) && (!child.words || (Number.isInteger(child.min) && Number.isInteger(child.max) && child.min >= 0 && child.max >= child.min && child.max <= 50000)));
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); if (submitting.current || (!attempt.current && !valid)) return;
    const input: DelegationSubmit = attempt.current ?? { operationId: crypto.randomUUID(), sessionId: draft.sessionId, intentVersion: draft.intentVersion,
      goal: goal.trim(), deadlineAt: new Date(Date.now() + minutes * 60_000).toISOString(),
      children: children.map((child) => ({ instruction: child.instruction.trim(), material: child.material, privacy: child.cloud ? 'cloud-allowed' : 'local-only',
        providerId: child.providerId, model: child.model.trim() || null,
        ...(child.model.trim() ? {} : { reviewedDefaultModel: enabled.find(provider => provider.id === child.providerId)?.model }),
        requirements: rulesFor(child) })) };
    // Match the actual versioned IPC envelope's UTF-8 bytes before any send.
    // A local size rejection is definite: there is no accepted operation to recover.
    if (new globalThis.Blob([JSON.stringify({ version: API_VERSION, payload: input })]).size > MAX_IPC_BYTES) {
      attempt.current = null; setError('rejected'); return;
    }
    attempt.current = input; submitting.current = true; setPending(true); setError(null);
    try { const saved = await window.deskpet.delegations.submit(input); attempt.current = null; if (mounted.current) onSaved(saved); }
    catch (cause) { const rejected = definiteRejection(cause); if (rejected) attempt.current = null; if (mounted.current) setError(rejected ? 'rejected' : 'unknown'); }
    finally { submitting.current = false; if (mounted.current) setPending(false); }
  };
  return <form className="panel delegation-draft" aria-label={text.draft} onSubmit={(event) => void submit(event)}>
    <div className="panel-heading"><h3>{text.draft}</h3><button type="button" className="secondary" disabled={frozen} onClick={onClose}>{text.closeDraft}</button></div>
    <label>{text.goal}<textarea aria-label={text.goal} maxLength={4000} required value={goal} disabled={frozen} onChange={(event) => setGoal(event.target.value)} /></label>
    <p className="background-job-note">{text.privacy}</p>
    {children.map((child, index) => { const prefix = `${text.child} ${index + 1}`; const provider = enabled.find((item) => item.id === child.providerId); return <fieldset key={child.id} className="delegation-child-editor" aria-label={prefix} disabled={frozen}>
      <legend>{prefix}</legend>
      <label>{prefix} {text.instruction}<textarea aria-label={`${prefix} ${text.instruction}`} required maxLength={16_000} value={child.instruction} onChange={(event) => update(child.id, { instruction: event.target.value })} /></label>
      <label>{prefix} {text.material}<textarea aria-label={`${prefix} ${text.material}`} maxLength={16_000} value={child.material} onChange={(event) => update(child.id, { material: event.target.value })} /></label>
      <div className="background-job-binding"><label>{prefix} {text.provider}<select aria-label={`${prefix} ${text.provider}`} value={child.providerId} required onChange={(event) => update(child.id, { providerId: event.target.value, model: '' })}>
        <option value="">{text.choose}</option>{enabled.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
      </select></label><BoundModelSelect provider={provider} value={child.model} label={`${prefix} ${text.model}`} locale={locale} disabled={frozen} onChange={(value) => update(child.id, { model: value })}
        followDefault={provider ? `${text.follow} (${provider.model})` : undefined} /></div>
      <small>{setupText('provider.childModelIndependent')}</small>
      <label className="delegation-checkbox"><input type="checkbox" checked={child.cloud} onChange={(event) => update(child.id, { cloud: event.target.checked })} />{text.cloud}</label>
      <div className="delegation-requirements">
        <label className="delegation-checkbox"><input type="checkbox" aria-label={`${prefix} ${text.exact}`} checked={child.exact} onChange={(event) => update(child.id, { exact: event.target.checked })} />{text.exact}</label>
        {child.exact && <label>{prefix} {text.expected}<textarea aria-label={`${prefix} ${text.expected}`} maxLength={4000} value={child.expected} onChange={(event) => update(child.id, { expected: event.target.value })} /></label>}
        <label className="delegation-checkbox"><input type="checkbox" aria-label={`${prefix} ${text.words}`} checked={child.words} onChange={(event) => update(child.id, { words: event.target.checked })} />{text.words}</label>
        {child.words && <div className="background-job-binding"><label>{prefix} {text.min}<input type="number" aria-label={`${prefix} ${text.min}`} min={0} max={50000} value={child.min} onChange={(event) => update(child.id, { min: Number(event.target.value) })} /></label><label>{prefix} {text.max}<input type="number" aria-label={`${prefix} ${text.max}`} min={child.min} max={50000} value={child.max} onChange={(event) => update(child.id, { max: Number(event.target.value) })} /></label></div>}
        <label>{prefix} {text.other}<textarea aria-label={`${prefix} ${text.other}`} maxLength={2000} value={child.other} onChange={(event) => update(child.id, { other: event.target.value })} /></label>
      </div>
      <small>{provider ? `${provider.name} · ${provider.baseUrl} · ${child.model || provider.model}` : text.choose}</small>
      {children.length > 1 && <button type="button" className="secondary" onClick={() => setChildren((current) => current.filter((item) => item.id !== child.id))}>{text.remove} {index + 1}</button>}
    </fieldset>; })}
    <button type="button" className="secondary" disabled={frozen || children.length >= 3} onClick={() => setChildren((current) => current.length < 3 ? [...current, newChild('', draft.childModelSelections?.[current.length])] : current)}>{text.add}</button>
    <div className="delegation-run-fields"><label>{text.deadline}<input type="number" aria-label={text.deadline} min={1} max={1440} required value={minutes} disabled={frozen} onChange={(event) => setMinutes(Number(event.target.value))} /></label></div>
    <p className="background-job-note">{text.usageNote}</p><p className="background-job-note">{text.policy}</p>
    <details open className="background-job-preview"><summary>{text.preview}</summary><strong>{text.goal}</strong><pre>{goal.trim() || '—'}</pre><p>{text.requests}: {children.length}; {text.deadline}: {minutes}</p>{attempt.current && <p>{text.frozenDeadline}: {attempt.current.deadlineAt}</p>}
      {children.map((child, index) => { const provider = enabled.find((item) => item.id === child.providerId); return <section key={child.id} aria-label={`${text.child} ${index + 1} preview`}>
        <h4>{text.child} {index + 1}</h4><p>{provider?.name ?? text.choose} · {provider?.baseUrl ?? '—'} · {child.model.trim() || provider?.model || '—'} · {child.cloud ? text.cloudShort : text.localShort}</p>
        <strong>{text.instruction}</strong><pre>{child.instruction.trim() || '—'}</pre><strong>{text.material}</strong><pre>{child.material || '—'}</pre>
        {rulesFor(child).map((rule) => <div key={rule.id}><strong>{checkLabel(rule.kind, text)}</strong><pre>{rule.kind === 'exact-text' ? rule.expected : rule.kind === 'english-word-count' ? `${rule.min}–${rule.max}` : rule.description}</pre></div>)}
      </section>; })}
    </details>
    {draft.currentBatchId && <p role="note">{text.replacementRequired}</p>}
    {!valid && <p>{text.missing}</p>}{error && <p role="alert">{error === 'rejected' ? text.rejected : text.uncertain}</p>}
    <button type="submit" disabled={pending || (!attempt.current && (!valid || draft.currentBatchId !== null))}>{pending ? text.saving : error === 'unknown' ? text.retry : text.submit}</button>
  </form>;
};

export const Delegations = ({ sessionId, providers, locale, draft, onDraftChange, focusBatchId = null, focusRevision = 0 }: { sessionId: string; providers: ProviderConfig[]; locale: 'en' | 'zh-CN'; draft: DelegationDraft | null; onDraftChange(draft: DelegationDraft | null): void; focusBatchId?: string | null | undefined; focusRevision?: number | undefined }): JSX.Element => {
  const text = copy[locale];
  const [saved, setSaved] = useState<{ sessionId: string; batches: DelegationBatch[] }>({ sessionId, batches: [] });
  const [shown, setShown] = useState<{ sessionId: string; epoch: number; value: DelegationResult } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false); const [actionFailed, setActionFailed] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null); const actionBusy = useRef(false);
  const [replacementGoals, setReplacementGoals] = useState<Record<string, string>>({});
  const replacementAttempts = useRef(new Map<string, { operationId: string; goal: string }>());
  const scope = useRef(sessionId), scopeEpoch = useRef(0);
  if (scope.current !== sessionId) { scope.current = sessionId; scopeEpoch.current++; }
  const batchNodes = useRef(new Map<string, HTMLElement>()); const focused = useRef<string | null>(null);
  const readSequence = useRef(0);
  const mounted = useRef(true);
  const refresh = useCallback(async (): Promise<void> => {
    if (!sessionId) return; const epoch = scopeEpoch.current;
    try { const batches = await window.deskpet.delegations.list(sessionId); if (mounted.current && scope.current === sessionId && scopeEpoch.current === epoch) { setSaved({ sessionId, batches }); setLoadFailed(false); } }
    catch { if (mounted.current && scope.current === sessionId && scopeEpoch.current === epoch) setLoadFailed(true); }
  }, [sessionId]);
  useEffect(() => {
    mounted.current = true; actionBusy.current = false; setPendingAction(null); setActionFailed(false); void refresh();
    const stop = window.deskpet.delegations.onChanged(() => void refresh()); const interval = window.setInterval(() => void refresh(), 1500);
    return () => { mounted.current = false; stop(); window.clearInterval(interval); };
  }, [refresh]);
  const batches = useMemo(() => saved.sessionId === sessionId ? saved.batches : [], [saved, sessionId]);
  useEffect(() => {
    if (!focusBatchId) { focused.current = null; return; }
    const key = `${sessionId}:${focusBatchId}:${scopeEpoch.current}:${focusRevision}`;
    const node = batchNodes.current.get(focusBatchId);
    if (node && batches.some((batch) => batch.id === focusBatchId && batch.sessionId === sessionId) && focused.current !== key) {
      focused.current = key; node.focus({ preventScroll: true }); node.scrollIntoView?.({ block: 'start' });
    }
  }, [focusBatchId, focusRevision, sessionId, batches]);
  const action = async (id: string, operation: () => Promise<void>): Promise<void> => {
    const owner = sessionId, epoch = scopeEpoch.current;
    if (actionBusy.current) return; actionBusy.current = true; setPendingAction(id); setActionFailed(false);
    try { await operation(); await refresh(); }
    catch { if (mounted.current && scope.current === owner && scopeEpoch.current === epoch) setActionFailed(true); }
    finally { if (scope.current === owner && scopeEpoch.current === epoch) { actionBusy.current = false; if (mounted.current) setPendingAction(null); } }
  };
  const view = (batchId: string, childId: string): void => { void action(childId, async () => {
    const epoch = scopeEpoch.current, sequence = ++readSequence.current;
    const child = batches.find((batch) => batch.id === batchId && batch.sessionId === sessionId)?.children.find((item) => item.id === childId);
    if (!child) throw new Error('delegation.unavailable');
    if (mounted.current && scope.current === sessionId) setShown(null);
    const value = await window.deskpet.delegations.getResult({ batchId, childId });
    if (value.batchId !== batchId || value.childId !== childId || value.sessionId !== child.sessionId) throw new Error('delegation.unavailable');
    if (mounted.current && scope.current === sessionId && scopeEpoch.current === epoch && readSequence.current === sequence) setShown({ sessionId, epoch, value });
  }); };
  const replace = (batch: DelegationBatch): void => { void action(batch.id, async () => {
    const epoch = scopeEpoch.current;
    const attempt = replacementAttempts.current.get(batch.id) ?? { operationId: crypto.randomUUID(), goal: (replacementGoals[batch.id] ?? batch.goal).trim() };
    if (!attempt.goal) return; replacementAttempts.current.set(batch.id, attempt);
    try {
      const next = await window.deskpet.delegations.replace({ batchId: batch.id, ...attempt }); replacementAttempts.current.delete(batch.id);
      if (mounted.current && scope.current === sessionId && scopeEpoch.current === epoch) { setShown(null); onDraftChange(next); }
    } catch (error) { if (definiteRejection(error)) replacementAttempts.current.delete(batch.id); throw error; }
  }); };
  const visibleResult = shown?.sessionId === sessionId && shown.epoch === scopeEpoch.current ? shown.value : null;
  const resultHistorical = visibleResult && (visibleResult.historical || Boolean(batches.find((batch) => batch.id === visibleResult.batchId)?.historicalAt));
  return <section className="delegations" aria-label={text.title}>
    <h2>{text.title}</h2><p className="background-job-note">{text.resultNote}</p>
    {draft?.sessionId === sessionId && <DelegationForm locale={locale} key={`${draft.sessionId}:${draft.intentVersion}:${draft.goal}`} draft={draft} providers={providers} text={text} onClose={() => onDraftChange(null)} onSaved={(batch) => { setSaved((current) => ({ sessionId, batches: [batch, ...(current.sessionId === sessionId ? current.batches.filter((item) => item.id !== batch.id) : [])] })); onDraftChange(null); void refresh(); }} />}
    {loadFailed && <p role="alert">{text.loadFailed}</p>}{actionFailed && <p role="alert">{text.actionFailed}</p>}
    <button type="button" className="secondary" onClick={() => void refresh()}>{text.refresh}</button>
    {batches.length === 0 ? <p>{text.empty}</p> : <div className="delegation-batches">{batches.map((batch) => <article className="panel delegation-batch" key={batch.id} data-batch-id={batch.id} aria-label={batch.goal} data-attention-target={batch.id === focusBatchId ? 'true' : undefined} tabIndex={-1} ref={(node) => { if (node) batchNodes.current.set(batch.id, node); else batchNodes.current.delete(batch.id); }}>
      <div className="panel-heading"><h3>{batch.goal}</h3><span data-delegation-status={batch.status}>{batch.historicalAt ? text.historical : text.current} · {batch.status === 'historical' ? text.historicalStatus : executionLabel(batch.status, text)}</span></div>
      <small>{batch.id} · v{batch.intentVersion} · {new Date(batch.deadlineAt).toLocaleString(locale)}</small>
      <dl className="delegation-usage-summary"><dt>{text.requests}</dt><dd>{batch.children.length}</dd><dt>{text.recordedTokens}</dt><dd>{reportedTokens(batch) ?? text.unknown}</dd><dt>{text.unknownUsage}</dt><dd>{batch.children.filter((child) => child.reservation.reportedTokens === null).length}</dd></dl><p className="background-job-note">{text.usageNote}</p>
      <div className="delegation-children">{batch.children.map((child) => <article key={child.id} className="delegation-child-card" data-child-id={child.id} data-job-id={child.jobId} aria-label={child.instruction}>
        <h4>{child.instruction}</h4><p>{child.providerName} · {child.model}</p>
        <p>{text.execution}: <strong data-execution-status={child.status}>{executionLabel(child.status, text)}</strong></p>
        <p>{text.recordedTokens}: {child.reservation.reportedTokens ?? text.unknown}</p>
        {child.completionReason && <p data-completion-reason={child.completionReason}>{text.completion}: {child.completionReason}</p>}
        {child.finishReason && <p>{text.originalReason}: {child.finishReason}</p>}
        <div className="delegation-check-summary"><strong>{text.checks}</strong>{child.checks.length === 0 ? <p>{text.noChecks}</p> : <ul>{child.checks.map((check, index) => <li key={check.id} data-requirement-status={check.status}>{checkLabel(check.kind, text)} {index + 1}: {checkStatus(check.status, text)}</li>)}</ul>}</div>
        <p>{text.fact}: <strong data-fact-verification="unverified">{text.unverified}</strong></p><small>{text.inspectLimit}</small>
        <div className="background-job-actions"><button type="button" className="secondary" disabled={pendingAction !== null} onClick={() => view(batch.id, child.id)}>{text.view}</button>
          {canCancel(child.status) && <button type="button" className="secondary" disabled={pendingAction !== null} onClick={() => void action(child.id, async () => { await window.deskpet.delegations.cancelChild({ batchId: batch.id, childId: child.id }); })}>{text.cancelChild}</button>}</div>
      </article>)}</div>
      {!batch.historicalAt && <div className="delegation-parent-controls">
        {batch.children.some((child) => canCancel(child.status)) && <button type="button" className="secondary" disabled={pendingAction !== null} onClick={() => void action(batch.id, async () => { await window.deskpet.delegations.cancelBatch(batch.id); })}>{text.cancelBatch}</button>}
        <label>{text.replacement}<input aria-label={text.replacement} maxLength={4000} value={replacementGoals[batch.id] ?? batch.goal} disabled={pendingAction !== null || replacementAttempts.current.has(batch.id)} onChange={(event) => setReplacementGoals((current) => ({ ...current, [batch.id]: event.target.value }))} /></label>
        <button type="button" className="secondary" disabled={pendingAction !== null || !(replacementGoals[batch.id] ?? batch.goal).trim()} onClick={() => replace(batch)}>{replacementAttempts.current.has(batch.id) ? text.recoverReplacement : text.replace}</button>
        <p className="background-job-note">{text.replaceNote}</p>
      </div>}
    </article>)}</div>}
    <p className="background-job-note">{text.cancelNote}</p>
    {visibleResult && <section className="panel background-job-result delegation-result" aria-label={text.result}>
      <div className="panel-heading"><h3>{text.result}</h3><button type="button" className="secondary" onClick={() => setShown(null)}>{text.closeResult}</button></div>
      <p data-result-owner data-result-child-id={visibleResult.childId}>{batches.find((batch) => batch.id === visibleResult.batchId)?.children.find((child) => child.id === visibleResult.childId)?.instruction ?? visibleResult.childId}<br /><small>{visibleResult.batchId} / {visibleResult.childId}</small></p>
      <p>{resultHistorical ? text.historical : text.current} · {text.execution}: {executionLabel(visibleResult.status, text)}</p>
      {visibleResult.completionReason && <p>{text.completion}: {visibleResult.completionReason}</p>}{visibleResult.finishReason && <p>{text.originalReason}: {visibleResult.finishReason}</p>}
      <pre data-result-body>{visibleResult.result ?? text.noResult}</pre>
      <ul>{visibleResult.checks.map((check, index) => <li key={check.id}>{checkLabel(check.kind, text)} {index + 1}: {checkStatus(check.status, text)}{check.actualWordCount !== undefined ? ` · ${text.actualWords}: ${check.actualWordCount}` : ''}</li>)}</ul>
      <p>{text.fact}: <strong data-fact-verification="unverified">{text.unverified}</strong></p><p>{text.inspectLimit}</p>
    </section>}
  </section>;
};
