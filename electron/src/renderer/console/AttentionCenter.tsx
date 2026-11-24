import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { AttentionAPI, AttentionItem, AttentionKind, AttentionSnapshot, AttentionTarget } from '../../shared/attention';
import './attention-center.css';

const copy = {
  en: {
    title: 'Needs your attention', intro: 'Results to read, memory candidates to review, and work that needs a decision.',
    refresh: 'Retry', loading: 'Reading saved work…', readFailed: 'Could not read the latest state; the items below are from before.',
    all: 'All', action: 'Needs a decision', review: 'Ready for review', result: 'Results to read',
    notice: 'Automatic notices', proactive: 'Automatic check-in unavailable',
    optional: 'Optional check-ins need no reply or approval. Repeated failures are combined here; a later successful check-in clears this notice.',
    failures: 'Recent failed attempts', details: 'Check-in diagnostics', provider: 'Provider / model', first: 'First failure', latest: 'Latest failure', error: 'Failure reason', hide: 'Hide diagnostics',
    running: 'Work in progress', empty: 'Nothing needs your attention here.', filteredEmpty: 'Nothing in this category.',
    openResult: 'View result', openReview: 'Review candidates', openAction: 'View details', acknowledged: 'Mark viewed', dismiss: 'Remove from this list',
    ackFailed: 'This change was not confirmed. Refresh to check the saved state.', stale: 'This item has changed. Refresh before marking it again.',
    ackNote: 'Marked items leave this list. New progress brings them back when needed.',
    older: 'Earlier completed results remain available on their original pages.', more: 'Show more',
    'background-job': 'Background text task', delegation: 'Text delegation', consolidation: 'Memory consolidation',
    completed: 'A result is ready', failed: 'Execution failed', interrupted: 'Interrupted · result unknown', blocked: 'Needs attention before continuing',
    mixed: 'Some children need attention', expired: 'Deadline reached', invalid: 'Sources changed · review needed', reviewStatus: 'Candidates await your review',
    childProgress: 'Child results ready', sourceRecords: 'Saved sources',
  },
  'zh-CN': {
    title: '待处理', intro: '集中查看待阅读的结果、待审核的记忆候选，以及需要你决定的事项。',
    refresh: '重试', loading: '正在读取已保存的任务…', readFailed: '没读到最新状态，下面仍是之前的事项。',
    all: '全部', action: '需要处理', review: '待审核', result: '结果待查看',
    notice: '自动消息提示', proactive: '主动问候暂时未成功',
    optional: '这是可选问候，无需回复或批准。同类失败合并提示；后续问候成功后自动收起。',
    failures: '近期失败次数', details: '查看问候诊断', provider: '模型服务 / 模型', first: '首次失败', latest: '最近失败', error: '失败原因', hide: '收起诊断',
    running: '正在进行', empty: '这里暂时没有需要你处理的事项。', filteredEmpty: '此分类暂无待处理事项。',
    openResult: '查看结果', openReview: '审阅候选', openAction: '查看详情', acknowledged: '标记已查看', dismiss: '移出待处理',
    ackFailed: '此操作尚未确认，请刷新核对已保存状态。', stale: '这项内容已有更新，请刷新后再标记。',
    ackNote: '标记后从此页收起；有新进展时会重新显示。',
    older: '更早完成的结果仍可在原页面查看。', more: '显示更多',
    'background-job': '后台文本任务', delegation: '文本委派', consolidation: '记忆整理',
    completed: '有结果可查看', failed: '执行失败', interrupted: '已中断 · 结果未知', blocked: '需要先核对后续处理',
    mixed: '部分子任务需要处理', expired: '已到截止时间', invalid: '来源已变更 · 需要审阅', reviewStatus: '候选内容等待你审核',
    childProgress: '已就绪的子任务结果', sourceRecords: '来源记录',
  },
};
type Filter = AttentionKind | 'all';

export const AttentionCenter = ({ api, locale, onOpen }: { api: AttentionAPI; locale: string; onOpen(target: AttentionTarget): void }): JSX.Element => {
  const text = copy[locale === 'zh-CN' ? 'zh-CN' : 'en'];
  const [snapshot, setSnapshot] = useState<AttentionSnapshot | null>(null), [readFailed, setReadFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('all'), [shownCount, setShownCount] = useState(50);
  const [pending, setPending] = useState<string | null>(null), [actionError, setActionError] = useState<'stale' | 'failed' | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const mounted = useRef(true), sequence = useRef(0), busy = useRef(false);
  const refresh = useCallback(async (): Promise<void> => {
    const current = ++sequence.current;
    try { const next = await api.snapshot(); if (mounted.current && sequence.current === current) { setSnapshot(next); setReadFailed(false); } }
    catch { if (mounted.current && sequence.current === current) setReadFailed(true); }
  }, [api]);
  const stopReads = useCallback((): void => { mounted.current = false; sequence.current++; }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    const stop = api.onChanged?.(() => void refresh());
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => { stopReads(); stop?.(); window.clearInterval(interval); };
  }, [api, refresh, stopReads]);
  const acknowledge = async (item: AttentionItem): Promise<void> => {
    if (busy.current) return; busy.current = true; setPending(item.id); setActionError(null);
    try { await api.acknowledge({ id: item.id, fingerprint: item.fingerprint }); await refresh(); }
    catch (error) { if (mounted.current) setActionError(error instanceof Error && error.message.includes('attention.stale') ? 'stale' : 'failed'); }
    finally { busy.current = false; if (mounted.current) setPending(null); }
  };
  const visible = snapshot?.items.filter(item => filter === 'all' || item.kind === filter) ?? [];
  const status = (item: AttentionItem): string => item.status === 'review' ? text.reviewStatus : text[item.status];
  return <section className="attention-center" aria-label={text.title}>
    <header className="page-header"><div><h1>{text.title}</h1><p>{text.intro}</p></div></header>
    {readFailed && <p role="alert">{text.readFailed} <button type="button" className="secondary" onClick={() => void refresh()}>{text.refresh}</button></p>}{actionError && <p role="alert">{actionError === 'stale' ? text.stale : text.ackFailed}</p>}
    {snapshot === null && !readFailed && <p role="status">{text.loading}</p>}
    {snapshot !== null && <>
      {snapshot.runningCount > 0 && <div className="attention-overview" aria-label={text.running}><span>{text.running}</span><strong>{snapshot.runningCount}</strong></div>}
      <div className="attention-filters" role="group" aria-label={text.title}>{(['all', 'action', 'review', 'result', 'notice'] as const).map(value => <button type="button" aria-pressed={filter === value} key={value} onClick={() => { setFilter(value); setShownCount(50); }}>
        {text[value]} <span>{value === 'all' ? snapshot.items.length : snapshot.counts[value] ?? 0}</span>
      </button>)}</div>
      {visible.length > 0 && <p className="attention-note">{text.ackNote}</p>}
      {visible.length === 0 ? <div className="attention-empty">{filter === 'all' ? text.empty : text.filteredEmpty}</div> : <div className="attention-list">
        {visible.slice(0, shownCount).map(item => <article className={`attention-card attention-${item.kind}`} key={item.id} data-attention-id={item.id} aria-label={item.title || text[item.source]}>
          <div className="attention-card-heading"><span className="attention-kind">{text[item.kind]}</span><span>{text[item.source]}</span><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString(locale)}</time></div>
          <h2>{item.title || text[item.source]}</h2><p>{status(item)}</p>
          {item.automaticIssue && <><p>{text.optional}</p><p>{text.failures}: {item.automaticIssue.occurrences}</p></>}
          {item.source === 'delegation' && <p className="attention-note">{text.childProgress}: {item.completedChildren} / {item.totalChildren}</p>}
          <div className="attention-actions"><button type="button" aria-expanded={item.automaticIssue ? expanded === item.id : undefined} onClick={() => item.automaticIssue ? setExpanded(value => value === item.id ? null : item.id) : onOpen(item.target)}>{item.automaticIssue ? expanded === item.id ? text.hide : text.details : item.kind === 'review' ? text.openReview : item.kind === 'result' ? text.openResult : text.openAction}</button>
            <button type="button" className="secondary" disabled={pending !== null} onClick={() => void acknowledge(item)}>{item.kind === 'result' ? text.acknowledged : text.dismiss}</button></div>
          {item.automaticIssue && expanded === item.id && <section className="attention-diagnostics" aria-label={text.details}>
            <p>{text.provider}: {item.automaticIssue.providerName} · {item.automaticIssue.model}</p>
            <p>{text.first}: {new Date(item.automaticIssue.firstAt).toLocaleString(locale)}</p>
            <p>{text.latest}: {new Date(item.updatedAt).toLocaleString(locale)}</p>
            <p>{text.error}: {automaticFailureMessage(item.automaticIssue.errorCode, locale)} <code>({item.automaticIssue.errorCode})</code></p>
          </section>}
        </article>)}
      </div>}
      {visible.length > shownCount && <button type="button" className="secondary attention-more" onClick={() => setShownCount(current => current + 50)}>{text.more}</button>}
      {snapshot.olderResults > 0 && <footer className="attention-note"><p>{text.older}</p></footer>}
    </>}
  </section>;
};

export const automaticFailureMessage = (code: string, locale: string): string => {
  const zh = locale === 'zh-CN';
  const reasons: Record<string, [string, string]> = {
    'provider.unsupportedParameter': ['请求包含此模型不支持的参数。', 'The request included a parameter this model does not support.'],
    'provider.authentication': ['模型服务认证失败，请核对已配置的凭据。', 'Provider authentication failed; check the configured credentials.'],
    'provider.quota': ['模型服务额度或支出上限不足。', 'Provider quota or spending limit was reached.'],
    'provider.rateLimit': ['模型服务暂时限流。', 'The provider temporarily rate limited this request.'],
    'provider.timeout': ['等待模型服务响应超时。', 'The provider response timed out.'],
    'provider.unavailable': ['模型服务暂时不可用。', 'The provider is temporarily unavailable.'],
    'provider.modelUnavailable': ['当前模型不可用或没有访问权限。', 'The model is unavailable or access is missing.'],
    'job.interruptedUnknown': ['应用退出或请求中断，结果未知；不会自动重发旧问候。', 'The request was interrupted; old check-ins are not automatically retried.'],
  };
  return reasons[code]?.[zh ? 0 : 1] ?? (zh ? '本次模型请求未成功，未生成问候；无需逐条处理旧记录。' : 'This model request did not complete; old check-ins need no individual action.');
};
