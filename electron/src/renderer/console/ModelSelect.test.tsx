import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DeskPetApi, ProviderConfig, ProviderModel } from '../../shared';
import { BoundModelSelect, ModelSelect } from './ModelSelect';

afterEach(cleanup);
const model = (id: string): ProviderModel => ({ id, displayName: id, contextWindow: null, supportsTools: false });
const priced: ProviderModel = { ...model('priced'), availability: 'provider-listed', pricing: { currency: 'USD', inputPerMillion: 0, outputPerMillion: 1.25,
  source: 'provider-api', sourceUrl: 'https://example.invalid/models', checkedAt: '2026-10-30T00:00:00.000Z' } };

it('shows explicit zero, unknown, units and provenance without treating unknown as free', () => {
  render(<ModelSelect models={[priced, model('unknown')]} value="priced" onChange={vi.fn()} label="Model" />);
  expect(screen.getByRole('option', { name: /priced · USD Input 0 \/ Output 1.25 · per million tokens/u })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /unknown · Price unknown/u })).toBeInTheDocument();
  expect(screen.getByText(/Provider catalog price/u)).toHaveTextContent('2026-10-30');
  expect(screen.getByText('https://example.invalid/models')).toBeInTheDocument();
  expect(screen.getByText(/not a usage receipt/u)).toBeInTheDocument();
});

it('shows a caller-sanitized failure with the manual fallback, and keeps the generic error for existing callers', () => {
  const view = render(<ModelSelect models={[]} value="" onChange={vi.fn()} label="Model" failed failureMessage="Authentication was refused (401)." />);
  expect(screen.getByRole('status')).toHaveTextContent('Authentication was refused (401).');
  expect(screen.getByText(/model catalog could not be loaded/u)).toBeInTheDocument();
  expect(screen.getByText('Enter a model ID')).toBeInTheDocument();
  view.rerender(<ModelSelect models={[]} value="" onChange={vi.fn()} label="Model" failed />);
  expect(screen.getByRole('status')).toHaveTextContent(/model catalog could not be loaded/u);
  expect(screen.queryByText('Authentication was refused (401).')).not.toBeInTheDocument();
});

it('filters by id or display name while retaining current selection and never saves merely by searching', () => {
  const change = vi.fn(); render(<ModelSelect models={[priced, { ...model('alpha'), displayName: 'Fast answer' }, model('other')]} value="priced" onChange={change} label="Model" />);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Model Search models' }), { target: { value: 'fast' } });
  expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('priced');
  expect(screen.getByRole('option', { name: /^Fast answer/u })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /^other ·/u })).not.toBeInTheDocument();
  expect(change).not.toHaveBeenCalled();
});

it('accepts a manual model only after explicit use, while reference availability stays unverified', () => {
  const change = vi.fn(); render(<ModelSelect models={[{ ...priced, availability: 'reference' }]} value="priced" onChange={change} label="模型" locale="zh-CN" />);
  expect(screen.getByText('参考条目，尚未验证账户权限。')).toBeInTheDocument();
  fireEvent.click(screen.getByText('手动填写模型 ID'));
  fireEvent.change(screen.getByLabelText('模型 模型 ID'), { target: { value: 'manual-model' } });
  expect(change).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '使用这个模型' }));
  expect(change).toHaveBeenCalledExactlyOnceWith('manual-model');
});

it('invalidates late catalogs when a bound provider changes and never updates its saved model', async () => {
  const first: ProviderConfig = { id: crypto.randomUUID(), kind: 'ollama', name: 'one', baseUrl: 'http://127.0.0.1:11434/v1', model: 'alpha', enabled: true, supportsTools: false, secretState: 'missing' };
  const second = { ...first, id: crypto.randomUUID(), model: 'beta' };
  let resolve!: (models: ProviderModel[]) => void;
  const listModels = vi.fn((id: string) => id === first.id ? new Promise<ProviderModel[]>((done) => { resolve = done; }) : Promise.resolve([model('beta'), model('second-only')]));
  const setModel = vi.fn(); Object.defineProperty(window, 'deskpet', { configurable: true, value: { providers: { listModels, setModel } } as unknown as DeskPetApi });
  const change = vi.fn(); const view = render(<BoundModelSelect provider={first} value="alpha" onChange={change} label="Child model" locale="en" />);
  view.rerender(<BoundModelSelect provider={second} value="beta" onChange={change} label="Child model" locale="en" />);
  const picker = await screen.findByRole('combobox', { name: 'Child model' });
  await screen.findByRole('option', { name: /^second-only ·/u });
  await act(async () => resolve([model('stale')]));
  expect(within(picker).queryByRole('option', { name: /^stale ·/u })).not.toBeInTheDocument();
  fireEvent.change(picker, { target: { value: 'second-only' } }); expect(change).toHaveBeenCalledExactlyOnceWith('second-only');
  expect(setModel).not.toHaveBeenCalled();
});

it('prevents search or manual Enter from submitting an enclosing delegation form', () => {
  const change = vi.fn(), submit = vi.fn();
  render(<form onSubmit={submit}><ModelSelect models={[priced]} value="priced" onChange={change} label="Child model" /><button type="submit">Submit batch</button></form>);
  const searchEnter = createEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter', cancelable: true });
  fireEvent(screen.getByRole('searchbox'), searchEnter); expect(searchEnter.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByText('Enter a model ID'));
  const input = screen.getByLabelText('Child model Model ID'); fireEvent.change(input, { target: { value: 'child-new-model' } });
  const manualEnter = createEvent.keyDown(input, { key: 'Enter', cancelable: true }); fireEvent(input, manualEnter);
  expect(manualEnter.defaultPrevented).toBe(true); expect(change).toHaveBeenCalledExactlyOnceWith('child-new-model');
  expect(submit).not.toHaveBeenCalled();
});


it('invalidates a completed bound catalog on a same-config credential event, ignores late results and cleans up the listener', async () => {
  const provider: ProviderConfig = { id: crypto.randomUUID(), kind: 'openai', name: 'saved', baseUrl: 'https://api.openai.com/v1', model: 'alpha', enabled: true, supportsTools: false, secretState: 'configured' };
  const pricedAlpha = (input: number): ProviderModel => ({ ...priced, id: 'alpha', displayName: 'alpha', pricing: { ...priced.pricing!, inputPerMillion: input } });
  let notify!: (items: ProviderConfig[]) => void, resolveStale!: (models: ProviderModel[]) => void;
  const listModels = vi.fn<DeskPetApi['providers']['listModels']>().mockResolvedValueOnce([pricedAlpha(1), model('old-only')])
    .mockImplementationOnce(() => new Promise((done) => { resolveStale = done; })).mockResolvedValueOnce([pricedAlpha(3), model('new-only')]);
  const unsubscribe = vi.fn(), setModel = vi.fn(), change = vi.fn();
  const onChanged = vi.fn((listener: typeof notify) => { notify = listener; return unsubscribe; });
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { providers: { listModels, setModel, onChanged } } as unknown as DeskPetApi });
  const view = render(<BoundModelSelect provider={provider} value="alpha" onChange={change} label="Subagent model" locale="en" />);
  await screen.findByRole('option', { name: /^old-only/u });
  expect(screen.getByText('USD Input 1 / Output 1.25 · per million tokens')).toBeInTheDocument();
  await act(async () => notify([provider]));
  expect(screen.queryByRole('option', { name: /^old-only/u })).not.toBeInTheDocument();
  expect(screen.queryByText('USD Input 1 / Output 1.25 · per million tokens')).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Subagent model' })).toHaveValue('alpha');
  await act(async () => notify([provider])); await screen.findByRole('option', { name: /^new-only/u });
  await act(async () => resolveStale([pricedAlpha(2), model('stale-only')]));
  expect(screen.queryByRole('option', { name: /^stale-only/u })).not.toBeInTheDocument();
  expect(screen.getByText('USD Input 3 / Output 1.25 · per million tokens')).toBeInTheDocument();
  expect(change).not.toHaveBeenCalled(); expect(setModel).not.toHaveBeenCalled();
  view.unmount(); expect(unsubscribe).toHaveBeenCalledOnce();
  await act(async () => notify([provider])); expect(listModels).toHaveBeenCalledTimes(3);
});
