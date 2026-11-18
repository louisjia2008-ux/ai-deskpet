import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ChatWorkPanelApi } from '../../shared/chat-work-api';
import type { ChatArtifactEntry, ChatArtifactPage, ChatArtifactPreview, ChatArtifactReference, ChatWorkArtifact } from '../../shared/chat-work';
import type { ResolvedLocale } from '../../shared/contracts';
import { ArtifactPreview } from './ArtifactPreview';
import './artifacts.css';

export const artifactReference = (entry: ChatArtifactReference): ChatArtifactReference => ({ sessionId: entry.sessionId, taskId: entry.taskId, path: entry.path, sha256: entry.sha256 });
export const canExportArtifactPdf = (entry: ChatArtifactReference): boolean => /\.(md|markdown|txt|csv)$/iu.test(entry.path);
type ContinuationArtifact = ChatArtifactReference & Pick<ChatWorkArtifact, 'derivedFrom'>;
export const isPdfArtifact = (entry: Pick<ChatArtifactReference, 'path'>): boolean => /\.pdf$/iu.test(entry.path);
export const canContinueArtifact = (entry: ContinuationArtifact): boolean => !isPdfArtifact(entry)
  || entry.derivedFrom?.format === 'pdf-export' && /\.(md|markdown|txt|csv)$/iu.test(entry.derivedFrom.path);
export const artifactContinuationNote = (entry: ContinuationArtifact, zh: boolean): string | null => !isPdfArtifact(entry) ? null
  : canContinueArtifact(entry) ? (zh ? '修改源文件后，可重新导出 PDF。' : 'Edit the source file, then export a new PDF.')
    : (zh ? '此 PDF 没有已记录的可编辑源文件。' : 'This PDF has no recorded editable source file.');

/** Both surfaces resolve the host-verified PDF back to its own task's saved text source. */
export const checkedArtifactContinuation = async (api: Pick<ChatWorkPanelApi, 'previewArtifact'>, entry: ChatArtifactReference): Promise<ChatArtifactReference> => {
  const checked = await api.previewArtifact(artifactReference(entry));
  if (!isPdfArtifact(checked.artifact)) return artifactReference(checked.artifact);
  if (checked.kind !== 'pdf' || !canContinueArtifact(checked.artifact) || !checked.artifact.derivedFrom) throw new Error('chat.artifactNoEditableSource');
  const source = await api.previewArtifact({ sessionId: checked.artifact.sessionId, taskId: checked.artifact.taskId,
    path: checked.artifact.derivedFrom.path, sha256: checked.artifact.derivedFrom.sha256 });
  if (!('text' in source) || !canExportArtifactPdf(source.artifact)) throw new Error('chat.artifactNoEditableSource');
  return artifactReference(source.artifact);
};
export const artifactContinuationPrompt = (entry: ChatArtifactReference, zh: boolean): string => zh
  ? `请继续修改本对话生成的成果 ${JSON.stringify(entry.path)}（保存版本 SHA-256：${entry.sha256}）。先通过已授权的工作区工具读取并核对版本；若文件已变化，请先说明差异。\n\n我希望修改：`
  : `Continue editing the artifact ${JSON.stringify(entry.path)} from this conversation (saved SHA-256: ${entry.sha256}). First read it through the authorized workspace tools and check its version; if it changed, explain the difference first.\n\nRequested changes: `;

export const artifactError = (error: unknown, zh: boolean): string => {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('chat.artifactNoEditableSource')) return zh ? '此 PDF 没有可核验的文本源文件，无法直接继续修改。' : 'This PDF has no verifiable text source and cannot be continued directly.';
  if (message.includes('chat.artifactExportReceiptUncertain')) return zh ? 'PDF 可能已写入工作区，但成果记录未能确认保存。请刷新检查；不会自动重复导出。' : 'The PDF may have been written, but its artifact record could not be confirmed. Refresh to check; the export will not automatically retry.';
  if (message.includes('chat.artifactExportBusy')) return zh ? '另一个 PDF 正在导出，请稍后重试。' : 'Another PDF export is in progress. Try again when it finishes.';
  if (message.includes('chat.artifactExportTimeout')) return zh ? 'PDF 导出超时，源文件已保留。请稍后重试。' : 'PDF export timed out. The source file is preserved; try again.';
  if (message.includes('chat.artifactCapacity')) return zh ? '此任务的成果记录已满，暂时无法添加 PDF。' : 'This task has reached its artifact limit and cannot add a PDF.';
  if (message.includes('chat.artifactChanged')) return zh ? '文件已在生成后发生变化，无法显示保存版本。请在原对话核对当前文件。' : 'The file has changed since it was created. Check the current file in its original conversation.';
  if (message.includes('chat.artifactTooLarge')) return zh ? '文件超过预览大小上限（文本 1 MiB，PDF 16 MiB），请在文件夹中查看。' : 'The file exceeds the preview limit (1 MiB for text, 16 MiB for PDFs). Reveal it in its folder.';
  if (message.includes('chat.artifactInvalid')) return zh ? '文件格式或编码无法预览，请在文件夹中查看。' : 'This file format or encoding cannot be previewed. Reveal it in its folder.';
  return zh ? '无法读取此成果：文件可能已移走，或来源记录已不可用。请刷新后重试。' : 'This artifact could not be read. Its file or source record may no longer be available. Refresh and try again.';
};

interface Props {
  api: ChatWorkPanelApi;
  locale: ResolvedLocale;
  navigationBusy?: boolean;
  onOpenSession(id: string): void;
  onContinue(artifact: ChatArtifactReference): void;
}

export const ArtifactsPanel = ({ api, locale, navigationBusy = false, onOpenSession, onContinue }: Props): JSX.Element => {
  const zh = locale === 'zh-CN';
  const [query, setQuery] = useState(''), [appliedQuery, setAppliedQuery] = useState('');
  const [page, setPage] = useState<ChatArtifactPage>({ items: [], total: 0, nextOffset: null });
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<ChatArtifactPreview | null>(null);
  const [selected, setSelected] = useState<ChatArtifactEntry | null>(null);
  const live = useRef(false), version = useRef(0), previewVersion = useRef(0);
  const refresh = useCallback(async (offset = 0): Promise<void> => {
    const request = ++version.current;
    setLoading(true);
    try {
      const found = await api.searchArtifacts({ query: appliedQuery, offset, limit: 30 });
      if (!live.current || request !== version.current) return;
      setPage(current => offset ? { ...found, items: [...current.items, ...found.items] } : found);
    } catch { if (live.current && request === version.current) setError(zh ? '成果列表加载失败，请重试。' : 'Could not load artifacts. Try again.'); }
    finally { if (live.current && request === version.current) setLoading(false); }
  }, [api, appliedQuery, zh]);
  useEffect(() => {
    live.current = true;
    void refresh();
    const invalidate = (): void => { ++version.current; ++previewVersion.current; };
    const unsubscribe = api.onChanged(() => { ++previewVersion.current; setBusy(false); setPreview(null); setSelected(null); void refresh(); });
    return () => { live.current = false; invalidate(); unsubscribe(); };
  }, [api, refresh]);
  const search = (event: FormEvent): void => { event.preventDefault(); setError(''); setBusy(false); setPreview(null); setSelected(null); ++previewVersion.current; if (query.trim() === appliedQuery) void refresh(); else setAppliedQuery(query.trim()); };
  const inspect = async (entry: ChatArtifactEntry): Promise<void> => {
    const request = ++previewVersion.current;
    setSelected(entry); setPreview(null); setError(''); setBusy(true);
    try { const result = await api.previewArtifact(artifactReference(entry)); if (live.current && request === previewVersion.current) setPreview(result); }
    catch (failure) { if (live.current && request === previewVersion.current) setError(artifactError(failure, zh)); }
    finally { if (live.current && request === previewVersion.current) setBusy(false); }
  };
  const perform = async (entry: ChatArtifactEntry, action: 'reveal' | 'continue' | 'export'): Promise<void> => {
    setError(''); setNotice(''); setBusy(true);
    try {
      if (action === 'reveal') await api.openArtifact({ sessionId: entry.sessionId, taskId: entry.taskId, path: entry.path });
      else if (action === 'export') {
        const exported = await api.exportArtifactPdf(artifactReference(entry));
        if (live.current) { setNotice(`${zh ? 'PDF 已保存：' : 'PDF saved: '}${exported.path}`); await refresh(); }
      }
      else {
        // Revalidate the selected saved version; never send its bytes to a model here.
        const reference = await checkedArtifactContinuation(api, entry);
        if (live.current) onContinue(reference);
      }
    } catch (failure) { if (live.current) setError(artifactError(failure, zh)); }
    finally { if (live.current) setBusy(false); }
  };
  return <section className="artifacts-page" aria-label={zh ? '成果' : 'Artifacts'}>
    <header><p className="eyebrow">{zh ? '最近产出' : 'Recent outputs'}</p><h1>{zh ? '成果' : 'Artifacts'}</h1><p>{zh ? '查找已记录的文件，预览内容，回到原对话继续完善。' : 'Find recorded files, preview them, and continue working in their original conversation.'}</p></header>
    <form className="artifact-search" onSubmit={search}><label>{zh ? '搜索文件、任务或对话' : 'Search files, tasks or conversations'}<input type="search" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} /></label><button type="submit" disabled={loading}>{zh ? '搜索成果' : 'Search artifacts'}</button></form>
    {error && <p role="alert" className="chat-work-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="artifact-workspace"><div className="artifact-list">
      {loading && <p role="status">{zh ? '正在加载成果…' : 'Loading artifacts…'}</p>}
      {!loading && page.items.length === 0 && <p>{zh ? '没有匹配的成果。对话中成功创建的文件会出现在这里。' : 'No matching artifacts. Files successfully created in conversations will appear here.'}</p>}
      {page.items.map(entry => <article className="artifact-card" key={`${entry.taskId}:${entry.path}`}>
        <button type="button" className="artifact-name" aria-pressed={selected?.taskId === entry.taskId && selected.path === entry.path} disabled={busy} onClick={() => void inspect(entry)}>{entry.path}</button>
        <p>{entry.goal}</p><small>{entry.sessionTitle} · {entry.bytes.toLocaleString(locale)} B · {new Date(entry.updatedAt).toLocaleString(locale)}</small>
        {entry.derivedFrom && <small>{zh ? 'PDF 文本导出自：' : 'PDF text export from: '}{entry.derivedFrom.path}</small>}
        <div className="chat-work-actions"><button type="button" className="text-button" disabled={navigationBusy} onClick={() => onOpenSession(entry.sessionId)}>{zh ? '打开原对话' : 'Open conversation'}</button><button type="button" className="text-button" disabled={busy} onClick={() => void perform(entry, 'reveal')}>{zh ? '显示文件' : 'Show file'}</button><button type="button" className="secondary" disabled={busy || navigationBusy || entry.archived || !canContinueArtifact(entry)} onClick={() => void perform(entry, 'continue')}>{isPdfArtifact(entry) && canContinueArtifact(entry) ? (zh ? '修改源文件' : 'Edit source') : (zh ? '继续修改' : 'Continue editing')}</button></div>
        {artifactContinuationNote(entry, zh) && <small>{artifactContinuationNote(entry, zh)}</small>}
        {canExportArtifactPdf(entry) && <button type="button" className="secondary" disabled={busy} onClick={() => void perform(entry, 'export')}>{zh ? '导出 PDF' : 'Export PDF'}</button>}
        {entry.archived && <small>{zh ? '原对话已归档；恢复对话后可继续修改。' : 'The original conversation is archived. Restore it before continuing.'}</small>}
      </article>)}
      {page.nextOffset !== null && <button type="button" className="secondary" disabled={loading} onClick={() => void refresh(page.nextOffset!)}>{zh ? '加载更多成果' : 'More artifacts'}</button>}
    </div><div className="artifact-detail">
      {selected ? <><h2>{selected.path}</h2>{busy && !preview && <p role="status">{zh ? '正在读取保存版本…' : 'Reading the saved version…'}</p>}{preview && <ArtifactPreview preview={preview} zh={zh} />}</> : <p>{zh ? '选择文件预览 Markdown、CSV 表格或 PDF。预览在本机完成。' : 'Choose a Markdown, CSV or PDF file to preview it on this device.'}</p>}
    </div></div>
  </section>;
};
