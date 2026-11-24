import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { API_VERSION, MAX_IPC_BYTES } from '../../shared';
import type { ProviderConfig, ResolvedLocale } from '../../shared';
import { consolidationCandidateSchema } from '../../shared/consolidation';
import type { ConsolidationApplyInput, ConsolidationBatch, ConsolidationEditInput, ConsolidationPreviewInput, ConsolidationSource } from '../../shared/consolidation';
import './memory-consolidation.css';

const copy = {
  en: {
    title: 'Manual memory consolidation', intro: 'Select existing, confirmed memories to produce one reviewable summary candidate. Generation grants no new evidence or tool permissions. Nothing is used in chat until you explicitly confirm the reviewed version and choose to enable it.',
    sourceTitle: 'Choose current sources', provider: 'Consolidation provider', model: 'Consolidation model', chooseProvider: 'Choose an existing provider',
    noSession: 'Open a current conversation before selecting its available memories.', noSources: 'No currently eligible memories are available. Unconfirmed, expired, deleted or unknown-source entries cannot be selected here.',
    select: 'Select source', local: 'Local only', cloud: 'Cloud allowed', scope: 'Scope', revision: 'Semantic revision', preview: 'Review selected sources',
    previewTitle: 'Consolidation material and binding', frozen: 'These source snapshots and this binding are frozen for this batch. The host checks their current versions and permissions again before sending, accepting a candidate and applying it.',
    input: 'Estimated complete input tokens', limit: 'Maximum input tokens', output: 'Reserved output tokens', destination: 'Destination',
    generate: 'Generate candidate once', once: 'One no-tool E-P2 job, one generation attempt, no automatic retry. Leaving this page does not cancel it. Requests that may have been sent are not regenerated after restart.',
    empty: 'No consolidation batches in this conversation.', batches: 'Saved batches', review: 'Review batch', reviewTitle: 'Consolidation candidate review',
    version: 'Candidate version', candidateJson: 'Candidate JSON', editorNote: 'Edit this structured candidate while comparing every claim with the original sources. sourceIds are claims of support, not semantic proof. Editing cannot authorize a new memory fact.',
    save: 'Save candidate edit', dirty: 'Edits have not been saved. Save them and review the resulting version before confirming.',
    reviewed: 'I compared this version with every source, including conditions and conflicts', enable: 'Use this summary for eligible requests',
    enableNote: 'Enabling is an explicit representation choice, not proof of accuracy or token savings. The host uses a summary only when the selected coverage, current dependencies and request budget allow it; otherwise current valid originals remain available.',
    confirm: 'Confirm reviewed version', disable: 'Disable summary', cancel: 'Cancel batch', active: 'Enabled', inactive: 'Not enabled',
    covered: 'Proposed covered memories', uncovered: 'Uncovered memories', conflicts: 'Conflicts / uncertainty', none: 'None reported by this candidate',
    noCandidate: 'No applicable candidate is saved. A failed, truncated, invalid or interrupted generation does not produce an automatically repaired candidate.',
    noCandidateReason: 'Current reason', sources: 'Frozen source material', fullCoverage: 'This candidate does not declare complete, conflict-free coverage. Confirmation can preserve the review, while normal requests use current originals.',
    raw: 'Generation and commit details', rawResponse: 'Original saved response', receipts: 'Persistent receipts', observations: 'Request observations',
    refresh: 'Refresh saved state', newSelection: 'Start another selection', close: 'Close review', busy: 'Saving…',
    rejected: 'The host rejected this operation. Read the current sources and saved version before trying a changed operation.',
    unknown: 'Operation unconfirmed / waiting for authoritative storage recovery. Recover this exact operation before doing another mutation; no new generation or application is assumed.',
    recover: 'Recover this operation', loadFailed: 'The authoritative source or batch state could not be read. Retry after storage recovers.',
    openFailed: 'The selected batch could not be opened in this conversation. Refresh saved state and review it again.',
    invalidJson: 'The candidate must match the displayed structured format. No edit was submitted.', tooLarge: 'This IPC submission is too large. Reduce the candidate before submitting.',
    warning: 'Disabling only changes representation selection. Revoking source use, deleting a memory and deleting original chat text are separate operations. Source correction, deletion or relevant permission withdrawal invalidates dependent summaries.',
    status: { draft: 'Source preview', generating: 'Generating', review: 'Awaiting review', applied: 'Review confirmed', disabled: 'Disabled', invalid: 'Invalidated', failed: 'Generation failed', cancelled: 'Cancelled locally' },
  },
  'zh-CN': {
    title: '手动记忆整理', intro: '明确选择当前已确认的记忆，生成一份可审阅的摘要候选。整理不新增事实证据，也不授予工具权限。只有明确确认审阅版本并选择启用后，才可能用于聊天。',
    sourceTitle: '选择当前有效来源', provider: '整理模型服务', model: '整理模型', chooseProvider: '请选择已有模型服务',
    noSession: '请先打开一个当前会话，再选择该会话可用的记忆。', noSources: '暂无当前可整理的记忆。未确认、过期、已删除或来源不明的条目不能通过这里选入。',
    select: '选择来源', local: '仅限本机', cloud: '允许云端', scope: '范围', revision: '语义版本', preview: '审阅所选来源',
    previewTitle: '整理材料与绑定', frozen: '本批次冻结这些来源快照和绑定。DeskPet 会在实际发送、接收候选及确认应用前，重新检查当前版本和权限。',
    input: '完整输入估算 token', limit: '输入 token 上限', output: '预留输出 token', destination: '目的地',
    generate: '仅生成一次候选', once: '复用一个无工具 E-P2 job，最多一次生成，不自动重试。离开本页不会取消；重启后不会重新生成可能已发送的请求。',
    empty: '此会话暂无整理批次。', batches: '已保存批次', review: '审阅批次', reviewTitle: '整理候选审阅',
    version: '候选版本', candidateJson: '候选 JSON', editorNote: '编辑结构化候选时，请逐项对照原文。sourceIds 是支持来源的声明，不代表语义已核验；编辑不授权新增记忆事实。',
    save: '保存候选编辑', dirty: '编辑尚未保存。请先保存，再审阅保存后的版本并确认。',
    reviewed: '我已逐项对照本版本与全部来源，包括限定条件及冲突', enable: '在允许的请求中使用此摘要',
    enableNote: '启用是明确的表示选择，不代表已证明准确性或 token 收益。DeskPet仅在覆盖范围、当前依赖和请求预算允许时使用摘要，否则保留当前有效原文路径。',
    confirm: '确认已审阅版本', disable: '停用摘要', cancel: '取消批次', active: '已启用', inactive: '未启用',
    covered: '拟覆盖记忆', uncovered: '未覆盖记忆', conflicts: '冲突／不确定性', none: '候选未报告',
    noCandidate: '没有已保存的可应用候选。生成失败、截断、结构无效或中断时，不会自动修复出候选。', noCandidateReason: '当前原因',
    sources: '冻结来源材料', fullCoverage: '候选没有声明完整且无冲突的覆盖。可以保存审阅，但正常请求仍使用当前原文。',
    raw: '生成与提交详情', rawResponse: '已保存的原始响应', receipts: '持久回执', observations: '请求观察',
    refresh: '刷新权威状态', newSelection: '重新选择来源', close: '关闭审阅', busy: '正在保存…',
    rejected: 'DeskPet拒绝了本次操作。请读取当前来源和保存版本，再提交新的变更。',
    unknown: '操作尚未确认／等待权威存储恢复。请先恢复完全相同的操作，不推测新生成或应用已经成功。',
    recover: '恢复本次操作', loadFailed: '无法读取权威来源或批次状态，请在存储恢复后重试。',
    openFailed: '无法在此会话打开所选批次，请刷新已保存状态后重新审阅。',
    invalidJson: '候选必须符合显示的结构化格式。本次没有提交编辑。', tooLarge: 'IPC 内容过大，请缩减候选后再提交。',
    warning: '停用只撤销表示选择；撤回来源使用权限、删除记忆与删除原始聊天正文是不同操作。来源纠正、删除或相关权限撤回，会使依赖摘要失效。',
    status: { draft: '来源预览', generating: '正在生成', review: '待审阅', applied: '已确认审阅', disabled: '已停用', invalid: '已失效', failed: '生成失败', cancelled: '已在本地取消' },
  },
};

type PendingAction =
  | { kind: 'preview'; payload: ConsolidationPreviewInput }
  | { kind: 'generate' | 'disable' | 'cancel'; payload: { id: string; operationId: string } }
  | { kind: 'edit'; payload: ConsolidationEditInput }
  | { kind: 'apply'; payload: ConsolidationApplyInput };
const json = (value: unknown): string => JSON.stringify(value, null, 2);
const canCancel = (batch: ConsolidationBatch): boolean => batch.status === 'draft' || batch.status === 'generating' || batch.status === 'review';
const definiteRejection = (cause: unknown): boolean => cause instanceof Error && !cause.message.includes('repository.commitUncertain')
  && /(?:consolidation\.[A-Za-z]+|provider\.(?:unavailable|bindingMismatch|contextBudgetExceeded|invalidRequestBudget)|job\.(?:privacyBlocked|inputInvalid|operationConflict|maintenance|capacityExceeded))(?:\b|$)/u.test(cause.message);

export const MemoryConsolidation = ({ providers, sessionId, locale, openBatchId = null }: { providers: ProviderConfig[]; sessionId: string | null; locale: ResolvedLocale; openBatchId?: string | null | undefined }): JSX.Element => {
  const text = copy[locale];
  const [sources, setSources] = useState<ConsolidationSource[]>([]); const [batches, setBatches] = useState<ConsolidationBatch[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]); const [providerId, setProviderId] = useState(''); const [model, setModel] = useState('');
  const [batch, setBatch] = useState<ConsolidationBatch | null>(null); const [editor, setEditor] = useState('');
  const [reviewed, setReviewed] = useState(false); const [enable, setEnable] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'rejected' | 'unknown' | 'loadFailed' | 'openFailed' | 'invalidJson' | 'tooLarge' | null>(null);
  const pending = useRef<PendingAction | null>(null); const acting = useRef(false); const mounted = useRef(true); const currentSession = useRef(sessionId); const readSequence = useRef(0);
  currentSession.current = sessionId;
  const reviewSection = useRef<HTMLElement | null>(null);
  const enabled = providers.filter((item) => item.enabled); const provider = enabled.find((item) => item.id === providerId);
  const savedCandidateJson = batch?.candidate ? json(batch.candidate) : '';
  const frozen = busy || pending.current !== null; const dirty = batch?.candidate !== null && batch !== null && editor !== savedCandidateJson;
  const hasCandidate = batch?.candidate !== null && batch !== null;
  const complete = batch?.candidate !== null && batch !== null && batch.candidate.uncoveredMemoryIds.length === 0 && batch.candidate.conflicts.length === 0
    && batch.sources.every((source) => batch.candidate!.coveredMemoryIds.includes(source.id));
  const refresh = useCallback(async (): Promise<void> => {
    const owner = sessionId; if (!owner) return; const reviewSequence = readSequence.current;
    try {
      const [available, saved] = await Promise.all([window.deskpet.consolidation.sources(owner), window.deskpet.consolidation.list(owner)]);
      if (!mounted.current || currentSession.current !== owner) return;
      setSources(available); setBatches(saved); setSelectedIds((ids) => ids.filter((id) => available.some((source) => source.id === id)));
      setBatch((shown) => readSequence.current !== reviewSequence ? shown : shown === null ? null : saved.find((item) => item.id === shown.id && item.sessionId === owner) ?? null);
      setError((current) => current === 'loadFailed' ? null : current);
    } catch { if (mounted.current && currentSession.current === owner) setError((current) => current === 'unknown' ? current : 'loadFailed'); }
  }, [sessionId]);
  useEffect(() => {
    mounted.current = true; setSources([]); setBatches([]); setSelectedIds([]); setBatch(null); setEditor(''); setReviewed(false); setEnable(false); setError(null); setBusy(false); pending.current = null; acting.current = false; readSequence.current += 1;
    void refresh(); const off = window.deskpet.consolidation.onChanged(() => void refresh());
    const interval = window.setInterval(() => void refresh(), 1500);
    return () => { mounted.current = false; off(); window.clearInterval(interval); };
  }, [refresh]);
  useEffect(() => { setEditor(savedCandidateJson); setReviewed(false); setEnable(false); }, [batch?.id, batch?.candidateVersion, batch?.invalidReason, savedCandidateJson]);
  const perform = async (action: PendingAction): Promise<void> => {
    if (acting.current) return; const owner = sessionId; if (!owner) return;
    if (new globalThis.Blob([JSON.stringify({ version: API_VERSION, payload: action.payload })]).size > MAX_IPC_BYTES) { setError('tooLarge'); return; }
    pending.current = action; acting.current = true; setBusy(true); setError(null);
    try {
      const api = window.deskpet.consolidation;
      const saved = action.kind === 'preview' ? await api.preview(action.payload)
        : action.kind === 'edit' ? await api.edit(action.payload)
          : action.kind === 'apply' ? await api.apply(action.payload)
            : action.kind === 'generate' ? await api.generate(action.payload)
              : action.kind === 'disable' ? await api.disable(action.payload) : await api.cancel(action.payload);
      if (mounted.current && currentSession.current === owner) { setBatch(saved); setBatches((items) => [saved, ...items.filter((item) => item.id !== saved.id)]); pending.current = null; void refresh(); }
    } catch (cause) {
      if (mounted.current && currentSession.current === owner) {
        const rejected = definiteRejection(cause); if (rejected) pending.current = null; setError(rejected ? 'rejected' : 'unknown');
      }
    } finally { if (currentSession.current === owner) { acting.current = false; if (mounted.current) setBusy(false); } }
  };
  const chooseBatch = useCallback(async (id: string): Promise<void> => {
    if (acting.current || pending.current !== null) return; const owner = sessionId; if (!owner) return; const sequence = ++readSequence.current;
    setBatch(null); setEditor(''); setReviewed(false); setEnable(false); setError(null);
    try {
      const saved = await window.deskpet.consolidation.get(id);
      if (saved.id !== id || saved.sessionId !== owner) throw new Error('consolidation.unavailable');
      if (mounted.current && currentSession.current === owner && readSequence.current === sequence) {
        // Publish the candidate and its editor text in the same commit. A
        // visible review must never briefly expose the previous/empty editor.
        setBatch(saved); setEditor(saved.candidate ? json(saved.candidate) : '');
      }
    }
    catch { if (mounted.current && currentSession.current === owner && readSequence.current === sequence) setError('openFailed'); }
  }, [sessionId]);
  const invalidateRead = useCallback((): void => { readSequence.current++; }, []);
  useEffect(() => {
    if (openBatchId) void chooseBatch(openBatchId);
    else { setBatch(null); setEditor(''); }
    return invalidateRead;
  }, [openBatchId, chooseBatch, invalidateRead]);
  const shownBatchId = batch?.id;
  useEffect(() => { if (shownBatchId) { reviewSection.current?.focus({ preventScroll: true }); reviewSection.current?.scrollIntoView?.({ block: 'start' }); } }, [shownBatchId]);
  const saveEdit = (): void => {
    if (!batch || !dirty || frozen) return;
    try {
      const candidate = consolidationCandidateSchema.parse(JSON.parse(editor) as unknown);
      void perform({ kind: 'edit', payload: { id: batch.id, expectedVersion: batch.candidateVersion, operationId: crypto.randomUUID(), candidate } });
    } catch { setError('invalidJson'); }
  };
  const selectedSources = sources.filter((source) => selectedIds.includes(source.id));
  return <section className="memory-consolidation" aria-label={text.title}>
    <header><h2>{text.title}</h2><p>{text.intro}</p></header>
    {error && <p className="error-banner" role="alert">{text[error]}</p>}
    {error === 'unknown' && <button type="button" disabled={busy} onClick={() => { if (pending.current) void perform(pending.current); }}>{text.recover}</button>}
    <button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}>{text.refresh}</button>
    {!sessionId ? <p>{text.noSession}</p> : <section className="panel consolidation-selection" aria-label={text.sourceTitle}>
      <h3>{text.sourceTitle}</h3>{sources.length === 0 && <p>{text.noSources}</p>}
      <div className="consolidation-sources">{sources.map((source) => <article className="consolidation-source" data-source-id={source.id} key={source.id}>
        <label><input type="checkbox" aria-label={`${text.select} ${source.id}`} checked={selectedIds.includes(source.id)} disabled={frozen || (!selectedIds.includes(source.id) && selectedIds.length >= 20)} onChange={(event) => setSelectedIds((ids) => event.target.checked ? [...ids, source.id] : ids.filter((id) => id !== source.id))} /><span>{source.text}</span></label>
        <small>{text.revision} {source.revision} · {source.privacy === 'local-only' ? text.local : text.cloud} · {text.scope}: {source.scope.kind}</small>
        <details><summary>{source.id}</summary><pre>{json({ fingerprint: source.fingerprint, sourceReferences: source.sourceReferences, sourceEventIds: source.sourceEventIds })}</pre></details>
      </article>)}</div>
      <div className="consolidation-binding"><label>{text.provider}<select aria-label={text.provider} value={providerId} disabled={frozen} onChange={(event) => { const id = event.target.value; setProviderId(id); setModel(enabled.find((item) => item.id === id)?.model ?? ''); }}><option value="">{text.chooseProvider}</option>{enabled.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
        <label>{text.model}<input aria-label={text.model} maxLength={240} value={model} disabled={frozen} onChange={(event) => setModel(event.target.value)} /></label></div>
      <p>{provider?.name ?? '—'} · {provider?.baseUrl ?? '—'} · {model || '—'}</p>
      {selectedSources.length > 0 && <p>{selectedSources.length} {locale === 'en' ? 'sources selected' : '条来源已选'}</p>}
      <button type="button" disabled={frozen || selectedIds.length === 0 || !provider || !model.trim()} onClick={() => void perform({ kind: 'preview', payload: { operationId: crypto.randomUUID(), sessionId, memoryIds: [...selectedIds], providerId, model: model.trim() } })}>{busy ? text.busy : text.preview}</button>
    </section>}
    <section className="panel consolidation-batches" aria-label={text.batches}><h3>{text.batches}</h3>{batches.length === 0 && <p>{text.empty}</p>}
      {batches.map((item) => <article data-consolidation-id={item.id} data-consolidation-status={item.status} key={item.id}>
        <p><strong>{text.status[item.status]}</strong> · {item.binding.provider.name} · {item.binding.model} · {item.active ? text.active : text.inactive}</p>
        <small>{item.id} · {new Date(item.createdAt).toLocaleString(locale)}</small><button type="button" className="secondary" disabled={frozen} onClick={() => void chooseBatch(item.id)}>{text.review}</button>
      </article>)}
    </section>
    {batch && <section className="panel consolidation-review" aria-label={text.reviewTitle} data-reviewed-batch-id={batch.id} ref={reviewSection} tabIndex={-1}>
      <div className="panel-heading"><h3>{text.reviewTitle} · {text.status[batch.status]}</h3><button type="button" className="secondary" disabled={frozen} onClick={() => { readSequence.current++; setBatch(null); setEditor(''); }}>{text.close}</button></div>
      <p>{text.version}: <strong data-candidate-version={batch.candidateVersion}>{batch.candidateVersion}</strong> · {batch.active ? text.active : text.inactive}</p>
      <section aria-label={text.previewTitle} className="consolidation-preview"><h4>{text.previewTitle}</h4><p>{text.frozen}</p>
        <dl><dt>{text.provider}</dt><dd>{batch.binding.provider.name} · {batch.binding.provider.baseUrl}</dd><dt>{text.model}</dt><dd>{batch.binding.model}</dd><dt>{text.destination}</dt><dd>{batch.binding.destination}</dd><dt>{text.input}</dt><dd>{batch.budget.inputEstimate}</dd><dt>{text.limit}</dt><dd>{batch.budget.maxInputTokens}</dd><dt>{text.output}</dt><dd>{batch.budget.maxOutputTokens}</dd></dl>
        <h4>{text.sources}</h4>{batch.sources.map((source) => <blockquote key={source.id} data-frozen-source-id={source.id}><p>{source.text}</p><small>{source.id} · {text.revision} {source.revision} · {source.privacy === 'local-only' ? text.local : text.cloud} · {source.scope.kind}</small></blockquote>)}
      </section>
      <p>{text.once}</p>{batch.status === 'draft' && <button type="button" disabled={frozen} onClick={() => void perform({ kind: 'generate', payload: { id: batch.id, operationId: crypto.randomUUID() } })}>{text.generate}</button>}
      {hasCandidate && batch.candidate ? <>
        <p>{text.editorNote}</p><div className="consolidation-segments">{batch.candidate.segments.map((segment, index) => <blockquote key={index}><p>{segment.text}</p><small>{segment.sourceIds.join(', ')}</small></blockquote>)}</div>
        <dl><dt>{text.covered}</dt><dd>{batch.candidate.coveredMemoryIds.join(', ')}</dd><dt>{text.uncovered}</dt><dd>{batch.candidate.uncoveredMemoryIds.join(', ') || text.none}</dd><dt>{text.conflicts}</dt><dd>{batch.candidate.conflicts.length ? batch.candidate.conflicts.join('\n') : text.none}</dd></dl>
        <label>{text.candidateJson}<textarea aria-label={text.candidateJson} spellCheck={false} rows={14} maxLength={120_000} disabled={frozen || batch.status !== 'review'} value={editor} onChange={(event) => { setEditor(event.target.value); setReviewed(false); setEnable(false); }} /></label>
        {dirty && <p role="status">{text.dirty}</p>}{batch.status === 'review' && <button type="button" className="secondary" disabled={frozen || !dirty} onClick={saveEdit}>{text.save}</button>}
        {!complete && <p>{text.fullCoverage}</p>}
        {batch.status === 'review' && <div className="consolidation-confirm">
          <label><input type="checkbox" checked={reviewed} disabled={frozen || dirty} onChange={(event) => setReviewed(event.target.checked)} />{text.reviewed}</label>
          <label><input type="checkbox" checked={enable} disabled={frozen || dirty || !complete} onChange={(event) => setEnable(event.target.checked)} />{text.enable}</label><p>{text.enableNote}</p>
          <button type="button" disabled={frozen || dirty || !reviewed} onClick={() => void perform({ kind: 'apply', payload: { id: batch.id, operationId: crypto.randomUUID(), expectedVersion: batch.candidateVersion, fidelityReviewed: true, enableRepresentation: enable } })}>{text.confirm}</button>
        </div>}
      </> : <p>{text.noCandidate}</p>}
      {(batch.invalidReason || batch.completionReason) && <p>{text.noCandidateReason}: <code data-consolidation-reason>{batch.invalidReason ?? batch.completionReason}</code></p>}
      <div className="button-row">{batch.active && <button type="button" className="secondary" disabled={frozen} onClick={() => void perform({ kind: 'disable', payload: { id: batch.id, operationId: crypto.randomUUID() } })}>{text.disable}</button>}{canCancel(batch) && <button type="button" className="secondary" disabled={frozen} onClick={() => void perform({ kind: 'cancel', payload: { id: batch.id, operationId: crypto.randomUUID() } })}>{text.cancel}</button>}</div>
      <details className="consolidation-details"><summary>{text.raw}</summary><p>job: {batch.jobStatus ?? '—'} · {batch.jobId ?? '—'}</p><strong>{text.rawResponse}</strong><pre>{batch.rawResponse ?? '—'}</pre><strong>{text.observations}</strong><pre>{json(batch.request)}</pre><strong>{text.receipts}</strong><pre>{json(batch.receipts)}</pre></details>
    </section>}
    <p className="muted">{text.warning}</p>
  </section>;
};
