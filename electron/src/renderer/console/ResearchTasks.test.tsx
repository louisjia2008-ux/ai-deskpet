import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../shared';
import type { ResearchTask, ResearchTaskInput, ResearchTasksApi } from '../../shared/research-tasks';
import { ResearchTasks } from './ResearchTasks';

afterEach(cleanup);
const provider: ProviderConfig = { id: '6dd05ee1-947c-460f-847a-488e1d2129a4', kind: 'ollama', name: 'Synthetic local model',
  model: 'test-research-model', baseUrl: 'http://127.0.0.1:11434', enabled: true, supportsTools: true, secretState: 'missing', localExecutionConfirmed: true };
const makeInput = (): ResearchTaskInput => ({ operationId: crypto.randomUUID(), goal: 'Compare public sources', material: 'SELECTED_PUBLIC_MATERIAL',
  providerId: provider.id, model: provider.model, allowRemote: false, maxMinutes: 10, maxToolCalls: 20 });
const makeTask = (input = makeInput()): ResearchTask => {
  const id = crypto.randomUUID();
  return { id, profileId: crypto.randomUUID(), operationId: input.operationId, specDigest: 'a'.repeat(64), input,
    binding: { fingerprint: 'b'.repeat(64), destination: 'local' }, sessionId: crypto.randomUUID(), reportPath: `research/${id}/report.md`,
    status: 'queued', pendingOperationId: input.operationId, currentAttemptId: null, queueSequence: 1, resumeOperationIds: [],
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z', cancelRequestedAt: null,
    summary: '', errorCode: null, artifacts: [], sources: [], attempts: [] };
};
const fixture = (initial: ResearchTask[] = []) => {
  let tasks = structuredClone(initial), changed: (() => void) | undefined;
  const submit = vi.fn<ResearchTasksApi['submit']>(async input => {
    const task = tasks.find(item => item.operationId === input.operationId) ?? makeTask(input);
    if (!tasks.some(item => item.id === task.id)) tasks.unshift(task);
    return structuredClone(task);
  });
  const list = vi.fn<ResearchTasksApi['list']>(async () => structuredClone(tasks));
  const get = vi.fn<ResearchTasksApi['get']>(async id => structuredClone(tasks.find(item => item.id === id)!));
  const cancel = vi.fn<ResearchTasksApi['cancel']>(async id => {
    const task = tasks.find(item => item.id === id)!; task.status = 'cancelled'; changed?.(); return structuredClone(task);
  });
  const resume = vi.fn<ResearchTasksApi['resume']>(async input => {
    const task = tasks.find(item => item.id === input.id)!; task.status = 'queued'; task.resumeOperationIds.push(input.operationId);
    changed?.(); return structuredClone(task);
  });
  const openResult = vi.fn<ResearchTasksApi['openResult']>(async () => undefined), unsubscribe = vi.fn();
  const api: ResearchTasksApi = { submit, list, get, cancel, resume, openResult, onChanged: listener => { changed = listener; return unsubscribe; } };
  return { api, submit, list, get, cancel, resume, openResult, unsubscribe };
};
const fill = () => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Research goal' }), { target: { value: 'Compare public sources' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Selected public material' }), { target: { value: 'SELECTED_PUBLIC_MATERIAL' } });
};

describe('background research UI', () => {
  it('shows and submits the explicit scope, fixed report location and bounded settings with remote disclosure off by default', async () => {
    const f = fixture(); render(<ResearchTasks api={f.api} providers={[provider]} locale="en" />); fill();
    // A verified local model needs no remote consent, so none is asked.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Minutes per attempt' })).toHaveValue(10);
    expect(screen.getByRole('spinbutton', { name: 'Maximum tool calls per attempt' })).toHaveValue(20);
    const preview = screen.getByText('Review selected scope').parentElement!;
    expect(preview).toHaveTextContent('research/<task>/report.md'); expect(preview).toHaveTextContent('SELECTED_PUBLIC_MATERIAL');
    expect(screen.queryByRole('textbox', { name: /path|directory|file/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Minutes per attempt' }), { target: { value: '5' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum tool calls per attempt' }), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start background research' }));
    await screen.findByRole('article', { name: 'Compare public sources' });
    expect(f.submit).toHaveBeenCalledExactlyOnceWith({ operationId: expect.any(String), goal: 'Compare public sources', material: 'SELECTED_PUBLIC_MATERIAL',
      providerId: provider.id, model: null, allowRemote: false, maxMinutes: 5, maxToolCalls: 12 });
  });

  it('freezes uncertain submissions and recovers with the identical operation ID and input', async () => {
    const f = fixture(); let reject!: (reason: Error) => void;
    f.submit.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    render(<ResearchTasks api={f.api} providers={[provider]} locale="en" />); fill();
    const start = screen.getByRole('button', { name: 'Start background research' }); fireEvent.click(start); fireEvent.click(start);
    expect(f.submit).toHaveBeenCalledOnce();
    await act(async () => reject(new Error('repository.commitUncertain')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Submission not confirmed');
    expect(screen.getByRole('textbox', { name: 'Research goal' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Recover this submission' }));
    await screen.findByRole('article', { name: 'Compare public sources' });
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.submit.mock.calls[1]?.[0]).toEqual(f.submit.mock.calls[0]?.[0]);
  });

  it('makes remote consent explicit and lets the user correct a definitely rejected selection', async () => {
    const f = fixture(); f.submit.mockRejectedValueOnce(new Error('research.privacyBlocked'));
    render(<ResearchTasks api={f.api} providers={[provider]} locale="en" />); fill();
    fireEvent.click(screen.getByRole('button', { name: 'Start background research' }));
    await screen.findByText('Choose a verified local model or explicitly allow the selected input to be sent to a remote model.');
    expect(screen.getByRole('textbox', { name: 'Research goal' })).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Model' }), { target: { value: 'fixture-explicit-pin' } });
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Start background research' }));
    await screen.findByRole('article', { name: 'Compare public sources' });
    expect(f.submit.mock.calls[1]?.[0]).toMatchObject({ allowRemote: true, model: 'fixture-explicit-pin' });
    expect(f.submit.mock.calls[1]?.[0].operationId).not.toBe(f.submit.mock.calls[0]?.[0].operationId);
  });

  it('keeps interrupted results available, opens the dedicated conversation and explicitly resumes with a stable retry identity', async () => {
    const task = makeTask(); task.status = 'interrupted'; task.summary = 'Two sources checked; one remains.';
    task.artifacts = [{ path: task.reportPath, bytes: 300, sha256: 'c'.repeat(64) }];
    const f = fixture([task]), open = vi.fn(); f.resume.mockRejectedValueOnce(new Error('repository.commitUncertain'));
    render(<ResearchTasks api={f.api} providers={[provider]} locale="en" onOpenSession={open} />);
    const card = await screen.findByRole('article', { name: task.input.goal });
    expect(card).toHaveTextContent('Two sources checked');
    fireEvent.click(within(card).getByRole('button', { name: 'Open task conversation' })); expect(open).toHaveBeenCalledWith(task.sessionId);
    fireEvent.click(within(card).getByRole('button', { name: 'Open saved report' })); await waitFor(() => expect(f.openResult).toHaveBeenCalledWith(task.id));
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Continue unfinished work' })).toBeEnabled());
    fireEvent.click(within(card).getByRole('button', { name: 'Continue unfinished work' }));
    await screen.findByRole('alert');
    fireEvent.click(within(card).getByRole('button', { name: 'Recover continuation' }));
    await waitFor(() => expect(within(card).getByRole('status')).toHaveTextContent('Queued'));
    expect(f.resume.mock.calls[1]?.[0]).toEqual(f.resume.mock.calls[0]?.[0]);
    expect(card).toHaveTextContent('Two sources checked');
  });

  it('shows cancellation separately from existing results and unmounting does not cancel work', async () => {
    const task = makeTask(); task.status = 'running';
    const f = fixture([task]), view = render(<ResearchTasks api={f.api} providers={[provider]} locale="en" />);
    const card = await screen.findByRole('article', { name: task.input.goal });
    fireEvent.click(within(card).getByRole('button', { name: 'Cancel task' }));
    await waitFor(() => expect(within(card).getByRole('status')).toHaveTextContent('Cancelled'));
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(task.id);
    view.unmount(); expect(f.unsubscribe).toHaveBeenCalledOnce(); expect(f.cancel).toHaveBeenCalledOnce();
  });

  it('renders generated HTML as text and does not expose a report action without a verified artifact', async () => {
    const task = makeTask(); task.status = 'partial'; task.summary = '<img src=x onerror=alert(1)> No report was written.';
    const f = fixture([task]); render(<ResearchTasks api={f.api} providers={[provider]} locale="en" />);
    const card = await screen.findByRole('article', { name: task.input.goal });
    expect(card).toHaveTextContent('<img src=x'); expect(card.querySelector('img')).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Open saved report' })).not.toBeInTheDocument();
  });

  it('blocks form submissions outside the selected minute and tool-call bounds', () => {
    const f = fixture(); render(<ResearchTasks api={f.api} providers={[provider]} locale="en" />); fill();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Minutes per attempt' }), { target: { value: '31' } });
    expect(screen.getByRole('button', { name: 'Start background research' })).toBeDisabled();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Minutes per attempt' }), { target: { value: '10' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum tool calls per attempt' }), { target: { value: '3' } });
    expect(screen.getByRole('button', { name: 'Start background research' })).toBeDisabled(); expect(f.submit).not.toHaveBeenCalled();
  });
});
