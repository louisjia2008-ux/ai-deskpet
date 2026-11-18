import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DeskPetApi, ProviderConfig } from '../../shared';
import { messages } from '../../shared';
import { ProviderSettings } from './ProviderSettings';

const t = (key: string): string => messages.en[key as keyof typeof messages.en] ?? key;
afterEach(cleanup);
it('keeps an enable switch at its new value while the provider is being saved', async () => {
  const provider: ProviderConfig = { id: crypto.randomUUID(), kind: 'ollama', name: 'Pending fixture', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', enabled: true, supportsTools: false, secretState: 'missing' };
  let resolveSave: (() => void) | undefined;
  const upsert = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
  Object.defineProperty(window, 'deskpet', { value: { providers: { upsert } } as unknown as DeskPetApi, configurable: true });
  render(<ProviderSettings providers={[provider]} activeId={provider.id} t={t} refresh={vi.fn()} />);
  const checkbox = screen.getByRole('checkbox', { name: 'Enabled Pending fixture' });
  fireEvent.click(checkbox); expect(checkbox).not.toBeChecked(); expect(checkbox).toBeDisabled();
  resolveSave?.(); await waitFor(() => expect(checkbox).toBeEnabled());
});
it('edits a provider without exposing or replacing its saved key, and allows explicit selection', async () => {
  const provider: ProviderConfig = { id: crypto.randomUUID(), kind: 'ollama', name: 'Local fixture', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', enabled: true, supportsTools: false, secretState: 'configured' };
  const upsert = vi.fn(async () => provider); const select = vi.fn();
  Object.defineProperty(window, 'deskpet', { value: { providers: { upsert, select } } as unknown as DeskPetApi, configurable: true });
  render(<ProviderSettings providers={[provider]} activeId={null} t={t} refresh={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Use for chat' }));
  await waitFor(() => expect(select).toHaveBeenCalledWith(provider.id));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.click(screen.getByText('Advanced connection settings'));
  expect(screen.getByLabelText('API key (optional)')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(upsert).toHaveBeenCalledWith({ id: provider.id, kind: 'ollama', name: 'Renamed', baseUrl: provider.baseUrl, model: 'fixture', enabled: true, supportsTools: false }));
});
