import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AutomationAPI, AutomationSnapshot, AutomaticTrigger } from '../../shared/automation';
import type { ProviderConfig } from '../../shared';
import { defaultEventProactivePolicy } from '../../main/domain/proactive-policy';
import { EventProactiveSettings } from './EventProactiveSettings';

const fixture = (): AutomationSnapshot => ({ automationSchedules: [], automationTriggers: [], proactivePolicy: defaultEventProactivePolicy(), proactiveEvents: [], jobs: [] });
const apiFor = (state: AutomationSnapshot): AutomationAPI => ({ snapshot: vi.fn(async () => structuredClone(state)),
  configureProactive: vi.fn(async (input) => { state.proactivePolicy = { ...input, revision: state.proactivePolicy.revision + 1 }; return structuredClone(state.proactivePolicy); }),
  explicitCheckIn: vi.fn(async () => undefined), cancelTrigger: vi.fn(async () => undefined),
  triggerResult: vi.fn(async (triggerId) => ({ triggerId, jobId: 'job-one', status: 'succeeded', result: 'SYNTHETIC_EXPLICIT_RESULT' })),
  scheduleUpsert: vi.fn(), schedulePause: vi.fn(), scheduleCancel: vi.fn(), scheduleRunNow: vi.fn(), schedulePreview: vi.fn(),
});
const providers = [{ id: 'provider', name: 'Synthetic local', model: 'synthetic', enabled: true }] as ProviderConfig[];
afterEach(cleanup);

it('keeps the displayed saved status until the one host policy save succeeds, with no hidden requests', async () => {
  const state = fixture(), api = apiFor(state); let finish!: () => void;
  api.configureProactive = vi.fn(async (input) => { await new Promise<void>((resolve) => { finish = resolve; });
    state.proactivePolicy = { ...input, revision: 2 }; return state.proactivePolicy; });
  render(<EventProactiveSettings api={api} providers={providers} locale="en" />);
  await screen.findByText('Saved policy: Off');
  fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'auto' } });
  fireEvent.click(screen.getByLabelText('App task completed'));
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'provider' } });
  fireEvent.change(screen.getByLabelText('Optional preferred topics, one per line'), { target: { value: 'reading\nsmall victories' } });
  expect(api.configureProactive).not.toHaveBeenCalled(); expect(api.explicitCheckIn).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save check-in policy' }));
  expect(screen.getByText('Saved policy: Off')).toBeVisible(); expect(screen.getByRole('button', { name: 'Save check-in policy' })).toBeDisabled();
  expect(api.configureProactive).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, eventKinds: ['task-completed'], topics: ['reading', 'small victories'], privacy: 'local-only', providerId: 'provider', model: 'synthetic' }));
  finish(); await screen.findByText('Saved policy: Automatic check-ins');
});

it('does not reveal job result bodies until an explicit result action and targets cancellation by trigger id', async () => {
  const state = fixture(), api = apiFor(state), at = '2026-10-29T12:00:00.000Z';
  const trigger: AutomaticTrigger = { id: 'trigger-one', key: 'proactive:event', kind: 'proactive', sourceId: 'event', dueAt: at,
    policyRevision: 1, status: 'submitted', jobId: 'job-one', messageId: null, createdAt: at, updatedAt: at, cancelledAt: null, errorCode: null };
  state.automationTriggers.push(trigger); state.jobs.push({ id: 'job-one', result: null } as AutomationSnapshot['jobs'][number]);
  render(<EventProactiveSettings api={api} providers={providers} locale="en" />);
  await screen.findByRole('button', { name: 'View result explicitly' }); expect(screen.queryByText('SYNTHETIC_EXPLICIT_RESULT')).toBeNull(); expect(api.triggerResult).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'View result explicitly' })); await screen.findByText('SYNTHETIC_EXPLICIT_RESULT'); expect(api.triggerResult).toHaveBeenCalledWith('trigger-one');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel this trigger' })); await waitFor(() => expect(api.cancelTrigger).toHaveBeenCalledWith('trigger-one'));
});

it('requires the persisted explicit-check-in preference and preserves saved state on failure', async () => {
  const state = fixture(), api = apiFor(state);
  render(<EventProactiveSettings api={api} providers={providers} locale="en" />);
  const action = await screen.findByRole('button', { name: 'Request one check-in' }); expect(action).toBeDisabled();
  api.configureProactive = vi.fn(async () => { throw new Error('SYNTHETIC_BACKEND_FAILURE'); });
  fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'auto' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save check-in policy' })); await screen.findByRole('alert');
  expect(screen.getByText('Saved policy: Off')).toBeVisible(); expect(api.explicitCheckIn).not.toHaveBeenCalled();
});

it('saves observe only without a provider and displays local records without requesting model results', async () => {
  const state = fixture(), api = apiFor(state);
  state.proactiveObservations = [{ id: 'observation:one', eventId: 'one', kind: 'task-completed', summary: 'Synthetic selected task',
    occurredAt: '2026-11-01T12:00:00.000Z', observedAt: '2026-11-01T12:00:00.000Z', policyRevision: 2, decision: 'would-act', reason: 'rules-matched' }];
  render(<EventProactiveSettings api={api} providers={[]} locale="en" />);
  await screen.findByText('Saved policy: Off');
  fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'observe' } });
  fireEvent.click(screen.getByLabelText('App task completed'));
  expect(screen.queryByLabelText('Provider')).toBeNull();
  expect(screen.getByText(/No model calls, jobs, chat or system notifications/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Save check-in policy' }));
  await screen.findByText('Saved policy: Observe only');
  expect(api.configureProactive).toHaveBeenCalledWith(expect.objectContaining({ mode: 'observe', enabled: false, providerId: null, model: '' }));
  expect(screen.getByText('Would act · not executed')).toBeVisible();
  expect(api.explicitCheckIn).not.toHaveBeenCalled(); expect(api.triggerResult).not.toHaveBeenCalled();
});
