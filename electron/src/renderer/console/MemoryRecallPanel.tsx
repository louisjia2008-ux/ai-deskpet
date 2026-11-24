import { useEffect, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { MemoryRecallAPI, MemoryRecallSearchResult } from '../../shared/memory-recall';
import type { ResolvedLocale } from '../../shared';

interface Props {
  api: MemoryRecallAPI;
  /** Absent: search general memories only. Present: also this conversation's own memories. */
  sessionId?: string | undefined;
  sessionTitle?: string;
  memoryVersion?: string;
  locale: ResolvedLocale;
  onOpenMemory?(id: string): void;
  onUseQuery?(query: string): void;
  continuationDisabled?: boolean;
}
const fallbackExplanation = (result: MemoryRecallSearchResult, zh: boolean): string => {
  switch (result.unavailableReason) {
    case 'model-busy': return zh ? '本地模型正在使用中，这次按关键词查找。待其他任务完成后可以再试。' : 'A local model is in use. These are keyword results; try again when the other task is finished.';
    case 'model-missing': return zh ? '本机尚未安装 nomic-embed-text，这次按关键词查找。' : 'nomic-embed-text is not installed on this device. These are keyword results.';
    case 'not-local': return zh ? '无法确认嵌入模型在本机运行，这次按关键词查找。' : 'The embedding model could not be verified as local. These are keyword results.';
    default: return zh ? '本次本机语义检索不可用，以下是关键词匹配。' : 'Local semantic retrieval was unavailable. These are keyword matches.';
  }
};

/** This explicit local action never reads the profile directly or changes a
 * memory. The host owns eligibility, embeddings, cancellation and result text. */
export function MemoryRecallPanel({ api, sessionId, sessionTitle, memoryVersion, locale, onOpenMemory, onUseQuery, continuationDisabled = false }: Props): JSX.Element {
  const zh = locale === 'zh-CN';
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<MemoryRecallSearchResult | null>(null);
  const [busy, setBusy] = useState(false), [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const operation = useRef<string | null>(null);
  const cancelRequested = useRef(false);
  useEffect(() => {
    setResult(null); setBusy(false); setCancelling(false); setError('');
    return () => {
      const id = operation.current; operation.current = null;
      if (id) void api.cancel({ operationId: id }).catch(() => undefined);
    };
  }, [api, sessionId, memoryVersion]);
  const search = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (operation.current || !query.trim()) return;
    const operationId = crypto.randomUUID(); operation.current = operationId; cancelRequested.current = false;
    setBusy(true); setCancelling(false); setResult(null); setError('');
    try {
      const next = await api.search({ operationId, ...(sessionId ? { sessionId } : {}), query: query.trim() });
      if (operation.current === operationId) {
        if (!cancelRequested.current) setResult(next);
        else setError(zh ? '已取消本次检索。' : 'Search cancelled.');
      }
    } catch (cause) {
      if (operation.current === operationId) {
        const cancelled = cause instanceof Error && /cancelled|AbortError|aborted/u.test(cause.message);
        setError(cancelled ? (zh ? '已取消本次检索。' : 'Search cancelled.') : (zh ? '检索没有完成，请再试一次。' : 'Search did not complete. Please try again.'));
      }
    } finally {
      if (operation.current === operationId) { operation.current = null; setBusy(false); setCancelling(false); }
    }
  };
  const cancel = async (): Promise<void> => {
    const operationId = operation.current;
    if (!operationId || cancelling) return;
    cancelRequested.current = true; setCancelling(true);
    try { await api.cancel({ operationId }); }
    catch { if (operation.current === operationId) { cancelRequested.current = false; setCancelling(false); setError(zh ? '取消未确认，请再试一次。' : 'Cancellation was not confirmed. Please try again.'); } }
  };
  return <section className="panel stack-form" aria-label={zh ? '按大意找回记忆' : 'Find memories by meaning'}>
    <h3>{zh ? '按大意找回记忆' : 'Find memories by meaning'}</h3>
    <p>{sessionId && sessionTitle
      ? (zh ? `用自己的话描述要找的内容。会在本机查找通用记忆，以及「${sessionTitle}」这段对话专属的记忆。` : `Describe what you remember. Searches general memories and those specific to “${sessionTitle}”, on this device.`)
      : (zh ? '用自己的话描述要找的内容，也可以换一种语言。只在本机查找，不会发给云端。' : 'Describe what you remember, in any language. The search runs only on this device.')}</p>
    <form className="stack-form" onSubmit={event => void search(event)}>
      <label>{zh ? '记得的大意' : 'What you remember'}<textarea value={query} disabled={busy} maxLength={3200} onChange={event => setQuery(event.target.value)} /></label>
      <div className="button-row"><button type="submit" disabled={busy || !query.trim()}>{zh ? '在本机查找' : 'Search on this device'}</button>
        {busy && <button type="button" className="secondary" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? (zh ? '正在取消…' : 'Cancelling…') : (zh ? '取消检索' : 'Cancel search')}</button>}</div>
    </form>
    {busy && <p role="status">{cancelling
      ? (zh ? '取消已请求；已派发的本机批次会安全收尾，不会采用其结果。' : 'Cancellation requested. A dispatched local batch will finish safely and its results will be discarded.')
      : (zh ? '正在准备本机检索…首次使用可能需要加载本地模型。' : 'Preparing local retrieval… the first search may need to load the local model.')}</p>}
    {error && <p role="status">{error}</p>}
    {result && <div className="memory-recall-results" aria-label={zh ? '记忆检索结果' : 'Memory search results'}>
      <p role="status">{result.mode === 'lexical' ? (result.reason === 'empty'
        ? (zh ? '当前范围没有可检索的记忆。' : 'There are no searchable memories in this scope.') : fallbackExplanation(result, zh))
        : result.mode === 'partial' ? (zh ? `已按大意检索 ${result.consideredCount} / ${result.eligibleCount} 条记忆，其余仍按关键词查找。` : `Searched ${result.consideredCount} of ${result.eligibleCount} memories by meaning; remaining memories use keywords.`)
          : (zh ? `已在本机按大意检索 ${result.consideredCount} 条记忆。` : `Searched ${result.consideredCount} memories by meaning on this device.`)}</p>
      {!result.matches.length && <p>{zh ? '没有找到足够相关的记忆。可以换个描述再试。' : 'No sufficiently relevant memory was found. Try another description.'}</p>}
      {onUseQuery && sessionId && result.matches.length > 0 && <div>
        <button type="button" className="secondary" disabled={continuationDisabled} onClick={() => onUseQuery(result.query)}>{zh ? '用这个问题继续聊天' : 'Continue with this question'}</button>
        <p className="muted">{continuationDisabled ? (zh ? '当前对话忙碌，请完成后再继续。' : 'Wait for the current conversation to finish.')
          : (zh ? '把问题放回这段对话的输入框，由你点击发送。记忆仍按所选服务的权限使用。' : 'Place the question in this conversation’s composer for you to send. Memories still follow the selected provider’s permissions.')}</p>
      </div>}
      {result.matches.map(match => <article className="memory-card" key={match.id}>
        <p>{match.text}</p>
        <div>{match.tags.map(tag => <span className="tag" key={tag}>{tag}</span>)}</div>
        <small>{match.privacy === 'local-only' ? (zh ? '仅本机' : 'Local only') : (zh ? '已允许所选服务使用' : 'Allowed for the selected provider')}
          {' · '}{zh ? `来源 ${match.sourceCount} 条` : `${match.sourceCount} sources`}
          {match.similarity !== undefined && <> · {zh ? '语义匹配' : 'Semantic match'}</>}</small>
        {onOpenMemory && <button type="button" className="text-button" onClick={() => onOpenMemory(match.id)}>{zh ? '查看记忆' : 'View memory'}</button>}
      </article>)}
    </div>}
  </section>;
}
