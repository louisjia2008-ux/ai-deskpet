import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ProviderConfig, ProviderModel, UsageCurrency } from '../../shared';
import type { UsageAPI, UsageScope, UsageSnapshot } from '../../shared/automation';
import { projectUsage } from '../../main/domain/usage-projection';
import type { ProjectedUsageRequest, UsageGroup, UsageTotals } from '../../main/domain/usage-projection';
import { UsageRateEditor } from './UsageRateEditor';
import './next-usage.css';

const labels = {
  en: {
    title: 'Tokens and cost', refresh: 'Refresh records', loading: 'Reading saved usage records…',
    readError: 'Could not refresh saved usage. Any previously displayed data is retained; the current total is not confirmed.',
    intro: 'Your recorded token usage and known costs across chats and tasks.',
    total: 'Total tokens', input: 'Input tokens', output: 'Output tokens', dispatched: 'Dispatched requests', peak: 'Single-request peak',
    recorded: 'Provider-reported tokens', complete: 'Requests with complete token counts', incomplete: 'Requests with incomplete token counts',
    peakNote: 'Complete provider-reported requests only', prepared: 'Saved requests', notSent: 'Dispatch not observed',
    reported: 'Provider reported', estimated: 'Input estimate', unknown: 'Unknown',
    costSummary: 'Cost totals', reportedCost: 'Reported cost (USD)', estimatedCost: 'Estimated cost (USD)', unknownCost: 'Requests with unknown cost',
    cost: 'Cost', costReported: 'Provider reported', costEstimated: 'Estimated', coveredRequests: 'Covered requests',
    costNote: 'Reported and estimated amounts are separate known portions, not historical invoices. New requests retain their price snapshot; records without a price use a labelled current-price supplement. Currencies are kept separate. Missing amounts stay unknown.',
    estimatedCNY: 'Estimated cost (CNY)', estimates: 'Estimated cost by currency', cached: 'Cache read', cacheWrite: 'Cache write', reasoning: 'Reasoning (included in output)',
    priceDetails: 'Pricing details', requestPrice: 'Request-time price', currentPrice: 'Supplement at current price', cacheUnknown: 'Cache details not returned; estimated at ordinary input price.',
    priceSource: 'Price source', priceTime: 'Price checked', reference: 'Official reference', catalog: 'Provider catalog', manual: 'Custom price',
    reasons: { reported: 'Provider-reported amount', 'entered-rate': 'Current saved price', 'request-rate': 'Request-time price', 'current-reference': 'Supplement at current price',
      'not-dispatched': 'Dispatch not observed', 'identity-conflict': 'Conflicting request identity', 'missing-usage': 'Provider did not return complete token counts',
      'missing-input-usage': 'Provider did not return input tokens', 'missing-output-usage': 'Provider did not return output tokens', 'missing-rate': 'No price for this model and endpoint',
      'missing-rate-at-request': 'No price saved when this request was made', 'endpoint-mismatch': 'Saved price belongs to a different endpoint', 'invalid-cache-usage': 'Invalid cache or reasoning token details',
      'missing-cache-rate': 'Cache use was reported, but its price is unknown', 'invalid-rate': 'Unsupported or invalid price' },
    partial: 'Totals add only known provider-reported input and output tokens. Estimates and missing usage are not included; unknown does not mean zero.',
    requests: 'Request history', empty: 'No saved provider request records.', request: 'Time / request', binding: 'Model', state: 'Outcome',
    receipt: 'Request details', noDispatch: 'Dispatch not observed', conflict: 'Conflicting request identity; token counts remain unknown',
    groups: 'By request category', models: 'By model', batches: 'Parent batches', batchNote: 'These are views of the same unique child requests. Batch totals are not added again to overall usage.',
    category: 'Category', count: 'Requests', coverage: 'Complete records',
    outcomes: { completed: 'Completed', failed: 'Failed', aborted: 'Cancelled', prepared: 'Prepared', 'fetch-invoked': 'Sent', 'response-received': 'Response received', terminal: 'Ended' },
    scopes: { chat: 'Chat', 'background-job': 'Background text', delegation: 'Delegation', consolidation: 'Memory consolidation', schedule: 'Scheduled task', proactive: 'Proactive message', other: 'Other' },
  },
  'zh-CN': {
    title: 'Token 与费用', refresh: '刷新记录', loading: '正在读取已保存的用量记录…',
    readError: '无法刷新已保存用量。此前显示的数据已保留，当前总量尚未确认。',
    intro: '记录聊天与任务使用的 Token 和已知费用。',
    total: '累计 Token', input: '输入 Token', output: '输出 Token', dispatched: '已派发请求', peak: '单次峰值',
    recorded: 'Provider 实报 Token', complete: '用量完整的请求', incomplete: '用量不完整的请求',
    peakNote: '仅统计输入、输出均有实报的请求', prepared: '已保存请求', notSent: '未观察到派发',
    reported: 'Provider 实报', estimated: '输入估算', unknown: '未知',
    costSummary: '累计费用', reportedCost: '累计实报费用（USD）', estimatedCost: '累计估算费用（USD）', unknownCost: '费用未知的请求',
    cost: '费用', costReported: 'Provider 实报', costEstimated: '估算', coveredRequests: '已覆盖请求',
    costNote: '实报与估算分别汇总已知部分，不代表历史账单。新请求保留当时的费率快照；缺少快照的记录按当前价格补算并标注。不同币种分别累计，缺失金额保持未知。',
    estimatedCNY: '累计估算费用（CNY）', estimates: '估算费用（按币种）', cached: '缓存读取', cacheWrite: '缓存写入', reasoning: '推理（已包含在输出中）',
    priceDetails: '计价依据', requestPrice: '请求时费率', currentPrice: '按当前价补算', cacheUnknown: '缓存明细未返回，按普通输入价估算。',
    priceSource: '价格来源', priceTime: '价格核对时间', reference: '官方参考价', catalog: '服务商目录价', manual: '自定义费率',
    reasons: { reported: '服务商实报金额', 'entered-rate': '当前已保存费率', 'request-rate': '请求时费率', 'current-reference': '按当前价补算',
      'not-dispatched': '未观察到派发', 'identity-conflict': '请求身份冲突', 'missing-usage': '接口未返回完整 Token 数',
      'missing-input-usage': '接口未返回输入 Token', 'missing-output-usage': '接口未返回输出 Token', 'missing-rate': '缺少此模型与接口的费率',
      'missing-rate-at-request': '请求时未保存费率', 'endpoint-mismatch': '已保存费率属于其他接口地址', 'invalid-cache-usage': '缓存或推理 Token 明细无效',
      'missing-cache-rate': '已返回缓存用量，但缺少对应单价', 'invalid-rate': '费率无效或暂不支持此计价方式' },
    partial: '累计仅相加 Provider 已实报的输入和输出 Token。估算与缺失用量不计入累计；未知不代表零。',
    requests: '请求记录', empty: '暂无已保存的 Provider 请求记录。', request: '时间／请求', binding: '模型', state: '结果',
    receipt: '请求详情', noDispatch: '未观察到派发', conflict: '请求身份冲突，Token 数保持未知',
    groups: '按请求类别', models: '按模型', batches: '父批次', batchNote: '这些只是同一批唯一子请求的分组视图，批次汇总不会再次加入总用量。',
    category: '类别', count: '请求数', coverage: '完整记录',
    outcomes: { completed: '已完成', failed: '失败', aborted: '已取消', prepared: '已准备', 'fetch-invoked': '已发送', 'response-received': '已收到响应', terminal: '已结束' },
    scopes: { chat: '聊天', 'background-job': '后台文本任务', delegation: '委派', consolidation: '记忆整理', schedule: '定时任务', proactive: '主动消息', other: '其他' },
  },
};
type Copy = typeof labels.en;
const quantity = (value: number | null, unknown: string): string => value === null ? unknown : value.toLocaleString('en-US');
const money = (value: number | null, unknown: string, currency: UsageCurrency = 'USD'): string => {
  const symbol = currency === 'CNY' ? '¥' : '$';
  return value === null ? unknown : value > 0 && value < 0.000001 ? `<${symbol}0.000001`
    : `${symbol}${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}${currency === 'CNY' ? ' CNY' : ''}`;
};
const costPortion = (value: number | null, requests: number): number | null => requests > 0 ? value : null;
const costSource = (value: 'provider-reported' | 'estimated' | 'unknown', text: Copy): string => value === 'provider-reported' ? text.costReported : value === 'estimated' ? text.costEstimated : text.unknown;
const source = (value: 'provider-reported' | 'estimated' | 'unknown', text: Copy): string => value === 'provider-reported' ? text.reported : value === 'estimated' ? text.estimated : text.unknown;
const reportedTotal = (request: ProjectedUsageRequest): number | null => {
  if (!request.dispatched || request.input.source !== 'provider-reported' || request.output.source !== 'provider-reported') return null;
  const total = request.input.value! + request.output.value!;
  return Number.isSafeInteger(total) ? total : null;
};
const reportedSide = (tokens: number | null, count: number, dispatched: number): number | null => count > 0 || dispatched === 0 ? tokens : null;
const EstimatedAmounts = ({ totals, text }: { totals: UsageTotals; text: Copy }): JSX.Element => <>
  {(totals.estimatedCostRequestsByCurrency.USD ?? 0) > 0 && <span>{money(totals.estimatedByCurrency.USD ?? null, text.unknown)}</span>}
  {(totals.estimatedCostRequestsByCurrency.CNY ?? 0) > 0 && <span>{money(totals.estimatedByCurrency.CNY ?? null, text.unknown, 'CNY')}</span>}
  {totals.estimatedCostRequests === 0 && text.unknown}
</>;

const GroupTable = ({ groups, text, kind }: { groups: UsageGroup[]; text: Copy; kind: 'scope' | 'model' | 'batch' }): JSX.Element => <div className="usage-table-wrap"><table className="usage-table usage-group-table">
  <thead><tr><th>{kind === 'model' ? text.binding : text.category}</th><th>{text.count}</th><th>{text.total}</th><th>{text.reportedCost}</th><th>{text.estimates}</th><th>{text.unknownCost}</th></tr></thead>
  <tbody>{groups.map((group) => <tr key={group.id}><td>{kind === 'scope' ? text.scopes[group.id as UsageScope] : kind === 'model' ? <>{group.requests[0]?.event.model}<small>{group.requests[0]?.event.providerId}</small></> : <code>{group.id}</code>}</td>
    <td>{group.totals.dispatchedRequests}</td><td>{quantity(group.totals.reportedTokens, text.unknown)}<small>{text.coverage}: {group.totals.completeReportedRequests} / {group.totals.dispatchedRequests}</small></td>
    <td>{money(costPortion(group.totals.reportedUSD, group.totals.reportedCostRequests), text.unknown)}</td>
    <td className="usage-group-cost"><EstimatedAmounts totals={group.totals} text={text} /></td><td>{group.totals.unknownCostRequests}</td></tr>)}</tbody>
</table></div>;
const RequestRow = ({ request, text, locale }: { request: ProjectedUsageRequest; text: Copy; locale: string }): JSX.Element => <tr data-request-id={request.event.requestId}>
  <td><time dateTime={request.event.preparedAt}>{new Date(request.event.preparedAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time><small>{text.scopes[request.event.scope]}</small>
    <details><summary>{text.receipt}</summary><code>{request.event.requestId}</code><small>{request.event.ownerId}</small><small>{request.event.providerId}</small></details></td>
  <td>{request.event.model}</td>
  <td>{request.dispatched ? text.outcomes[request.event.outcome ?? request.event.phase] : text.noDispatch}{request.identityConflict && <small>{text.conflict}</small>}</td>
  <td>{quantity(request.input.value, text.unknown)}<small>{source(request.input.source, text)}</small>
    {request.event.cachedInputTokens != null && <small>{text.cached}: {quantity(request.event.cachedInputTokens, text.unknown)}</small>}
    {request.event.cacheWriteInputTokens != null && <small>{text.cacheWrite}: {quantity(request.event.cacheWriteInputTokens, text.unknown)}</small>}</td>
  <td>{quantity(request.output.value, text.unknown)}<small>{source(request.output.source, text)}</small>
    {request.event.reasoningOutputTokens != null && <small>{text.reasoning}: {quantity(request.event.reasoningOutputTokens, text.unknown)}</small>}</td>
  <td>{quantity(reportedTotal(request), text.unknown)}</td>
  <td>{money(request.cost.amount, text.unknown, request.cost.currency ?? 'USD')}<small>{costSource(request.cost.source, text)}</small>
    <small>{text.reasons[request.cost.reason]}</small>
    {request.cost.source === 'estimated' && request.cost.cacheBreakdown === 'unknown' && <small>{text.cacheUnknown}</small>}
    {request.cost.rate && <details><summary>{text.priceDetails}</summary>
      <small>{text.priceSource}: {request.cost.rate.source === 'manual' ? text.manual : request.cost.rate.source === 'provider-api' ? text.catalog : text.reference}</small>
      <small>{text.priceTime}: {new Date(request.cost.rate.checkedAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}</small>
      <code>{request.cost.rate.endpoint}</code>{request.cost.rate.sourceUrl && <code>{request.cost.rate.sourceUrl}</code>}
      {request.cost.rate.note && <small>{request.cost.rate.note}</small>}
    </details>}</td>
</tr>;

export const UsagePage = ({ api, locale, providers = [], providerApi }: { api: UsageAPI; locale: string; providers?: ProviderConfig[]; providerApi?: { listModels(id: string): Promise<ProviderModel[]> } }): JSX.Element => {
  const text = labels[locale === 'zh-CN' ? 'zh-CN' : 'en'];
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null), [readError, setReadError] = useState(false);
  const mounted = useRef(true), sequence = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    const current = ++sequence.current;
    try { const next = await api.snapshot(); if (mounted.current && current === sequence.current) { setSnapshot(next); setReadError(false); } }
    catch { if (mounted.current && current === sequence.current) setReadError(true); }
  }, [api]);
  const stopReads = useCallback((): void => { mounted.current = false; sequence.current++; }, []);
  useEffect(() => { mounted.current = true; void refresh(); return stopReads; }, [refresh, stopReads]);
  const replaceSnapshot = (next: UsageSnapshot): void => { if (mounted.current) { sequence.current++; setSnapshot(next); setReadError(false); } };
  const projection = useMemo(() => projectUsage({ events: snapshot?.events ?? [], rates: snapshot?.rates ?? [] }), [snapshot]);
  const totals = projection.summary;
  return <section className="usage-page" aria-label={text.title}>
    <header className="page-header"><div><h1>{text.title}</h1><p>{text.intro}</p></div><button type="button" className="secondary" onClick={() => void refresh()}>{text.refresh}</button></header>
    {readError && <p role="alert">{text.readError}</p>}{snapshot === null && !readError && <p role="status">{text.loading}</p>}
    {snapshot !== null && <>
      <dl className="usage-summary" aria-label={text.title}>
        <div className="usage-total"><dt>{text.total}</dt><dd>{quantity(totals.reportedTokens, text.unknown)}</dd><small>{text.recorded}</small></div>
        <div><dt>{text.input}</dt><dd>{quantity(reportedSide(totals.reportedInputTokens, totals.reportedInputRequests, totals.dispatchedRequests), text.unknown)}</dd><small>{text.reported}</small></div>
        <div><dt>{text.output}</dt><dd>{quantity(reportedSide(totals.reportedOutputTokens, totals.reportedOutputRequests, totals.dispatchedRequests), text.unknown)}</dd><small>{text.reported}</small></div>
        <div><dt>{text.dispatched}</dt><dd>{totals.dispatchedRequests.toLocaleString('en-US')}</dd><small>{text.prepared}: {totals.preparedRequests}</small></div>
        <div><dt>{text.peak}</dt><dd>{quantity(totals.peakReportedTokens, text.unknown)}</dd><small>{text.peakNote}</small></div>
      </dl>
      <p className="usage-note">{text.partial}</p>
      <p className="usage-coverage">{text.complete}: {totals.completeReportedRequests} · {text.incomplete}: {totals.incompleteReportedRequests} · {text.notSent}: {totals.notDispatchedRequests}</p>
      <section aria-label={text.costSummary}><h2>{text.costSummary}</h2><dl className="usage-summary usage-cost-summary">
        <div><dt>{text.reportedCost}</dt><dd>{money(costPortion(totals.reportedUSD, totals.reportedCostRequests), text.unknown)}</dd><small>{text.coveredRequests}: {totals.reportedCostRequests}</small></div>
        <div><dt>{text.estimatedCost}</dt><dd>{money(costPortion(totals.estimatedUSD, totals.estimatedCostRequestsByCurrency.USD ?? 0), text.unknown)}</dd><small>{text.coveredRequests}: {totals.estimatedCostRequestsByCurrency.USD ?? 0}</small></div>
        {(totals.estimatedCostRequestsByCurrency.CNY ?? 0) > 0 && <div><dt>{text.estimatedCNY}</dt><dd>{money(totals.estimatedByCurrency.CNY ?? null, text.unknown, 'CNY')}</dd><small>{text.coveredRequests}: {totals.estimatedCostRequestsByCurrency.CNY}</small></div>}
        <div><dt>{text.unknownCost}</dt><dd>{totals.unknownCostRequests}</dd></div>
      </dl><p className="usage-note">{text.costNote}</p></section>
      {api.upsertRate && <UsageRateEditor api={api} providers={providers} snapshot={snapshot} locale={locale} onSnapshot={replaceSnapshot}
        refreshPrices={providerApi ? async id => { await providerApi.listModels(id); } : undefined} />}
      {projection.byModel.length > 0 && <section aria-label={text.models}><h2>{text.models}</h2><GroupTable groups={projection.byModel} text={text} kind="model" /></section>}
      <section aria-label={text.requests}><h2>{text.requests}</h2>{projection.requests.length === 0 ? <p>{text.empty}</p> : <div className="usage-table-wrap"><table className="usage-table usage-request-table">
        <thead><tr><th>{text.request}</th><th>{text.binding}</th><th>{text.state}</th><th>{text.input}</th><th>{text.output}</th><th>{text.total}</th><th>{text.cost}</th></tr></thead>
        <tbody>{projection.requests.map((request) => <RequestRow key={request.event.requestId} request={request} text={text} locale={locale} />)}</tbody>
      </table></div>}</section>
      {projection.byScope.length > 0 && <section aria-label={text.groups}><h2>{text.groups}</h2><GroupTable groups={projection.byScope} text={text} kind="scope" /></section>}
      {projection.batches.length > 0 && <section aria-label={text.batches}><h2>{text.batches}</h2><p className="usage-note">{text.batchNote}</p><GroupTable groups={projection.batches} text={text} kind="batch" /></section>}
    </>}
  </section>;
};
