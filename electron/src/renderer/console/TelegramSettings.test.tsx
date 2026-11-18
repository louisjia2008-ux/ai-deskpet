import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TelegramChannelAPI, TelegramChannelStatus } from '../../shared/telegram-channel';
import { TelegramSettings } from './TelegramSettings';

afterEach(cleanup);
const fresh = (): TelegramChannelStatus => ({
  enabled: true, connection: 'online', providerId: null, model: null, memoryAllowed: false, secretConfigured: true,
  bound: false, bindingId: null, bindingSessionId: null, bindingDisplayName: null, pairingCandidate: null, lastError: null,
  diagnostics: [], pendingInbox: 0, pendingOutbox: 0, uncertainOutbox: 0,
});
const setup = (initial = fresh()) => {
  let state = initial;
  const getState = vi.fn(async () => structuredClone(state));
  const configure = vi.fn<TelegramChannelAPI['configure']>(async () => state);
  const startPairing = vi.fn(async () => ({ code: '654321', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  const confirmPairing = vi.fn<TelegramChannelAPI['confirmPairing']>(async () => {
    state = { ...state, bound: true, bindingDisplayName: 'Phone owner', pairingCandidate: null };
    return state;
  });
  const telegram: TelegramChannelAPI = { getState, pendingResults:vi.fn(async()=>[]), configure, startPairing, confirmPairing, unbind: vi.fn(), retryDeliveries: vi.fn(), setCronDelivery: vi.fn() };
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { telegram } });
  render(<TelegramSettings locale="en" providers={[]} />);
  return { getState, startPairing, confirmPairing, configure, set: (next: TelegramChannelStatus) => { state = next; } };
};
it('requires a desktop click on the reviewed candidate, and reports the rejected field', async () => {
  const f = setup();
  expect(await screen.findByText('No account paired')).toBeInTheDocument();
  expect(f.configure).not.toHaveBeenCalled(); expect(f.startPairing).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Generate pairing code' }));
  expect(await screen.findByText('/pair 654321')).toBeInTheDocument();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  f.set({ ...fresh(), diagnostics: [{ at: new Date().toISOString(), type: 'message', outcome: 'rejected', field: 'message.chat.type' }],
    pairingCandidate: { id: 'candidate-id', userId: 'phone-identity', displayName: 'Phone owner', chatId: 'chat', expiresAt } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  expect(await screen.findByText('phone-identity')).toBeInTheDocument();
  expect(screen.getByText('message.chat.type')).toBeInTheDocument(); expect(f.confirmPairing).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Approve this Telegram account' }));
  await waitFor(() => expect(f.confirmPairing).toHaveBeenCalledExactlyOnceWith('candidate-id'));
  expect(await screen.findByRole('button', { name: 'Unpair Telegram account' })).toBeInTheDocument();
  expect(screen.queryByText('/pair 654321')).not.toBeInTheDocument();
});
it('leaves a saved credential untouched when the owner changes only memory sharing', async () => {
  const f = setup({ ...fresh(), bound: true });
  const tokenInput = await screen.findByLabelText('Dedicated bot token');
  expect(tokenInput).toHaveAttribute('type', 'password'); expect(tokenInput).toHaveValue('');
  fireEvent.click(screen.getByLabelText('Allow approved memories in Telegram'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Telegram settings' }));
  await waitFor(() => expect(f.configure).toHaveBeenCalledExactlyOnceWith({ providerId: null, model: null, memoryAllowed: true }));
});
