import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig, UsageAPI, UsageEvent, UsageRateInput, UsageSnapshot } from '../../shared';
import { UsagePage } from './UsagePage';

const provider: ProviderConfig = { id: '00000000-0000-4000-8000-000000000001', kind: 'openai-compatible', name: 'Fixture proxy', baseUrl: 'https://fixture.example/v1',
  model: 'fixture-model', supportsTools: false, enabled: true, secretState: 'missing' };
const event: UsageEvent = { requestId: 'fixture-request', ownerId: 'fixture-owner', scope: 'chat', batchId: null, providerId: provider.id, model: provider.model,
  preparedAt: '2026-11-02T00:00:00.000Z', dispatchedAt: '2026-11-02T00:00:01.000Z', terminalAt: '2026-11-02T00:00:02.000Z', phase: 'terminal', outcome: 'completed',
  inputEstimate: 120, maxOutputTokens: 512, inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400, cacheWriteInputTokens: 100,
  reasoningOutputTokens: 80, tokenSource: 'provider-reported', reportedCostUSD: null, endpoint: provider.baseUrl };
const fixture = () => {
  let snapshot: UsageSnapshot = { events: [event], rates: [] };
  const snapshotFn = vi.fn(async () => structuredClone(snapshot));
  const upsertRate = vi.fn(async (input: UsageRateInput) => {
    const { providerId, model, ...price } = input;
    snapshot = { ...snapshot, rates: [{ providerId, model, price: { ...price, endpoint: provider.baseUrl, source: 'manual', checkedAt: '2026-11-02T01:00:00.000Z' }, updatedAt: '2026-11-02T01:00:00.000Z' }] };
    return structuredClone(snapshot);
  });
  const removeRate = vi.fn(async () => { snapshot = { ...snapshot, rates: [] }; return structuredClone(snapshot); });
  const api: UsageAPI = { snapshot: snapshotFn, upsertRate, removeRate };
  return { api, upsertRate, removeRate, snapshotFn };
};
const open = async (api: UsageAPI, locale = 'en') => {
  const view = render(<UsagePage api={api} providers={[provider]} locale={locale} />);
  await screen.findByRole('region', { name: locale === 'en' ? 'Request history' : '请求记录' });
  fireEvent.click(screen.getByText(locale === 'en' ? 'Model prices' : '模型费率', { selector: 'summary' }));
  return view;
};
afterEach(cleanup);

describe('manual prices and explicit cost explanations', () => {
  it('saves an exact custom tariff and immediately supplements eligible old requests with correctly partitioned cache costs', async () => {
    const f = fixture(); await open(f.api);
    expect(screen.getByText('No price for this model and endpoint')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Input / million tokens'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Output / million tokens'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Cache read / million tokens'), { target: { value: '0.2' } });
    fireEvent.change(screen.getByLabelText('Cache write / million tokens'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save custom price' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Custom price saved');
    expect(f.upsertRate).toHaveBeenCalledWith({ providerId: provider.id, model: provider.model, currency: 'USD', inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 0.2, cacheWriteInputPerMillion: 2.5 });
    const requests = screen.getByRole('region', { name: 'Request history' });
    expect(within(requests).getByText('$0.00333')).toBeVisible();
    expect(within(requests).getByText('Supplement at current price')).toBeVisible();
    expect(within(requests).getByText('Reasoning (included in output): 80')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Remove custom price' }));
    await waitFor(() => expect(f.removeRate).toHaveBeenCalledWith({ providerId: provider.id, model: provider.model }));
    expect(await screen.findByText('No price for this model and endpoint')).toBeVisible();
  });

  it('retains unknown cache prices as null, displays a missing-cache-rate reason, and never substitutes free cache tokens', async () => {
    const f = fixture(); await open(f.api, 'zh-CN');
    fireEvent.change(screen.getByLabelText('输入单价／百万 Token'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('输出单价／百万 Token'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: '保存自定义费率' }));
    await screen.findByRole('status');
    expect(f.upsertRate.mock.calls[0]?.[0]).toMatchObject({ cachedInputPerMillion: null, cacheWriteInputPerMillion: null });
    expect(screen.getByText('已返回缓存用量，但缺少对应单价')).toBeVisible();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('keeps a rejected edit visible for retry and retains the authoritative displayed usage', async () => {
    const f = fixture(); f.upsertRate.mockRejectedValueOnce(new Error('repository.commitUncertain'));
    await open(f.api);
    fireEvent.change(screen.getByLabelText('Input / million tokens'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Output / million tokens'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save custom price' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Saved records are retained');
    expect(screen.getByLabelText('Input / million tokens')).toHaveValue(2);
    expect(screen.getByText('Total tokens', { selector: 'dt' }).parentElement?.querySelector('dd')).toHaveTextContent('1,200');
    expect(screen.getByText('No price for this model and endpoint')).toBeVisible();
  });

  it('offers an unbound legacy price for editing without claiming it applies to the current endpoint', async () => {
    const f = fixture();
    f.snapshotFn.mockResolvedValueOnce({ events: [event], rates: [{ providerId: provider.id, model: provider.model, inputUSDPerMillion: 2, outputUSDPerMillion: 10, updatedAt: '2026-10-30T00:00:00.000Z' }] });
    await open(f.api);
    expect(screen.getByText('An older custom price has no saved endpoint. Fill and save it to bind it to this endpoint.')).toBeVisible();
    expect(screen.queryByText('Custom price · USD')).not.toBeInTheDocument();
    expect(screen.getByText('No automatic or custom price for this model and endpoint.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Fill from older price' }));
    expect(screen.getByLabelText('Input / million tokens')).toHaveValue(2);
    expect(screen.getByLabelText('Output / million tokens')).toHaveValue(10);
    expect(f.upsertRate).not.toHaveBeenCalled();
  });

  it('shows CNY separately, preserves request snapshots after rate edits, and explains missing output usage', async () => {
    const f = fixture();
    const frozen = { currency: 'CNY' as const, inputPerMillion: 8, outputPerMillion: 28, cachedInputPerMillion: 2, cacheWriteInputPerMillion: 8,
      source: 'reference' as const, checkedAt: '2026-11-02T00:00:00.000Z', endpoint: provider.baseUrl, sourceUrl: 'https://reference.example/pricing' };
    f.snapshotFn.mockResolvedValueOnce({ events: [{ ...event, priceSnapshot: frozen }, { ...event, requestId: 'incomplete', outputTokens: null }], rates: [] });
    await open(f.api);
    expect(screen.getByText('Estimated cost (CNY)', { selector: 'dt' }).parentElement?.querySelector('dd')).toHaveTextContent('¥0.0112 CNY');
    expect(screen.getByText('Estimated cost (USD)', { selector: 'dt' }).parentElement?.querySelector('dd')).toHaveTextContent('Unknown');
    expect(screen.getByText('Provider did not return output tokens')).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Request history' })).getByText('Request-time price')).toBeVisible();
  });
});
