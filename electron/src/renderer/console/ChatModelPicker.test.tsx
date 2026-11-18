import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { DeskPetApi, ProviderConfig, ProviderModel } from '../../shared';
import { messages } from '../../shared';
import { ChatModelPicker } from './ChatModelPicker';

afterEach(cleanup);
const first: ProviderConfig = { id: '01234567-89ab-4def-8123-456789abcdef', kind: 'ollama', name: 'Local models', baseUrl: 'http://127.0.0.1:11434/v1', model: 'alpha', enabled: true, supportsTools: false, secretState: 'missing' };
const second: ProviderConfig = { ...first, id: '11234567-89ab-4def-8123-456789abcdef', name: 'Second service', model: 'gamma' };
const model = (id: string): ProviderModel => ({ id, displayName: id, contextWindow: null, supportsTools: false });
const t = (key: string) => messages.en[key as keyof typeof messages.en] ?? key;
const setup = (listModels = vi.fn<(id: string) => Promise<ProviderModel[]>>(async () => [model('alpha'), model('beta')])) => {
  let saved = [first, second]; let selected = first.id;
  const setModel = vi.fn(async (id: string, name: string) => { saved = saved.map((provider) => provider.id === id ? { ...provider, model: name } : provider); return saved.find((provider) => provider.id === id)!; });
  const select = vi.fn(async (id: string) => { selected = id; });
  Object.defineProperty(window, 'deskpet', { value: { providers: { setModel, select, listModels } } as unknown as DeskPetApi, configurable: true });
  const onSavingChange = vi.fn();
  const Harness = () => {
    const [providers, setProviders] = useState(saved); const [active, setActive] = useState(selected);
    return <ChatModelPicker providers={providers} provider={providers.find((provider) => provider.id === active)} running t={t} onSavingChange={onSavingChange} refresh={async () => { setProviders(saved); setActive(selected); }} />;
  };
  render(<Harness />);
  fireEvent.click(screen.getByText('Change'));
  return { setModel, select, listModels, onSavingChange };
};

it('allows a model switch during a reply and keeps the selection after refresh', async () => {
  const api = setup();
  await screen.findByRole('option', { name: /^beta ·/u });
  const picker = screen.getByRole('combobox', { name: 'Chat model' });
  expect(picker).toBeEnabled();
  expect(screen.getByText(/This reply keeps the model/u)).toBeInTheDocument();
  fireEvent.change(picker, { target: { value: 'beta' } });
  await waitFor(() => expect(picker).toHaveValue('beta'));
  expect(api.setModel).toHaveBeenCalledWith(first.id, 'beta');
  expect(api.onSavingChange.mock.calls).toEqual([[true], [false]]);
  expect(api.select).not.toHaveBeenCalled();
});

it('retains the current model on list/save failure and offers a manual model ID', async () => {
  const api = setup(vi.fn(async () => { throw new Error('Unavailable'); }));
  await screen.findByText(/model list is unavailable/u);
  expect(screen.getByRole('combobox', { name: 'Chat model' })).toHaveValue('alpha');
  fireEvent.click(screen.getByText('Enter a model ID'));
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'custom-model' } });
  api.setModel.mockRejectedValueOnce(new Error('Disk write failed'));
  fireEvent.click(screen.getByRole('button', { name: 'Use this model' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('combobox', { name: 'Chat model' })).toHaveValue('alpha');
  fireEvent.click(screen.getByRole('button', { name: 'Use this model' }));
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Chat model' })).toHaveValue('custom-model'));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('discards a model list that arrives after switching to another provider', async () => {
  let resolveFirst!: (models: ProviderModel[]) => void;
  setup(vi.fn((id: string) => id === first.id ? new Promise<ProviderModel[]>((resolve) => { resolveFirst = resolve; }) : Promise.resolve([model('gamma'), model('delta')])));
  fireEvent.change(screen.getByRole('combobox', { name: 'Chat provider' }), { target: { value: second.id } });
  await screen.findByRole('option', { name: /^delta ·/u });
  await act(async () => { resolveFirst([model('stale-model')]); });
  expect(screen.queryByRole('option', { name: /^stale-model ·/u })).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Chat model' })).toHaveValue('gamma');
});


it('reloads a same-config saved provider after a credential event without keeping prior prices or changing its selection', async () => {
  const provider = { ...first, secretState: 'configured' as const };
  const priced = (input: number): ProviderModel => ({ ...model('alpha'), pricing: { currency: 'USD', inputPerMillion: input, outputPerMillion: 5, source: 'provider-api', sourceUrl: 'https://catalog.example.invalid/models', checkedAt: '2026-10-30T00:00:00.000Z' } });
  let notify!: (items: ProviderConfig[]) => void, resolveStale!: (models: ProviderModel[]) => void;
  const listModels = vi.fn<DeskPetApi['providers']['listModels']>().mockResolvedValueOnce([priced(1), model('old-access')])
    .mockImplementationOnce(() => new Promise((done) => { resolveStale = done; })).mockResolvedValueOnce([priced(3), model('new-access')]);
  const unsubscribe = vi.fn(), setModel = vi.fn(), select = vi.fn();
  const onChanged = vi.fn((listener: typeof notify) => { notify = listener; return unsubscribe; });
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { providers: { listModels, setModel, select, onChanged } } as unknown as DeskPetApi });
  const view = render(<ChatModelPicker providers={[provider]} provider={provider} running={false} t={t} refresh={vi.fn(async () => undefined)} onSavingChange={vi.fn()} />);
  fireEvent.click(screen.getByText('Change'));
  await screen.findByRole('option', { name: /^old-access/u });
  expect(screen.getByText('USD Input 1 / Output 5 · per million tokens')).toBeInTheDocument();
  await act(async () => notify([provider]));
  expect(screen.queryByRole('option', { name: /^old-access/u })).not.toBeInTheDocument();
  expect(screen.queryByText('USD Input 1 / Output 5 · per million tokens')).not.toBeInTheDocument();
  await act(async () => notify([provider])); await screen.findByRole('option', { name: /^new-access/u });
  await act(async () => resolveStale([priced(2), model('stale-access')]));
  expect(screen.queryByRole('option', { name: /^stale-access/u })).not.toBeInTheDocument();
  expect(screen.getByText('USD Input 3 / Output 5 · per million tokens')).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Chat model' })).toHaveValue('alpha');
  expect(setModel).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
  view.unmount(); expect(unsubscribe).toHaveBeenCalledOnce();
  await act(async () => notify([provider])); expect(listModels).toHaveBeenCalledTimes(3);
});

it('keeps configuration collapsed until requested without losing model prices or selection', async () => {
  const listModels = vi.fn(async () => [model('alpha')]);
  Object.defineProperty(window, 'deskpet', { value: { providers: { listModels } } as unknown as DeskPetApi, configurable: true });
  const { container } = render(<ChatModelPicker providers={[first]} provider={first} running={false} t={t} refresh={vi.fn()} onSavingChange={vi.fn()} />);
  expect(container.querySelector('details')?.open).toBe(false);
  expect(screen.getByText('Local models · alpha')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Change'));
  expect(screen.getByRole('combobox', { name: 'Chat model' })).toHaveValue('alpha');
  await waitFor(() => expect(listModels).toHaveBeenCalledOnce());
  expect(screen.getByText('Price unknown', { selector: 'strong' })).toBeInTheDocument();
  fireEvent.click(screen.getByText('Change'));
  expect(container.querySelector('details')?.open).toBe(false);
  expect(listModels).toHaveBeenCalledOnce();
});
