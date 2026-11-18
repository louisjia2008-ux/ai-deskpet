import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DeskPetApi, ProviderConfig } from '../../shared';
import { defaultPluginSettings } from '../../shared/plugins';
import type { PluginState } from '../../shared/plugins';
import type { ReaResult, ReaTarget } from '../../shared/rea';
import { PluginsSettings } from './PluginsSettings';

const sessionId = '00000000-0000-4000-8000-000000000010';
const target: ReaTarget = { id: 'target', sessionId, name: 'synthetic-app', files: 1, bytes: 20, identitySHA256: 'a'.repeat(64), kind: 'directory' };
const result: ReaResult = { id: 'result', targetId: target.id, sessionId, targetIdentitySHA256: target.identitySHA256, tool: 'analyze_javascript_application', text: 'Synthetic retained analysis', truncated: false, untrusted: true, privacy: 'local-only' };
const local: ProviderConfig = { id: '00000000-0000-4000-8000-000000000020', name: 'Local Qwen', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen-synthetic', enabled: true, supportsTools: true, secretState: 'missing', localExecutionConfirmed: true };
afterEach(cleanup);
const setup = (options: { providers?: ProviderConfig[]; ready?: boolean; tokenSaved?: boolean; zh?: boolean } = {}) => {
  let state: PluginState = { settings: defaultPluginSettings(), crawl4aiTokenConfigured: options.tokenSaved ?? false };
  const ready = { available: true, version: '6.8.0', active: false, verified: true, reasonCode: 'rea.ready' };
  const unchecked = { available: false, version: null, active: false, verified: false, reasonCode: 'rea.runtimeNotChecked' };
  const getState = vi.fn(async () => structuredClone(state));
  const configure = vi.fn<DeskPetApi['plugins']['configure']>(async (input) => {
    state = { settings: input.settings, crawl4aiTokenConfigured: input.clearCrawl4aiToken ? false : !!input.crawl4aiToken || state.crawl4aiTokenConfigured };
    return structuredClone(state);
  });
  const test = vi.fn<DeskPetApi['plugins']['test']>(async ({ kind }) => ({ kind, ok: true, code: 'plugin.ok', checkedAt: '2026-11-02T01:00:00Z', resultCount: 2, excerpt: 'Synthetic public test result' }));
  const status = vi.fn(async () => options.ready ? ready : unchecked);
  const checkRuntime = vi.fn<DeskPetApi['rea']['checkRuntime']>(async () => ready);
  const chooseTarget = vi.fn(async () => target);
  const analyze = vi.fn(async () => result);
  const inspect = vi.fn(async () => ({ ...result, text: 'Synthetic module view' }));
  const cancel = vi.fn(async () => undefined);
  const ask = vi.fn(async () => ({ runId: 'synthetic-run' }));
  const createSession = vi.fn(async () => ({ id: sessionId, title: 'REA static analysis', kind: 'normal' }));
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { plugins: { getState, configure, test }, rea: { status, checkRuntime, chooseTarget, analyze, inspect, cancel, ask }, chat: { createSession } } as unknown as DeskPetApi });
  const onPermissions = vi.fn(); const onOpenSession = vi.fn(); const refresh = vi.fn(async () => undefined);
  const view = render(<PluginsSettings locale={options.zh ? 'zh-CN' : 'en'} providers={options.providers ?? []} onPermissions={onPermissions} onOpenSession={onOpenSession} refresh={refresh} />);
  return { ...view, getState, configure, test, status, checkRuntime, chooseTarget, analyze, inspect, cancel, ask, createSession, onPermissions, onOpenSession };
};

it('saves explicitly configured endpoints before testing and preserves an unchanged stored token', async () => {
  const api = setup({ tokenSaved: true });
  await screen.findByRole('checkbox', { name: 'Enable web plugin' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enable web plugin' }));
  fireEvent.change(screen.getByLabelText('SearXNG service URL'), { target: { value: 'http://127.0.0.1:8888' } });
  expect(screen.getByRole('button', { name: 'Test search' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save plugin settings' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Test search' })).toBeEnabled());
  expect(api.configure.mock.calls[0]![0]).toMatchObject({ settings: { web: { enabled: true, searxngUrl: 'http://127.0.0.1:8888' } } });
  expect(api.configure.mock.calls[0]![0]).not.toHaveProperty('crawl4aiToken');
  fireEvent.click(screen.getByRole('button', { name: 'Test search' }));
  await screen.findByText('Search test passed');
  expect(api.test).toHaveBeenCalledExactlyOnceWith({ kind: 'searxng' });
});

it('validates local service origins and never displays upstream raw errors', async () => {
  const api = setup();
  await screen.findByLabelText('SearXNG service URL');
  fireEvent.change(screen.getByLabelText('SearXNG service URL'), { target: { value: 'https://private-secret@example.com/' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save plugin settings' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/Only localhost/u);
  expect(api.configure).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('SearXNG service URL'), { target: { value: 'http://127.0.0.1:8080' } });
  api.test.mockRejectedValueOnce(new Error('private-upstream-secret-must-not-render'));
  fireEvent.click(screen.getByRole('button', { name: 'Test page reading' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/local service is running/u);
  expect(screen.queryByText(/private-upstream-secret/u)).not.toBeInTheDocument();
});

it('clears stored credentials only through an explicit removal and resets connection test results after edits', async () => {
  const api = setup({ tokenSaved: true });
  await screen.findByRole('button', { name: 'Test search' });
  fireEvent.click(screen.getByRole('button', { name: 'Test search' })); await screen.findByText('Search test passed');
  fireEvent.click(screen.getByLabelText('Remove saved Crawl4AI token'));
  expect(screen.queryByText('Search test passed')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save plugin settings' }));
  await waitFor(() => expect(api.configure).toHaveBeenCalledOnce());
  expect(api.configure.mock.calls[0]![0]).toMatchObject({ clearCrawl4aiToken: true });
  expect(api.configure.mock.calls[0]![0]).not.toHaveProperty('crawl4aiToken');
});

it('checks an unavailable runtime, starts a separate analysis session and explains the missing local model', async () => {
  const api = setup();
  await screen.findByText('Needs a check');
  expect(screen.getByRole('button', { name: 'Start static analysis' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Check runtime' }));
  await screen.findByText('Runtime ready · 6.8.0');
  expect(api.checkRuntime).toHaveBeenCalledOnce();
  api.status.mockResolvedValue({ available: true, version: '6.8.0', active: false, verified: true, reasonCode: 'rea.ready' });
  fireEvent.click(screen.getByRole('button', { name: 'Start static analysis' }));
  const workspace = await screen.findByRole('region', { name: 'REA analysis workspace' });
  expect(api.createSession).toHaveBeenCalledExactlyOnceWith({ title: 'REA static analysis', kind: 'normal' });
  await waitFor(() => expect(within(workspace).getByRole('button', { name: 'Choose analysis target' })).toBeEnabled());
  fireEvent.click(within(workspace).getByRole('button', { name: 'Choose analysis target' }));
  await waitFor(() => expect(within(workspace).getByRole('button', { name: 'Run static analysis' })).toBeEnabled());
  fireEvent.click(within(workspace).getByRole('button', { name: 'Run static analysis' }));
  await within(workspace).findByText('Synthetic retained analysis');
  expect(api.chooseTarget).toHaveBeenCalledExactlyOnceWith({ sessionId });
  expect(within(workspace).getByText(/configure a provider and confirm/u)).toBeInTheDocument();
  expect(within(workspace).getByRole('button', { name: 'Ask local model about selected result' })).toBeDisabled();
  api.unmount(); await waitFor(() => expect(api.cancel).toHaveBeenCalledWith({ sessionId }));
});

it('offers only confirmed local models and opens the independent interpretation conversation', async () => {
  const api = setup({ ready: true, providers: [local, { ...local, id: 'cloud', name: 'Cloud proxy', baseUrl: 'https://example.com/v1' }, { ...local, id: 'unconfirmed', name: 'Unconfirmed local', localExecutionConfirmed: false }] });
  await screen.findByRole('button', { name: 'Start static analysis' });
  fireEvent.click(screen.getByRole('button', { name: 'Start static analysis' }));
  const workspace = await screen.findByRole('region', { name: 'REA analysis workspace' });
  const model = within(workspace).getByRole('combobox', { name: 'Interpretation model (local only)' });
  expect(within(model).getByRole('option', { name: /Local Qwen/u })).toBeInTheDocument();
  expect(within(model).queryByRole('option', { name: /Cloud proxy|Unconfirmed local/u })).not.toBeInTheDocument();
  await waitFor(() => expect(within(workspace).getByRole('button', { name: 'Choose analysis target' })).toBeEnabled());
  fireEvent.click(within(workspace).getByRole('button', { name: 'Choose analysis target' }));
  await waitFor(() => expect(within(workspace).getByRole('button', { name: 'Run static analysis' })).toBeEnabled());
  fireEvent.click(within(workspace).getByRole('button', { name: 'Run static analysis' }));
  await within(workspace).findByText('Synthetic retained analysis');
  fireEvent.change(within(workspace).getByLabelText('Question about selected result'), { target: { value: 'Explain the boundary.' } });
  fireEvent.click(within(workspace).getByRole('button', { name: 'Ask local model about selected result' }));
  await within(workspace).findByRole('button', { name: 'View model interpretation' });
  expect(api.ask).toHaveBeenCalledExactlyOnceWith({ sessionId, resultId: result.id, question: 'Explain the boundary.', providerId: local.id, model: local.model });
  fireEvent.click(within(workspace).getByRole('button', { name: 'View model interpretation' }));
  expect(api.onOpenSession).toHaveBeenCalledExactlyOnceWith(sessionId);
});

it('maps runtime and search failures to Chinese actionable messages', async () => {
  const api = setup({ zh: true });
  await screen.findByRole('button', { name: '检查运行时' });
  api.checkRuntime.mockResolvedValueOnce({ available: false, version: null, active: false, verified: false, reasonCode: 'rea.runtimeIdentityMismatch' });
  fireEvent.click(screen.getByRole('button', { name: '检查运行时' }));
  await screen.findByText(/运行时文件与固定版本不一致/u);
  api.test.mockResolvedValueOnce({ kind: 'searxng', ok: false, code: 'plugin.jsonDisabled', checkedAt: '2026-11-02T01:00:00Z' });
  fireEvent.click(screen.getByRole('button', { name: '测试搜索' }));
  await screen.findByText(/SearXNG 已启用 JSON 输出/u);
  expect(screen.queryByText('rea.runtimeIdentityMismatch')).not.toBeInTheDocument();
});

it('does not retain a late target after the workbench has unmounted', async () => {
  const api = setup({ ready: true });
  let complete!: (value: ReaTarget) => void;
  api.chooseTarget.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  await screen.findByRole('button', { name: 'Start static analysis' });
  fireEvent.click(screen.getByRole('button', { name: 'Start static analysis' }));
  const workspace = await screen.findByRole('region', { name: 'REA analysis workspace' });
  await waitFor(() => expect(within(workspace).getByRole('button', { name: 'Choose analysis target' })).toBeEnabled());
  fireEvent.click(within(workspace).getByRole('button', { name: 'Choose analysis target' }));
  api.unmount();
  await act(async () => complete(target));
  expect(api.cancel).toHaveBeenCalledWith({ sessionId });
  expect(api.cancel.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it('discards a late analysis result after the user cancels the workbench', async () => {
  const api = setup({ ready: true });
  let complete!: (value: ReaResult) => void;
  api.analyze.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  await screen.findByRole('button', { name: 'Start static analysis' });
  fireEvent.click(screen.getByRole('button', { name: 'Start static analysis' }));
  const workspace = await screen.findByRole('region', { name: 'REA analysis workspace' });
  await waitFor(() => expect(within(workspace).getByRole('button', { name: 'Choose analysis target' })).toBeEnabled());
  fireEvent.click(within(workspace).getByRole('button', { name: 'Choose analysis target' }));
  await waitFor(() => expect(within(workspace).getByRole('button', { name: 'Run static analysis' })).toBeEnabled());
  fireEvent.click(within(workspace).getByRole('button', { name: 'Run static analysis' }));
  fireEvent.click(within(workspace).getByRole('button', { name: 'Cancel and close analysis' }));
  await waitFor(() => expect(within(workspace).getByRole('button', { name: 'Choose analysis target' })).toBeEnabled());
  await act(async () => complete(result));
  expect(within(workspace).queryByText('Synthetic retained analysis')).not.toBeInTheDocument();
  expect(within(workspace).getByRole('button', { name: 'Run static analysis' })).toBeDisabled();
});

it('keeps partial search limitations visible even when usable results are returned', async () => {
  const api = setup();
  await screen.findByRole('button', { name: 'Test search' });
  api.test.mockResolvedValueOnce({ kind: 'searxng', ok: true, code: 'plugin.partialSearch', checkedAt: '2026-11-02T01:00:00Z', resultCount: 3 });
  fireEvent.click(screen.getByRole('button', { name: 'Test search' }));
  await screen.findByText('Search is available; some upstream engines are limited or unavailable');
  expect(screen.getByText('3 results returned')).toBeInTheDocument();
  expect(screen.queryByText('Search test passed')).not.toBeInTheDocument();
});
