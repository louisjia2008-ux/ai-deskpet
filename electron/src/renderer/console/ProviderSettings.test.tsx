import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DeskPetApi, ProviderConfig, ProviderModel } from '../../shared';
import { messages } from '../../shared';
import { providerSetupText } from '../../shared/provider-setup-i18n';
import { ProviderSettings } from './ProviderSettings';

afterEach(cleanup);
const t = (key: string): string => messages.en[key as keyof typeof messages.en] ?? key;
const model: ProviderModel = { id: 'synthetic-model', displayName: 'Synthetic model', contextWindow: 32768, supportsTools: false, availability: 'provider-listed',
  pricing: { currency: 'USD', inputPerMillion: .5, outputPerMillion: 1.5, source: 'provider-api', sourceUrl: 'https://example.invalid/models', checkedAt: '2026-10-30T00:00:00.000Z' } };
const existing: ProviderConfig = { id: crypto.randomUUID(), name: 'Saved provider', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'saved-model', enabled: true, supportsTools: false, secretState: 'configured' };
const setup = (providers: ProviderConfig[] = []) => {
  const discoverModels = vi.fn<DeskPetApi['providers']['discoverModels']>(async () => [model]);
  const upsert = vi.fn(async (input) => ({ ...input, secretState: 'configured' }));
  const listModels = vi.fn(async () => [model]); const setModel = vi.fn();
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { providers: { discoverModels, upsert, listModels, setModel } } as unknown as DeskPetApi });
  const refresh = vi.fn(async () => undefined);
  render(<ProviderSettings providers={providers} activeId={null} t={t} refresh={refresh} />);
  return { discoverModels, upsert, setModel, refresh };
};
const form = () => screen.getByRole('form', { name: 'Connect a provider' });
const unverified = providerSetupText('en')('provider.modelUnverified');

it('loads a catalog from the entered key and saves only the explicitly selected model', async () => {
  const api = setup();
  expect(screen.getByRole('button', { name: 'Load available models' })).toBeDisabled();
  fireEvent.change(within(form()).getByLabelText('API key'), { target: { value: 'synthetic-key-only' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load available models' }));
  await screen.findByRole('option', { name: /^Synthetic model/u });
  expect(api.discoverModels).toHaveBeenCalledExactlyOnceWith({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-key-only' });
  expect(api.upsert).not.toHaveBeenCalled();
  fireEvent.change(within(form()).getByRole('combobox', { name: 'Model' }), { target: { value: model.id } });
  expect(screen.getByText('USD Input 0.5 / Output 1.5 · per million tokens')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
  await waitFor(() => expect(api.upsert).toHaveBeenCalledOnce());
  expect(api.upsert.mock.calls[0]![0]).toMatchObject({ kind: 'openai', model: model.id, apiKey: 'synthetic-key-only', name: 'OpenAI' });
});

it('keeps local setup keyless and offers an explicit manual fallback after discovery fails', async () => {
  const api = setup(); api.discoverModels.mockRejectedValueOnce(new Error('raw synthetic server diagnostic must not render'));
  fireEvent.change(within(form()).getByLabelText('Provider type'), { target: { value: 'ollama' } });
  expect(within(form()).queryByLabelText('API key')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load available models' }));
  await screen.findByText(/model catalog could not be loaded/u);
  expect(screen.queryByText(/raw synthetic server/u)).not.toBeInTheDocument();
  fireEvent.click(within(form()).getByText('Enter a model ID'));
  fireEvent.change(within(form()).getByLabelText('Model Model ID'), { target: { value: 'manual-local' } });
  expect(api.upsert).not.toHaveBeenCalled(); fireEvent.click(within(form()).getByRole('button', { name: 'Use this model' }));
  expect(within(form()).getByText(/Device-only memories are withheld/u)).toBeInTheDocument();
  expect(within(form()).getByLabelText('This model runs on this device')).not.toBeChecked();
  fireEvent.click(within(form()).getByText('Advanced connection settings'));
  fireEvent.change(within(form()).getByLabelText('Ollama context to load (tokens)'), { target: { value: '8192' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
  await waitFor(() => expect(api.upsert).toHaveBeenCalledOnce());
  expect(api.upsert.mock.calls[0]![0]).toMatchObject({ kind: 'ollama', model: 'manual-local', ollamaNumCtx: 8192 });
  expect(api.upsert.mock.calls[0]![0]).not.toHaveProperty('apiKey');
});

it('uses an existing secret only for the unchanged endpoint and requires a new key after changing it', async () => {
  const api = setup([existing]); fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'Load available models' }));
  await screen.findByRole('option', { name: /^Synthetic model/u });
  expect(api.discoverModels).toHaveBeenCalledExactlyOnceWith({ kind: existing.kind, baseUrl: existing.baseUrl, existingProviderId: existing.id });
  fireEvent.click(screen.getByText('Advanced connection settings'));
  fireEvent.change(within(form()).getByLabelText('Base URL'), { target: { value: 'https://other.example.invalid/v1' } });
  expect(screen.getByRole('button', { name: 'Load available models' })).toBeDisabled();
  expect(within(form()).getByRole('combobox', { name: 'Model' })).toHaveValue('');
  expect(screen.getByText(/saved key will not be sent/u)).toBeInTheDocument();
  fireEvent.change(within(form()).getByLabelText('API key'), { target: { value: 'new-synthetic-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load available models' }));
  await waitFor(() => expect(api.discoverModels).toHaveBeenCalledTimes(2));
  expect(api.discoverModels.mock.calls[1]![0]).toEqual({ kind: 'openai', baseUrl: 'https://other.example.invalid/v1', apiKey: 'new-synthetic-key' });
});

it('drops a late draft catalog after the user changes the key and does not save or pick a stale model', async () => {
  const api = setup(); let resolve!: (models: ProviderModel[]) => void;
  api.discoverModels.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const key = within(form()).getByLabelText('API key'); fireEvent.change(key, { target: { value: 'first-synthetic-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load available models' }));
  fireEvent.change(key, { target: { value: 'second-synthetic-key' } });
  await act(async () => resolve([model]));
  expect(screen.queryByRole('option', { name: /^Synthetic model/u })).not.toBeInTheDocument();
  expect(within(form()).getByRole('combobox', { name: 'Model' })).toHaveValue('');
  expect(api.upsert).not.toHaveBeenCalled();
});

it('keeps the entered model and key available when saving fails without displaying the server body', async () => {
  const api = setup(); api.upsert.mockRejectedValueOnce(new Error('private upstream body'));
  fireEvent.change(within(form()).getByLabelText('API key'), { target: { value: 'synthetic-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load available models' })); await screen.findByRole('option', { name: /^Synthetic model/u });
  fireEvent.change(within(form()).getByRole('combobox', { name: 'Model' }), { target: { value: model.id } });
  fireEvent.click(screen.getByRole('button', { name: 'Save provider' })); await screen.findByRole('alert');
  expect(within(form()).getByRole('combobox', { name: 'Model' })).toHaveValue(model.id);
  expect(within(form()).getByLabelText('API key')).toHaveValue('synthetic-key');
  expect(screen.queryByText('private upstream body')).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(/save|stor|config/iu);
});

it('can replace a saved key at the same endpoint without clearing or rediscovering the explicit model', async () => {
  const api = setup([existing]); fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(within(form()).getByRole('combobox', { name: 'Model' })).toHaveValue(existing.model);
  fireEvent.change(within(form()).getByLabelText('API key'), { target: { value: 'synthetic-replacement-only' } });
  expect(within(form()).getByRole('combobox', { name: 'Model' })).toHaveValue(existing.model);
  expect(screen.getByText(unverified)).toBeInTheDocument();
  expect(within(form()).getByRole('button', { name: /^Save$/u })).toBeEnabled();
  fireEvent.click(within(form()).getByRole('button', { name: /^Save$/u }));
  await waitFor(() => expect(api.upsert).toHaveBeenCalledOnce());
  expect(api.upsert.mock.calls[0]![0]).toMatchObject({ id: existing.id, kind: 'openai', baseUrl: existing.baseUrl, model: existing.model, apiKey: 'synthetic-replacement-only' });
  expect(api.discoverModels).not.toHaveBeenCalled(); expect(api.setModel).not.toHaveBeenCalled();
});

it('retains the explicit model while replacing a key, drops old prices and late results, and clears the warning only after a current catalog returns', async () => {
  const api = setup([existing]); fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'Load available models' })); await screen.findByRole('option', { name: /^Synthetic model/u });
  fireEvent.change(within(form()).getByRole('combobox', { name: 'Model' }), { target: { value: model.id } });
  expect(screen.getByText('USD Input 0.5 / Output 1.5 · per million tokens')).toBeInTheDocument();
  const key = within(form()).getByLabelText('API key');
  fireEvent.change(key, { target: { value: 'synthetic-second-key' } });
  expect(within(form()).getByRole('combobox', { name: 'Model' })).toHaveValue(model.id);
  expect(screen.queryByText('USD Input 0.5 / Output 1.5 · per million tokens')).not.toBeInTheDocument();
  expect(screen.getByText(unverified)).toBeInTheDocument();
  let resolve!: (items: ProviderModel[]) => void;
  api.discoverModels.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  fireEvent.click(screen.getByRole('button', { name: 'Load available models' }));
  fireEvent.change(key, { target: { value: 'synthetic-third-key' } });
  await act(async () => resolve([{ ...model, id: 'stale-model', displayName: 'Stale model' }]));
  expect(screen.queryByRole('option', { name: /^Stale model/u })).not.toBeInTheDocument();
  expect(screen.getByText(unverified)).toBeInTheDocument();
  expect(within(form()).getByRole('combobox', { name: 'Model' })).toHaveValue(model.id);
  fireEvent.click(screen.getByRole('button', { name: 'Load available models' })); await screen.findByRole('option', { name: /^Synthetic model/u });
  expect(screen.queryByText(unverified)).not.toBeInTheDocument();
  expect(api.discoverModels.mock.calls.at(-1)![0]).toMatchObject({ apiKey: 'synthetic-third-key' });
  expect(api.upsert).not.toHaveBeenCalled();
});

it.each([
  { label: 'only another model', models: [model] },
  { label: 'an empty catalog', models: [] as ProviderModel[] },
])('keeps the saved model unverified when a replacement key returns $label', async ({ models }) => {
  const api = setup([existing]); api.discoverModels.mockResolvedValueOnce(models);
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(within(form()).getByLabelText('API key'), { target: { value: 'synthetic-unlisted-model-key' } });
  const load = screen.getByRole('button', { name: 'Load available models' }); fireEvent.click(load);
  await waitFor(() => expect(load).toBeEnabled());
  expect(api.discoverModels).toHaveBeenCalledOnce();
  expect(within(form()).getByRole('combobox', { name: 'Model' })).toHaveValue(existing.model);
  expect(screen.getByText(unverified)).toBeInTheDocument();
  expect(within(form()).getByRole('button', { name: /^Save$/u })).toBeEnabled();
  expect(api.upsert).not.toHaveBeenCalled();
});

it.each([
  ['provider.authentication', /401/u],
  ['provider.permissionDenied', /403/u],
  ['provider.network', /HTTP/u],
] as const)('shows a safe classified Electron catalog rejection for %s while keeping manual fallback', async (code, expected) => {
  const api = setup();
  api.discoverModels.mockRejectedValueOnce(new Error(`Error invoking remote method 'providers:discover-models': Error: ${code}`));
  fireEvent.change(within(form()).getByLabelText('API key'), { target: { value: 'synthetic-failure-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load available models' }));
  const status = await screen.findByRole('status');
  expect(status).toHaveTextContent(code); expect(status).toHaveTextContent(expected);
  expect(screen.getByText(/model catalog could not be loaded/u)).toBeInTheDocument();
  expect(screen.getByText('Enter a model ID')).toBeInTheDocument();
  expect(document.body.textContent).not.toContain('Error invoking remote method');
  expect(within(form()).getByLabelText('API key')).toHaveValue('synthetic-failure-key');
  expect(api.upsert).not.toHaveBeenCalled();
});

it('does not render sensitive text or extract a code embedded in an unknown catalog error', async () => {
  const api = setup(); const marker = 'SYNTHETIC_PRIVATE_UPSTREAM_MARKER';
  api.discoverModels.mockRejectedValueOnce(new Error(`Error invoking remote method 'providers:discover-models': Error: provider.authentication ${marker}`));
  fireEvent.change(within(form()).getByLabelText('API key'), { target: { value: 'synthetic-only' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load available models' }));
  await screen.findByText(/model catalog could not be loaded/u);
  expect(document.body.textContent).not.toContain(marker); expect(document.body.textContent).not.toContain('provider.authentication');
});

it('uses a local save failure explanation, preserves the key/model draft and does not turn another IPC channel into a catalog diagnosis', async () => {
  const api = setup([existing]); const marker = 'SYNTHETIC_PRIVATE_SAVE_DETAIL';
  api.upsert.mockRejectedValueOnce(new Error(`Error invoking remote method 'providers:discover-models': Error: provider.authentication ${marker}`));
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(within(form()).getByLabelText('API key'), { target: { value: 'synthetic-retry-key' } });
  fireEvent.click(within(form()).getByRole('button', { name: /^Save$/u }));
  const alert = await screen.findByRole('alert'); expect(alert).toHaveTextContent(/save|stor|config/iu);
  expect(document.body.textContent).not.toContain(marker); expect(alert).not.toHaveTextContent('provider.authentication');
  expect(within(form()).getByRole('combobox', { name: 'Model' })).toHaveValue(existing.model);
  expect(within(form()).getByLabelText('API key')).toHaveValue('synthetic-retry-key');
  await waitFor(() => expect(within(form()).getByRole('button', { name: /^Save$/u })).toBeEnabled());
});


it.each(['ollama', 'lm-studio'] as const)('accepts an optional %s API key from advanced settings without saving it during discovery', async (kind) => {
  const api = setup();
  fireEvent.change(within(form()).getByLabelText('Provider type'), { target: { value: kind } });
  expect(screen.getByRole('button', { name: 'Load available models' })).toBeEnabled();
  fireEvent.click(screen.getByText('Advanced connection settings'));
  fireEvent.change(within(form()).getByLabelText('API key (optional)'), { target: { value: 'synthetic-local-token' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load available models' })); await screen.findByRole('option', { name: /^Synthetic model/u });
  expect(api.discoverModels).toHaveBeenCalledExactlyOnceWith({ kind, baseUrl: kind === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:1234/v1', apiKey: 'synthetic-local-token' });
  expect(api.upsert).not.toHaveBeenCalled();
  fireEvent.change(within(form()).getByRole('combobox', { name: 'Model' }), { target: { value: model.id } });
  fireEvent.click(screen.getByRole('button', { name: 'Save provider' })); await waitFor(() => expect(api.upsert).toHaveBeenCalledOnce());
  expect(api.upsert.mock.calls[0]![0]).toMatchObject({ kind, apiKey: 'synthetic-local-token', model: model.id });
});

it.each(['ollama', 'lm-studio'] as const)('preserves the saved %s token only for its endpoint and invalidates a late catalog after replacing it', async (kind) => {
  const local: ProviderConfig = { ...existing, kind, baseUrl: 'http://127.0.0.1:19420/v1' };
  const api = setup([local]); fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'Load available models' })); await screen.findByRole('option', { name: /^Synthetic model/u });
  expect(api.discoverModels).toHaveBeenCalledExactlyOnceWith({ kind, baseUrl: local.baseUrl, existingProviderId: local.id });
  fireEvent.click(screen.getByText('Advanced connection settings'));
  fireEvent.change(within(form()).getByLabelText('Base URL'), { target: { value: 'http://127.0.0.1:19421/v1' } });
  expect(screen.getByRole('button', { name: 'Load available models' })).toBeDisabled();
  expect(screen.getByText(/saved key will not be sent/u)).toBeInTheDocument();
  const key = within(form()).getByLabelText('API key (optional)'); fireEvent.change(key, { target: { value: 'new-local-token' } });
  let resolve!: (models: ProviderModel[]) => void; api.discoverModels.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  fireEvent.click(screen.getByRole('button', { name: 'Load available models' }));
  expect(api.discoverModels.mock.calls[1]![0]).toEqual({ kind, baseUrl: 'http://127.0.0.1:19421/v1', apiKey: 'new-local-token' });
  fireEvent.change(key, { target: { value: 'changed-local-token' } }); await act(async () => resolve([model]));
  expect(screen.queryByRole('option', { name: /^Synthetic model/u })).not.toBeInTheDocument();
  expect(within(form()).getByRole('combobox', { name: 'Model' })).toHaveValue(''); expect(api.upsert).not.toHaveBeenCalled();
});
