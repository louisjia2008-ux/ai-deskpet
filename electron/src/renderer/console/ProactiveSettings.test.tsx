import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProactiveSettings } from './ProactiveSettings';
import { proactiveEn } from '../../shared/proactive-i18n';
import type { ProactiveState } from '../../shared/proactive';
const t = (key: string): string => proactiveEn[key as keyof typeof proactiveEn] ?? key;
const state: ProactiveState = { enabled: false, frequency: 'occasional', status: 'off', nextAt: null, attemptsToday: 0, dailyLimit: 6, sessionId: null, lastMessageAt: null };
afterEach(cleanup);
it('waits for a successful settings save and keeps the old checkbox on failure', async () => {
  let save: ((value: ProactiveState) => void) | undefined;
  const configure = vi.fn(() => new Promise<ProactiveState>((resolve) => { save = resolve; }));
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { proactive: { getState: async () => state, configure, onChanged: () => () => undefined } } });
  render(<ProactiveSettings t={t} />);
  const toggle = await screen.findByRole('checkbox'); fireEvent.click(toggle);
  expect(toggle).toBeDisabled(); expect(toggle).not.toBeChecked();
  expect(configure).toHaveBeenCalledWith({ enabled: true, frequency: 'occasional' });
  save?.({ ...state, enabled: true, status: 'waiting' }); await waitFor(() => expect(toggle).toBeChecked());
  configure.mockRejectedValueOnce(new Error('Disk full')); fireEvent.click(toggle);
  await screen.findByRole('alert'); expect(toggle).toBeChecked(); expect(toggle).toBeEnabled();
});
it('opens the actual persisted conversation and saves a selected frequency', async () => {
  const openSession = vi.fn(async () => undefined); const configure = vi.fn(async () => state);
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { proactive: { getState: async () => ({ ...state, sessionId: 'actual-session' }), configure, onChanged: () => () => undefined }, chat: { openSession } } });
  render(<ProactiveSettings t={t} />); fireEvent.click(await screen.findByRole('button', { name: 'Open companion conversation' }));
  expect(openSession).toHaveBeenCalledWith('actual-session');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'rare' } });
  await waitFor(() => expect(configure).toHaveBeenCalledWith({ enabled: false, frequency: 'rare' }));
});
