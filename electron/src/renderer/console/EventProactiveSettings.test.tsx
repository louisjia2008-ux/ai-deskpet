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

it('saves only its own rules on top of the latest saved policy, after an explicit save', async () => {
  const state = fixture(), api = apiFor(state); let finish!: () => void;
  state.proactivePolicy = { ...state.proactivePolicy, mode: 'auto', enabled: true, providerId: 'provider', privacy: 'cloud-allowed' };
  api.configureProactive = vi.fn(async (input) => { await new Promise<void>((resolve) => { finish = resolve; });
    state.proactivePolicy = { ...input, revision: 2 }; return state.proactivePolicy; });
  render(<EventProactiveSettings api={api} providers={providers} locale="en" />);
  fireEvent.click(await screen.findByLabelText('App task completed'));
  fireEvent.change(screen.getByLabelText('Optional preferred topics, one per line'), { target: { value: 'reading\nsmall victories' } });
  expect(screen.queryByLabelText('Mode')).toBeNull(); expect(screen.queryByLabelText('Provider')).toBeNull();
  expect(api.configureProactive).not.toHaveBeenCalled(); expect(api.explicitCheckIn).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save these rules' }));
  await waitFor(() => expect(api.configureProactive).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: 'Save these rules' })).toBeDisabled();
  expect(api.configureProactive).toHaveBeenCalledWith(expect.objectContaining({ mode: 'auto', enabled: true, providerId: 'provider', privacy: 'cloud-allowed', topics: ['reading', 'small victories'] }));
  finish(); await waitFor(() => expect(screen.getByRole('button', { name: 'Save these rules' })).toBeEnabled());
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

it('keeps the one-check-in request unavailable while check-ins are off and reports a failed save', async () => {
  const state = fixture(), api = apiFor(state);
  render(<EventProactiveSettings api={api} providers={providers} locale="en" />);
  const action = await screen.findByRole('button', { name: 'Request one check-in' }); expect(action).toBeDisabled();
  api.configureProactive = vi.fn(async () => { throw new Error('SYNTHETIC_BACKEND_FAILURE'); });
  fireEvent.click(screen.getByRole('button', { name: 'Save these rules' })); await screen.findByRole('alert');
  expect(api.explicitCheckIn).not.toHaveBeenCalled();
});

it('shows local observation records without requesting model results', async () => {
  const state = fixture(), api = apiFor(state);
  state.proactivePolicy = { ...state.proactivePolicy, mode: 'observe', enabled: false };
  state.proactiveObservations = [{ id: 'observation:one', eventId: 'one', kind: 'task-completed', summary: 'Synthetic selected task',
    occurredAt: '2026-11-01T12:00:00.000Z', observedAt: '2026-11-01T12:00:00.000Z', policyRevision: 2, decision: 'would-act', reason: 'rules-matched' }];
  render(<EventProactiveSettings api={api} providers={[]} locale="en" />);
  expect(await screen.findByText('Would act · not executed')).toBeVisible();
  expect(api.explicitCheckIn).not.toHaveBeenCalled(); expect(api.triggerResult).not.toHaveBeenCalled();
});
