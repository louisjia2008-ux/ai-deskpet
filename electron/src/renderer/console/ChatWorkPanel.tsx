import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ResolvedLocale } from '../../shared/contracts';
import type { ChatWorkPanelApi } from '../../shared/chat-work-api';
import type { ChatHistoryHit, ChatHistoryReadPage, ChatWorkStatus, ChatWorkTask, ChatArtifactPreview, ChatArtifactReference } from '../../shared/chat-work';
import type { ChatCronSchedule } from '../../shared/chat-cron';
import { ArtifactPreview } from './ArtifactPreview';
import { artifactError, canExportArtifactPdf, canContinueArtifact, isPdfArtifact, artifactContinuationNote, checkedArtifactContinuation } from './ArtifactsPanel';
import { SaveMethodDialog } from './SaveMethodDialog';
import './chat-work-panel.css';

interface Props { sessionId: string; api: ChatWorkPanelApi; locale: ResolvedLocale; onOpenSession: (sessionId: string) => void; onContinueArtifact?: (reference: ChatArtifactReference) => void; continuationDisabled?: boolean }
const text = {
  en: {
    title: 'Tasks, history & schedules', tasks: 'Task records', schedules: 'Schedules in this conversation', history: 'Search conversation history',
    refresh: 'Refresh', loading: 'Loading…', empty: 'No task records in this conversation yet.', noSchedules: 'No schedules in this conversation.',
    failure: 'This operation failed. Refresh to see the latest saved state.', plan: 'Plan', notes: 'Notes', next: 'Next step', result: 'Result',
    sources: 'Read sources', noSources: 'No source reads recorded.', artifacts: 'Created files', noArtifacts: 'No created files recorded.', truncated: 'Older evidence entries were omitted from this bounded record.',
    reveal: 'Show file', query: 'History query', search: 'Search', currentOnly: 'Only this conversation', noMatches: 'No matching messages.',
    read: 'Read excerpt', open: 'Open conversation', close: 'Close excerpt', more: 'Next excerpt', author: 'You', assistant: 'Assistant',
    scheduleDetail: 'Create or change a schedule by asking in this conversation. Schedules run while DeskPet is open; they do not run after the app exits.',
    frequency: 'Cron expression', timezone: 'Time zone', nextRun: 'Next run', capabilities: 'Allowed tools', instruction: 'Instruction',
    pause: 'Pause', resume: 'Resume', cancel: 'Cancel schedule', confirmCancel: 'Confirm cancellation', keep: 'Keep schedule',
    active: 'Active', paused: 'Paused', cancelled: 'Cancelled', none: 'None', missed: 'Missed runs', skip: 'Skip', runOnce: 'Catch up once',
    status: { running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' } satisfies Record<ChatWorkStatus, string>,
  },
  zh: {
    title: '任务、历史与定时', tasks: '任务记录', schedules: '本对话的定时任务', history: '搜索对话历史',
    refresh: '刷新', loading: '加载中…', empty: '本对话还没有任务记录。', noSchedules: '本对话还没有定时任务。',
    failure: '操作未完成，请刷新查看最新保存状态。', plan: '计划', notes: '笔记', next: '下一步', result: '结果',
    sources: '已读取的来源', noSources: '尚无来源读取记录。', artifacts: '已创建的文件', noArtifacts: '尚无创建文件记录。', truncated: '此记录有容量上限，部分较早的证据条目未保留。',
    reveal: '显示文件', query: '历史关键词', search: '搜索', currentOnly: '仅本对话', noMatches: '没有匹配的消息。',
    read: '阅读片段', open: '打开原对话', close: '关闭片段', more: '下一片段', author: '你', assistant: '助手',
    scheduleDetail: '可在本对话中提出创建或修改定时任务。DeskPet 打开时才运行；退出 App 后不会执行。',
    frequency: 'Cron 表达式', timezone: '时区', nextRun: '下次执行', capabilities: '允许的工具', instruction: '指令',
    pause: '暂停', resume: '恢复', cancel: '取消定时任务', confirmCancel: '确认取消', keep: '保留定时任务',
    active: '已启用', paused: '已暂停', cancelled: '已取消', none: '无', missed: '错过执行时', skip: '跳过', runOnce: '合并补一次',
    status: { running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' } satisfies Record<ChatWorkStatus, string>,
  },
};

// A keyed body keeps history snippets and in-flight UI state scoped to the
// originating conversation, even when two conversations are switched quickly.
export const ChatWorkPanel = (props: Props): JSX.Element => <ChatWorkPanelBody key={props.sessionId} {...props} />;

const ChatWorkPanelBody = ({ sessionId, api, locale, onOpenSession, onContinueArtifact, continuationDisabled = false }: Props): JSX.Element => {
  const copy = locale === 'zh-CN' ? text.zh : text.en;
  const [tasks, setTasks] = useState<ChatWorkTask[]>([]);
  const [schedules, setSchedules] = useState<ChatCronSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [currentOnly, setCurrentOnly] = useState(false);
  const [hits, setHits] = useState<ChatHistoryHit[] | null>(null);
  const [excerpt, setExcerpt] = useState<ChatHistoryReadPage | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [artifactPreview, setArtifactPreview] = useState<ChatArtifactPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [exportNotice, setExportNotice] = useState('');
  const live = useRef(false);
  const refreshVersion = useRef(0);
  const historyVersion = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    const version = ++refreshVersion.current;
    const [nextTasks, nextSchedules] = await Promise.all([api.list(sessionId), api.listCron(sessionId)]);
    if (!live.current || version !== refreshVersion.current) return;
    setTasks(nextTasks); setSchedules(nextSchedules); setLoading(false);
  }, [api, sessionId]);
  useEffect(() => {
    live.current = true;
    const update = (): void => { void refresh().catch(() => { if (live.current) { setError(true); setLoading(false); } }); };
    const invalidate = (): void => { ++refreshVersion.current; ++historyVersion.current; };
    update();
    const unsubscribe = api.onChanged(update);
    return () => { live.current = false; invalidate(); unsubscribe(); };
  }, [api, refresh]);
  const perform = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError(false);
    try { await operation(); if (live.current) await refresh(); }
    catch { if (live.current) setError(true); }
    finally { if (live.current) setBusy(false); }
  };
  const search = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); if (!query.trim()) return;
    const version = ++historyVersion.current;
    setBusy(true); setError(false); setExcerpt(null);
    try {
      const found = await api.searchHistory({ sessionId, query: query.trim(), ...(currentOnly ? { targetSessionId: sessionId } : {}), limit: 20 });
      if (live.current && version === historyVersion.current) setHits(found);
    } catch { if (live.current && version === historyVersion.current) setError(true); }
    finally { if (live.current && version === historyVersion.current) setBusy(false); }
  };
  const read = async (messageId: string, offset: number): Promise<void> => {
    const version = ++historyVersion.current;
    setBusy(true); setError(false);
    try {
      const found = await api.readHistory({ sessionId, messageId, offset, maxCharacters: 4000 });
      if (live.current && version === historyVersion.current) { setExcerpt(found); if (!found) setError(true); }
    } catch { if (live.current && version === historyVersion.current) setError(true); }
    finally { if (live.current && version === historyVersion.current) setBusy(false); }
  };
  const date = (value: string, timezone?: string): string => {
    try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', ...(timezone ? { timeZone: timezone } : {}) }).format(new Date(value)); }
    catch { return value; }
  };
  const previewArtifact = async (reference: ChatArtifactReference, continuing = false): Promise<void> => {
    setBusy(true); setPreviewError(''); setArtifactPreview(null);
    try {
      if (continuing) { const source = await checkedArtifactContinuation(api, reference); if (live.current) onContinueArtifact?.(source); }
      else { const result = await api.previewArtifact(reference); if (live.current) setArtifactPreview(result); }
    }
    catch (failure) { if (live.current) setPreviewError(artifactError(failure, locale === 'zh-CN')); }
    finally { if (live.current) setBusy(false); }
  };
  const exportPdf = async (reference: ChatArtifactReference): Promise<void> => {
    setBusy(true); setPreviewError(''); setExportNotice('');
    try { const exported = await api.exportArtifactPdf(reference); if (live.current) { setExportNotice(`${locale === 'zh-CN' ? 'PDF 已保存：' : 'PDF saved: '}${exported.path}`); await refresh(); } }
    catch (failure) { if (live.current) setPreviewError(artifactError(failure, locale === 'zh-CN')); }
    finally { if (live.current) setBusy(false); }
  };

  return <details className="chat-work-panel" data-testid="chat-work-panel">
    <summary><span className="chat-work-summary"><span>{copy.title}</span><small>{[tasks.length > 0 ? `${tasks.length} ${copy.tasks}` : '', schedules.some((item) => !item.cancelledAt) ? `${schedules.filter((item) => !item.cancelledAt).length} ${copy.schedules}` : ''].filter(Boolean).join(' · ')}</small></span></summary>
    <div className="chat-work-content">
      <div className="chat-work-toolbar"><span className="chat-work-muted">{loading ? copy.loading : ''}</span><button type="button" className="secondary" disabled={busy} onClick={() => void perform(refresh)}>{copy.refresh}</button></div>
      {error && <p className="chat-work-error" role="alert">{copy.failure}</p>}
      <section className="chat-work-section" aria-label={copy.tasks}>
        <h3>{copy.tasks}</h3>
        {!loading && tasks.length === 0 && <p className="chat-work-muted">{copy.empty}</p>}
        <div className="chat-work-list">{tasks.map((task) => <details className="chat-work-task" key={task.id} data-task-id={task.id}>
          <summary><span className="chat-work-task-summary"><strong>{task.goal}</strong><span className="chat-work-state" data-task-status={task.status}>{copy.status[task.status]}</span></span></summary>
          <div className="chat-work-task-body">
            <p className="chat-work-muted"><time dateTime={task.updatedAt}>{date(task.updatedAt)}</time></p>
            {task.plan.length > 0 && <><h4>{copy.plan}</h4><ol>{task.plan.map((step, index) => <li key={index}>{step}</li>)}</ol></>}
            {task.notes && <><h4>{copy.notes}</h4><p>{task.notes}</p></>}
            {task.nextStep && <><h4>{copy.next}</h4><p>{task.nextStep}</p></>}
            {task.summary && <><h4>{copy.result}</h4><p>{task.summary}</p></>}
            {task.status === 'completed' && <SaveMethodDialog task={task} locale={locale} />}
            {task.evidenceTruncated && <p className="chat-work-muted">{copy.truncated}</p>}
            <h4>{copy.sources}</h4>{task.sources.length ? <ul>{task.sources.map((source) => <li className="chat-work-source" key={source.url}><span>{source.title}</span><code>{source.url}</code></li>)}</ul> : <p className="chat-work-muted">{copy.noSources}</p>}
            <h4>{copy.artifacts}</h4>{task.artifacts.length ? <ul className="chat-work-artifacts">{task.artifacts.map((artifact) => <li key={artifact.path}><div><code className="chat-work-file-path">{artifact.path}</code><small>{artifact.bytes.toLocaleString(locale)} B</small></div><button type="button" className="secondary" disabled={busy} onClick={() => void previewArtifact({ sessionId, taskId: task.id, path: artifact.path, sha256: artifact.sha256 })}>{locale === 'zh-CN' ? '预览' : 'Preview'}</button><button type="button" className="secondary" disabled={busy} onClick={() => void perform(() => api.openArtifact({ sessionId, taskId: task.id, path: artifact.path }))}>{copy.reveal}</button>{canExportArtifactPdf({ sessionId, taskId: task.id, ...artifact }) && <button type="button" className="secondary" disabled={busy} onClick={() => void exportPdf({ sessionId, taskId: task.id, path: artifact.path, sha256: artifact.sha256 })}>{locale === 'zh-CN' ? '导出 PDF' : 'Export PDF'}</button>}{onContinueArtifact && <button type="button" className="secondary" disabled={busy || continuationDisabled || !canContinueArtifact({ sessionId, taskId: task.id, ...artifact })} onClick={() => void previewArtifact({ sessionId, taskId: task.id, path: artifact.path, sha256: artifact.sha256 }, true)}>{isPdfArtifact(artifact) && canContinueArtifact({ sessionId, taskId: task.id, ...artifact }) ? (locale === 'zh-CN' ? '修改源文件' : 'Edit source') : (locale === 'zh-CN' ? '继续修改' : 'Continue editing')}</button>}{artifactContinuationNote({ sessionId, taskId: task.id, ...artifact }, locale === 'zh-CN') && <small>{artifactContinuationNote({ sessionId, taskId: task.id, ...artifact }, locale === 'zh-CN')}</small>}</li>)}</ul> : <p className="chat-work-muted">{copy.noArtifacts}</p>}
          </div>
        </details>)}</div>
        {previewError && <p role="alert">{previewError}</p>}
        {exportNotice && <p role="status">{exportNotice}</p>}
        {artifactPreview && <div><strong>{artifactPreview.artifact.path}</strong><button type="button" className="text-button" onClick={() => setArtifactPreview(null)}>{locale === 'zh-CN' ? '关闭预览' : 'Close preview'}</button><ArtifactPreview preview={artifactPreview} zh={locale === 'zh-CN'} /></div>}
      </section>
      <section className="chat-work-section" aria-label={copy.history}>
        <h3>{copy.history}</h3>
        <form className="chat-work-search" onSubmit={(event) => void search(event)}>
          <label>{copy.query}<input type="search" aria-label={copy.query} value={query} maxLength={500} onChange={(event) => setQuery(event.target.value)} /></label>
          <button type="submit" className="secondary" disabled={busy || !query.trim()}>{copy.search}</button>
          <label className="chat-work-search-scope"><input type="checkbox" checked={currentOnly} onChange={(event) => setCurrentOnly(event.target.checked)} />{copy.currentOnly}</label>
        </form>
        {hits?.length === 0 && <p className="chat-work-muted">{copy.noMatches}</p>}
        <div className="chat-work-history-results">{hits?.map((hit) => <article className="chat-work-history-hit" key={hit.messageId} data-history-message-id={hit.messageId}>
          <strong>{hit.sessionTitle}</strong><small>{hit.role === 'user' ? copy.author : copy.assistant} · <time dateTime={hit.createdAt}>{date(hit.createdAt)}</time></small><p>{hit.snippet}</p>
          <div className="chat-work-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void read(hit.messageId, hit.offset)}>{copy.read}</button><button type="button" className="text-button" onClick={() => onOpenSession(hit.sessionId)}>{copy.open}</button></div>
        </article>)}</div>
        {excerpt && <div className="chat-work-history-preview" data-history-excerpt-id={excerpt.messageId}>
          <strong>{excerpt.sessionTitle}</strong><pre>{excerpt.text}</pre><small className="chat-work-muted">{excerpt.offset + 1}–{excerpt.offset + excerpt.text.length} / {excerpt.totalCharacters}</small>
          <div className="chat-work-actions">{excerpt.nextOffset !== null && <button type="button" className="secondary" disabled={busy} onClick={() => void read(excerpt.messageId, excerpt.nextOffset!)}>{copy.more}</button>}<button type="button" className="text-button" onClick={() => onOpenSession(excerpt.sessionId)}>{copy.open}</button><button type="button" className="text-button" onClick={() => setExcerpt(null)}>{copy.close}</button></div>
        </div>}
      </section>
      <section className="chat-work-section" aria-label={copy.schedules}>
        <h3>{copy.schedules}</h3><p className="chat-work-muted">{copy.scheduleDetail}</p>
        {!loading && schedules.length === 0 && <p className="chat-work-muted">{copy.noSchedules}</p>}
        <div className="chat-work-list">{schedules.map((schedule) => <article className="chat-work-cron" key={schedule.id} data-cron-id={schedule.id}>
          <div className="chat-work-cron-heading"><strong>{schedule.title}</strong><span className="chat-work-state">{schedule.cancelledAt ? copy.cancelled : schedule.enabled ? copy.active : copy.paused}</span></div>
          <dl><dt>{copy.frequency}</dt><dd><code>{schedule.expression}</code></dd><dt>{copy.timezone}</dt><dd>{schedule.timezone}</dd><dt>{copy.nextRun}</dt><dd>{schedule.nextRunAt ? <time dateTime={schedule.nextRunAt}>{date(schedule.nextRunAt, schedule.timezone)}</time> : copy.none}</dd><dt>{copy.missed}</dt><dd>{schedule.missedPolicy === 'skip' ? copy.skip : copy.runOnce}</dd><dt>{copy.capabilities}</dt><dd>{schedule.allowedCapabilities.join(', ') || copy.none}</dd></dl>
          <details><summary>{copy.instruction}</summary><p>{schedule.instruction}</p></details>
          {!schedule.cancelledAt && <div className="chat-work-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void perform(() => schedule.enabled ? api.pauseCron({ sessionId, id: schedule.id }) : api.resumeCron({ sessionId, id: schedule.id, expectedRevision: schedule.revision, allowedCapabilities: schedule.allowedCapabilities }))}>{schedule.enabled ? copy.pause : copy.resume}</button>
            {cancelId === schedule.id ? <><button type="button" disabled={busy} onClick={() => void perform(async () => { await api.cancelCron({ sessionId, id: schedule.id }); if (live.current) setCancelId(null); })}>{copy.confirmCancel}</button><button type="button" className="text-button" disabled={busy} onClick={() => setCancelId(null)}>{copy.keep}</button></> : <button type="button" className="text-button" disabled={busy} onClick={() => setCancelId(schedule.id)}>{copy.cancel}</button>}
          </div>}
        </article>)}</div>
      </section>
    </div>
  </details>;
};
