import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageAPI, UsageEvent, UsageSnapshot } from '../../shared/automation';
import { UsagePage } from './UsagePage';

const receipt = (patch: Partial<UsageEvent> = {}): UsageEvent => ({ requestId: 'synthetic-request', ownerId: 'synthetic-turn', scope: 'chat', batchId: null,
  providerId: 'synthetic-provider', model: 'synthetic-model', preparedAt: '2026-10-29T00:00:00.000Z', dispatchedAt: '2026-10-29T00:00:01.000Z', terminalAt: '2026-10-29T00:00:02.000Z',
  phase: 'terminal', outcome: 'completed', inputEstimate: 900, maxOutputTokens: 4096, inputTokens: 100, outputTokens: 20, tokenSource: 'provider-reported', reportedCostUSD: null, ...patch });
const fixture = (initial: UsageSnapshot) => {
  let snapshot = structuredClone(initial);
  const read = vi.fn<UsageAPI['snapshot']>(async () => structuredClone(snapshot));
  const api: UsageAPI = { snapshot: read };
  return { api, read, replace: (next: UsageSnapshot) => { snapshot = structuredClone(next); } };
};
const card = (label: string) => screen.getByText(label, { selector: 'dt' }).parentElement!;
afterEach(cleanup);

describe('token usage records', () => {
  it('shows cumulative reported tokens and a complete-request peak without counting lifecycle observations twice', async () => {
    const f = fixture({ events: [receipt(), receipt({ phase: 'response-received', terminalAt: null }), receipt({ requestId: 'second-request', inputTokens: 200, outputTokens: 35, outcome: 'failed' })], rates: [] });
    render(<UsagePage api={f.api} locale="en" />);
    const region = await screen.findByRole('region', { name: 'Request history' });
    expect(within(region).getAllByRole('row')).toHaveLength(3);
    expect(card('Total tokens').querySelector('dd')).toHaveTextContent('355');
    expect(card('Input tokens').querySelector('dd')).toHaveTextContent('300');
    expect(card('Output tokens').querySelector('dd')).toHaveTextContent('55');
    expect(card('Dispatched requests').querySelector('dd')).toHaveTextContent('2');
    expect(card('Single-request peak').querySelector('dd')).toHaveTextContent('235');
    expect(within(region).getByText('Failed')).toBeVisible();
  });

  it('keeps unknown usage and input estimates separate from actual totals, including an explicit reported zero', async () => {
    const unknown = receipt({ inputTokens: null, outputTokens: null, tokenSource: 'unknown', outcome: 'aborted' });
    const f = fixture({ events: [unknown], rates: [] });
    render(<UsagePage api={f.api} locale="en" />);
    const region = await screen.findByRole('region', { name: 'Request history' });
    expect(within(region).getByText('Cancelled')).toBeVisible(); expect(within(region).getByText('900')).toBeVisible();
    expect(within(region).getByText('Input estimate')).toBeVisible();
    expect(card('Total tokens').querySelector('dd')).toHaveTextContent('Unknown');
    expect(card('Single-request peak').querySelector('dd')).toHaveTextContent('Unknown');
    expect(screen.getByText(/unknown does not mean zero/)).toBeVisible();
    f.replace({ events: [receipt({ inputTokens: 0, outputTokens: 0 })], rates: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh records' }));
    await waitFor(() => expect(card('Total tokens').querySelector('dd')).toHaveTextContent(/^0$/));
    expect(card('Single-request peak').querySelector('dd')).toHaveTextContent(/^0$/);
  });

  it('records tokens and reported costs without offering price or budget controls even with old zero budgets', async () => {
    const f = fixture({ events: [receipt({ reportedCostUSD: 5 })], rates: [{ providerId: 'synthetic-provider', model: 'synthetic-model', inputUSDPerMillion: 2, outputUSDPerMillion: 6, updatedAt: '2026-10-29T00:00:00.000Z' }], budget: { dailyRequestLimit: 0, dailyTokenLimit: 0 } });
    const view = render(<UsagePage api={f.api} locale="zh-CN" />);
    await screen.findByRole('region', { name: '请求记录' });
    expect(screen.getByRole('heading', { level: 1, name: 'Token 与费用' })).toBeVisible();
    expect(card('累计 Token').querySelector('dd')).toHaveTextContent('120');
    expect(view.container.querySelector('form')).toBeNull();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(view.container.textContent).not.toMatch(/预算|保存填写|输入价格|输出价格/u);
    expect(card('累计实报费用（USD）').querySelector('dd')).toHaveTextContent('$5.00');
    expect(card('累计估算费用（USD）').querySelector('dd')).toHaveTextContent('未知');
    expect(f.read).toHaveBeenCalledOnce();
  });

  it('retains the last authoritative snapshot when refresh fails instead of replacing it with a false empty or zero state', async () => {
    const f = fixture({ events: [receipt()], rates: [] }); render(<UsagePage api={f.api} locale="en" />);
    await screen.findByRole('region', { name: 'Request history' }); f.read.mockRejectedValueOnce(new Error('repository.commitUncertain'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh records' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('previously displayed data is retained');
    expect(card('Total tokens').querySelector('dd')).toHaveTextContent('120');
    expect(screen.queryByText('No saved provider request records.')).not.toBeInTheDocument();
  });

  it('shows complete coverage and parent batches as views without adding child usage twice', async () => {
    const f = fixture({ events: [receipt({ requestId: 'child-one', scope: 'delegation', batchId: 'synthetic-batch' }),
      receipt({ requestId: 'child-two', scope: 'delegation', batchId: 'synthetic-batch', outputTokens: null }),
      receipt({ requestId: 'not-sent', phase: 'prepared', dispatchedAt: null, terminalAt: null })], rates: [] });
    render(<UsagePage api={f.api} locale="en" />);
    const requests = await screen.findByRole('region', { name: 'Request history' }); expect(within(requests).getAllByRole('row')).toHaveLength(4);
    expect(card('Total tokens').querySelector('dd')).toHaveTextContent('220');
    expect(card('Single-request peak').querySelector('dd')).toHaveTextContent('120');
    expect(screen.getByText(/Requests with incomplete token counts: 1/)).toBeVisible();
    const batch = screen.getByRole('region', { name: 'Parent batches' }); expect(batch).toHaveTextContent('not added again');
    expect(within(batch).getByText('220')).toBeVisible(); expect(within(batch).getByText('Complete records: 1 / 2')).toBeVisible();
  });

  it('shows a real empty record state without inventing usage or a peak', async () => {
    const f = fixture({ events: [], rates: [] }); render(<UsagePage api={f.api} locale="en" />);
    expect(await screen.findByText('No saved provider request records.')).toBeVisible();
    expect(card('Total tokens').querySelector('dd')).toHaveTextContent(/^0$/);
    expect(card('Dispatched requests').querySelector('dd')).toHaveTextContent(/^0$/);
    expect(card('Single-request peak').querySelector('dd')).toHaveTextContent('Unknown');
    expect(screen.queryByRole('region', { name: 'By model' })).not.toBeInTheDocument();
  });

  it('does not publish a stale initial read after a later refresh has completed', async () => {
    let finish: ((value: UsageSnapshot) => void) | undefined;
    const f = fixture({ events: [receipt({ inputTokens: 777, outputTokens: 123 })], rates: [] });
    f.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<UsagePage api={f.api} locale="en" />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh records' })); await screen.findByRole('region', { name: 'Request history' });
    expect(card('Total tokens').querySelector('dd')).toHaveTextContent('900');
    await act(async () => finish?.({ events: [receipt({ inputTokens: 1, outputTokens: 2 })], rates: [] }));
    expect(card('Total tokens').querySelector('dd')).toHaveTextContent('900');
  });

  it('shows separate cumulative reported, estimated and unknown costs from read-only saved prices', async () => {
    const f = fixture({ events: [receipt({ requestId: 'reported', reportedCostUSD: 0.4, batchId: 'batch' }),
      receipt({ requestId: 'estimate', batchId: 'batch' }), receipt({ requestId: 'estimate', batchId: 'batch' }),
      receipt({ requestId: 'unpriced', providerId: 'unpriced-provider' })],
      rates: [{ providerId: 'synthetic-provider', model: 'synthetic-model', inputUSDPerMillion: 2, outputUSDPerMillion: 6, updatedAt: '2026-10-29T00:00:00.000Z' }] });
    const view = render(<UsagePage api={f.api} locale="en" />);
    await screen.findByRole('region', { name: 'Cost totals' });
    expect(card('Reported cost (USD)').querySelector('dd')).toHaveTextContent('$0.40');
    expect(card('Estimated cost (USD)').querySelector('dd')).toHaveTextContent('$0.00032');
    expect(card('Requests with unknown cost').querySelector('dd')).toHaveTextContent(/^1$/);
    expect(screen.getByText(/not historical invoices/)).toBeVisible();
    expect(card('Total tokens').querySelector('dd')).toHaveTextContent('360');
    const batch = screen.getByRole('region', { name: 'Parent batches' });
    expect(within(batch).getByText('$0.40')).toBeVisible(); expect(within(batch).getByText('$0.00032')).toBeVisible();
    expect(view.container.querySelector('form')).toBeNull(); expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('does not turn missing money data into zero and preserves an explicitly reported zero', async () => {
    const f = fixture({ events: [receipt()], rates: [] });
    render(<UsagePage api={f.api} locale="en" />); await screen.findByRole('region', { name: 'Cost totals' });
    expect(card('Reported cost (USD)').querySelector('dd')).toHaveTextContent('Unknown');
    expect(card('Estimated cost (USD)').querySelector('dd')).toHaveTextContent('Unknown');
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    f.replace({ events: [receipt({ reportedCostUSD: 0 })], rates: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh records' }));
    await waitFor(() => expect(card('Reported cost (USD)').querySelector('dd')).toHaveTextContent('$0.00'));
    expect(card('Requests with unknown cost').querySelector('dd')).toHaveTextContent(/^0$/);
    expect(card('Estimated cost (USD)').querySelector('dd')).toHaveTextContent('Unknown');
  });

});
