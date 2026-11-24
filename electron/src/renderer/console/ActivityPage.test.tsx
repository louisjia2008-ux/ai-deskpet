import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DeskPetApi, TaskRunEvent } from '../../shared';
import { ActivityPage } from './ActivityPage';

afterEach(cleanup);
const event = (index: number): TaskRunEvent => ({ id: `id-${index}`, runId: 'run', sequence: index + 1,
  createdAt: '2026-11-01T00:00:00.000Z', type: 'state', status: 'succeeded', summary: `EVENT_${index}`, metadata: {} });
it('loads only a bounded first page, loads older rows on demand and keeps them on focus', async () => {
  const listRunEvents = vi.fn<DeskPetApi['tasks']['listRunEvents']>()
    .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => event(i + 1)))
    .mockResolvedValueOnce([event(0)]).mockResolvedValueOnce([event(101)]);
  Object.defineProperty(window, 'deskpet', { value: { tasks: { listRunEvents } }, configurable: true });
  render(<ActivityPage locale="en" t={key => key} />);
  await screen.findByText('EVENT_100');
  expect(listRunEvents).toHaveBeenCalledExactlyOnceWith({ limit: 100 });
  fireEvent.click(screen.getByRole('button', { name: 'Load older events' }));
  await screen.findByText('EVENT_0');
  expect(listRunEvents).toHaveBeenLastCalledWith({ limit: 100, beforeId: 'id-1' });
  expect(screen.queryByRole('button', { name: 'Load older events' })).toBeNull();
  // Older events stay open when the window regains focus.
  fireEvent.focus(window);
  expect(listRunEvents).toHaveBeenCalledTimes(2);
  expect(screen.getByText('EVENT_0')).toBeVisible();
});

it('shows the latest events again when the window regains focus', async () => {
  const listRunEvents = vi.fn<DeskPetApi['tasks']['listRunEvents']>()
    .mockResolvedValueOnce([event(1)]).mockResolvedValueOnce([event(2)]);
  Object.defineProperty(window, 'deskpet', { value: { tasks: { listRunEvents } }, configurable: true });
  render(<ActivityPage locale="en" t={key => key} />);
  await screen.findByText('EVENT_1');
  fireEvent.focus(window);
  await screen.findByText('EVENT_2');
});

it('shows read failures and ignores a response after unmount', async () => {
  let resolve!: (events: TaskRunEvent[]) => void;
  const listRunEvents = vi.fn<DeskPetApi['tasks']['listRunEvents']>().mockRejectedValueOnce(new Error('fixture'))
    .mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  Object.defineProperty(window, 'deskpet', { value: { tasks: { listRunEvents } }, configurable: true });
  const { unmount } = render(<ActivityPage locale="en" t={key => key} />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
  unmount();
  await act(async () => { resolve([event(0)]); });
  expect(screen.queryByText('EVENT_0')).toBeNull();
});
