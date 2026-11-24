import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../shared';
import type { AutomationAPI, AutomationSnapshot, PersistentSchedule } from '../../shared/automation';
import { PersistentSchedules } from './PersistentSchedules';

const provider: ProviderConfig = { id: '0e5e71f9-5987-486d-bb03-f75c4c693783', kind: 'lm-studio', name: 'Synthetic local provider', baseUrl: 'http://127.0.0.1:47132/v1', model: 'synthetic-schedule', enabled: true, supportsTools: false, localExecutionConfirmed: true, secretState: 'configured' };
const example: PersistentSchedule = { id: 'e29012ba-fb8e-4004-b4ea-d78493fca320', title: 'Synthetic daily summary', instruction: 'Summarize selected synthetic text.', material: 'Selected synthetic text only.', privacy: 'local-only', providerId: provider.id, model: provider.model,
  rule: { kind: 'daily', time: '09:00' }, timezone: 'UTC', missedPolicy: 'skip', enabled: true, revision: 1,
  createdAt: '2026-10-29T08:00:00Z', updatedAt: '2026-10-29T08:00:00Z', nextRunAt: '2026-10-29T09:00:00Z', cancelledAt: null };
const fixture = (items: PersistentSchedule[] = []) => {
  const state: AutomationSnapshot = { automationSchedules: structuredClone(items), automationTriggers: [], proactiveEvents: [], jobs: [],
    proactivePolicy: { enabled: false, revision: 1, eventKinds: [], quietStart: '23:00', quietEnd: '08:00', timezone: 'UTC', cooldownMinutes: 60, dailyLimit: 1, topics: [], privacy: 'local-only', providerId: null, model: '' } };
  const api: AutomationAPI = {
    snapshot: vi.fn(async () => structuredClone(state)),
    triggerResult: vi.fn(async (triggerId) => ({ triggerId, jobId: '80541163-3ea1-4ba8-994c-f8052ba050ea', status: 'succeeded', result: 'Synthetic explicit result' })),
    scheduleUpsert: vi.fn(async (input) => { const next: PersistentSchedule = { ...input, revision: 1, createdAt: '2026-10-29T08:00:00Z', updatedAt: '2026-10-29T08:00:00Z', nextRunAt: '2026-10-30T09:00:00Z', cancelledAt: null }; const index = state.automationSchedules.findIndex((item) => item.id === input.id); if (index >= 0) state.automationSchedules[index] = next; else state.automationSchedules.push(next); return next; }),
    schedulePause: vi.fn(async (id) => { const item = state.automationSchedules.find((value) => value.id === id)!; item.enabled = false; item.nextRunAt = null; }),
    scheduleCancel: vi.fn(async (id) => { const item = state.automationSchedules.find((value) => value.id === id)!; item.enabled = false; item.cancelledAt = '2026-10-29T09:00:00Z'; item.nextRunAt = null; }),
    scheduleRunNow: vi.fn(async ({ id, operationId }) => ({ id: operationId, key: `schedule-manual:${operationId}`, kind: 'schedule' as const, sourceId: id, dueAt: '2026-10-29T09:00:00Z', policyRevision: 1, status: 'submitted' as const, jobId: '80541163-3ea1-4ba8-994c-f8052ba050ea', messageId: null, createdAt: '2026-10-29T09:00:00Z', updatedAt: '2026-10-29T09:00:00Z', cancelledAt: null, errorCode: null })),
    schedulePreview: vi.fn(async () => ['2026-11-02T06:30:00Z']),
    patchProactive: vi.fn(), configureProactive: vi.fn(async (value) => ({ ...value, revision: 1 })), explicitCheckIn: vi.fn(async () => undefined), cancelTrigger: vi.fn(async () => undefined),
  };
  return { state, api };
};
afterEach(cleanup);

describe('PersistentSchedules controlled UI', () => {
  it('asks the authoritative API for timezone preview without submitting a job or saving a rule', async () => {
    const f = fixture(); render(<PersistentSchedules api={f.api} providers={[provider]} locale="en" />);
    fireEvent.change(screen.getByLabelText('Time zone (defaults to this computer)'), { target: { value: 'America/New_York' } });
    fireEvent.change(screen.getByLabelText('Local time'), { target: { value: '01:30' } });
    // The next times follow the form by themselves, as readable dates.
    await waitFor(() => expect(f.api.schedulePreview).toHaveBeenCalledWith(expect.objectContaining({ timezone: 'America/New_York', rule: { kind: 'daily', time: '01:30' } })));
    expect(screen.queryByText('2026-11-02T06:30:00Z')).toBeNull();
    expect(f.api.schedulePreview).toHaveBeenCalledWith(expect.objectContaining({ timezone: 'America/New_York', rule: { kind: 'daily', time: '01:30' }, count: 3 }));
    expect(f.api.scheduleUpsert).not.toHaveBeenCalled(); expect(f.api.scheduleRunNow).not.toHaveBeenCalled();
    expect(screen.getByText(/A request with an unknown dispatched result is never automatically resent/)).toBeInTheDocument();
  });
  it('submits only explicit material with selected rule, zone, provider, and missed policy', async () => {
    const f = fixture(); render(<PersistentSchedules api={f.api} providers={[provider]} locale="en" />);
    fireEvent.change(screen.getByLabelText('Schedule title'), { target: { value: 'Evening summary' } });
    fireEvent.change(screen.getByLabelText('Time rule'), { target: { value: 'weekly' } });
    fireEvent.change(screen.getByLabelText('Weekday'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Local time'), { target: { value: '17:30' } });
    fireEvent.change(screen.getByLabelText('Time zone (defaults to this computer)'), { target: { value: 'Asia/Shanghai' } });
    fireEvent.change(screen.getByLabelText('When an execution was missed'), { target: { value: 'run-once' } });
    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'Summarize selected text.' } });
    fireEvent.change(screen.getByLabelText('Explicit material'), { target: { value: 'SYNTHETIC_ONLY_SELECTED_TEXT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(f.api.scheduleUpsert).toHaveBeenCalledTimes(1));
    expect(f.api.scheduleUpsert).toHaveBeenCalledWith(expect.objectContaining({ title: 'Evening summary', rule: { kind: 'weekly', time: '17:30', weekday: 5 }, timezone: 'Asia/Shanghai', missedPolicy: 'run-once', privacy: 'local-only', providerId: provider.id, model: null, material: 'SYNTHETIC_ONLY_SELECTED_TEXT' }));
    expect(f.api.scheduleRunNow).not.toHaveBeenCalled();
  });
  it('pauses, resumes and confirms permanent cancellation without deleting execution identities', async () => {
    const f = fixture([example]); render(<PersistentSchedules api={f.api} providers={[provider]} locale="en" />);
    await screen.findByRole('listitem', { name: example.title });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' })); await waitFor(() => expect(f.api.schedulePause).toHaveBeenCalledWith(example.id));
    await screen.findByRole('button', { name: 'Resume' });
    fireEvent.click(screen.getByRole('button', { name: 'Resume' })); await waitFor(() => expect(f.api.scheduleUpsert).toHaveBeenCalledWith(expect.objectContaining({ id: example.id, enabled: true, model: example.model })));
    await screen.findByRole('button', { name: 'Pause' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel schedule' }));
    const dialog = screen.getByRole('alertdialog'); expect(f.api.scheduleCancel).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel schedule' })); await waitFor(() => expect(f.api.scheduleCancel).toHaveBeenCalledWith(example.id));
    await screen.findByText(/Cancelled · UTC/); expect(f.state.automationSchedules).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Run once now' })).not.toBeInTheDocument();
  });
  it('shows each durable trigger once and uses a fresh explicit operation identity for a manual run', async () => {
    const f = fixture([example]); f.state.automationTriggers.push({ id: 'ae975e32-244e-4e22-8f0d-f7f0150718c4', key: `schedule:${example.id}:2026-10-28T09:00:00Z`, kind: 'schedule', sourceId: example.id, dueAt: '2026-10-28T09:00:00Z', policyRevision: 1, status: 'unknown', jobId: '80541163-3ea1-4ba8-994c-f8052ba050ea', messageId: null, createdAt: '2026-10-28T09:00:00Z', updatedAt: '2026-10-28T09:00:10Z', cancelledAt: null, errorCode: 'schedule.reservationUncertain' });
    render(<PersistentSchedules api={f.api} providers={[provider]} locale="en" />); await screen.findByText('Unknown');
    expect(screen.getAllByText('Could not confirm it started; it will not be retried automatically')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Run once now' })); await waitFor(() => expect(f.api.scheduleRunNow).toHaveBeenCalledTimes(1));
    expect(f.api.scheduleRunNow).toHaveBeenCalledWith({ id: example.id, operationId: expect.stringMatching(/^[a-f\d-]{36}$/u) });
  });
});
