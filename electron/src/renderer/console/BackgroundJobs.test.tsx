import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeskPetApi, ProviderConfig } from '../../shared';
import type { BackgroundJob, BackgroundJobInput } from '../../shared/background-jobs';
import { BackgroundJobs } from './BackgroundJobs';

const provider: ProviderConfig = {
  id: '8af8f9ec-d77e-4d76-a4b9-611c477c7528', kind: 'ollama', name: 'Synthetic local', baseUrl: 'http://127.0.0.1:11999/v1',
  model: 'frozen-model', enabled: true, supportsTools: true, secretState: 'missing', localExecutionConfirmed: true,
};
const jobFrom = (input: BackgroundJobInput): BackgroundJob => ({
  ...input, id: 'cb765352-ec4c-46fa-924d-cb425d595634', profileId: '2f81786d-b09e-451c-a58f-144efcad98b7', specDigest: 'a'.repeat(64),
  attemptId: 'b347cf4a-5728-4d16-a966-4476db8566cc', origin: 'background-jobs', resultOwner: 'cb765352-ec4c-46fa-924d-cb425d595634',
  source: { kind: 'explicit-paste', actionId: input.operationId, privacy: input.privacy },
  binding: { provider, model: input.model, digest: 'b'.repeat(64), credentialRef: 'fake-reference', destination: 'local', limits: { maxOutputTokens: 512, outputTokenParameter: 'max_tokens', contextBudget: { contextWindowTokens: 4096, safetyMarginTokens: 256, capacitySource: 'configured' } } },
  status: 'queued', executionOwner: null, cancelRequestedAt: null, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z',
  completionReason: null, result: null, request: null, receipts: [],
});
const fixture = (initial: BackgroundJob[] = []) => {
  let jobs = initial;
  let changed: (() => void) | undefined;
  const submit = vi.fn<DeskPetApi['jobs']['submit']>(async (input) => {
    const job = jobs.find((item) => item.operationId === input.operationId) ?? jobFrom(input);
    jobs = [job]; return structuredClone(job);
  });
  const list = vi.fn<DeskPetApi['jobs']['list']>(async () => structuredClone(jobs));
  const get = vi.fn<DeskPetApi['jobs']['get']>(async (id) => structuredClone(jobs.find((job) => job.id === id)!));
  const cancel = vi.fn<DeskPetApi['jobs']['cancel']>(async (id) => {
    jobs = jobs.map((job) => job.id === id ? { ...job, status: 'cancelled', cancelRequestedAt: '2026-10-28T00:00:01.000Z' } : job);
    changed?.(); return structuredClone(jobs.find((job) => job.id === id)!);
  });
  const unsubscribe = vi.fn();
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { jobs: { submit, list, get, cancel, onChanged: (listener: () => void) => { changed = listener; return unsubscribe; } } } });
  return { submit, list, get, cancel, unsubscribe, setJobs: (next: BackgroundJob[]) => { jobs = next; changed?.(); } };
};
const fill = () => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Task instruction' }), { target: { value: 'SYNTHETIC_JOB_INSTRUCTION' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Selected material (paste text)' }), { target: { value: 'ONLY_EXPLICIT_MATERIAL' } });
};
afterEach(cleanup);

const cloud: ProviderConfig = { ...provider, id: '0c1f3a3e-4d1b-4a8e-9a55-1d5c0b3e7f21', kind: 'openai', name: 'Synthetic cloud', baseUrl: 'https://api.openai.com/v1', localExecutionConfirmed: undefined, secretState: 'configured' };

describe('background text job UI', () => {
  it('asks for remote consent only for a cloud service and drops it when the service changes', async () => {
    const f = fixture(); render(<BackgroundJobs providers={[cloud, provider]} locale="en" />); fill();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox')).toBeChecked();
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: provider.id } });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run in background' }));
    await waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    expect(f.submit.mock.calls[0]![0].privacy).toBe('local-only');
  });

  it('previews the exact explicit material and chosen binding before submitting, then keeps result separate', async () => {
    const f = fixture(); render(<BackgroundJobs providers={[provider]} locale="en" />); fill();
    const preview = screen.getByText('Submission preview').parentElement!;
    expect(preview).toHaveTextContent('ONLY_EXPLICIT_MATERIAL');
    expect(preview).toHaveTextContent('Synthetic local');
    expect(preview).toHaveTextContent('http://127.0.0.1:11999/v1');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run in background' }));
    await screen.findByRole('article', { name: 'SYNTHETIC_JOB_INSTRUCTION' });
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.submit.mock.calls[0]?.[0]).toEqual({ operationId: expect.any(String), instruction: 'SYNTHETIC_JOB_INSTRUCTION', material: 'ONLY_EXPLICIT_MATERIAL', privacy: 'local-only', providerId: provider.id, model: provider.model });
    expect(f.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Saved result' })).not.toBeInTheDocument();
  });

  it('blocks repeated clicks and recovers an uncertain submission using the identical operation and input', async () => {
    const f = fixture(); let reject: ((error: Error) => void) | undefined;
    f.submit.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    render(<BackgroundJobs providers={[provider]} locale="en" />); fill();
    const button = screen.getByRole('button', { name: 'Run in background' });
    fireEvent.click(button); fireEvent.click(button);
    expect(f.submit).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox', { name: 'Task instruction' })).toBeDisabled();
    await act(async () => reject?.(new Error('repository.commitUncertain')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Result unknown');
    expect(screen.getByRole('textbox', { name: 'Selected material (paste text)' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Recover this submission' }));
    await screen.findByRole('article', { name: 'SYNTHETIC_JOB_INSTRUCTION' });
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.submit.mock.calls[1]?.[0]).toEqual(f.submit.mock.calls[0]?.[0]);
  });

  it('allows an intentional new submission after a definite preaccept rejection', async () => {
    const f = fixture(); f.submit.mockRejectedValueOnce(new Error('job.privacyBlocked'));
    render(<BackgroundJobs providers={[provider]} locale="en" />); fill();
    fireEvent.click(screen.getByRole('button', { name: 'Run in background' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('rejected this submission before accepting');
    expect(screen.getByRole('textbox', { name: 'Task instruction' })).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Run in background' }));
    await screen.findByRole('article', { name: 'SYNTHETIC_JOB_INSTRUCTION' });
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.submit.mock.calls[1]?.[0].operationId).not.toBe(f.submit.mock.calls[0]?.[0].operationId);
    expect(f.submit.mock.calls[1]?.[0].privacy).toBe('cloud-allowed');
  });

  it('reads a saved result only after explicit selection and renders HTML and commands as plain text', async () => {
    const result = '<img src="https://outside.invalid/tracker"><script>window.executed = true</script>\nrm -rf /synthetic';
    const job: BackgroundJob = { ...jobFrom({ operationId: crypto.randomUUID(), instruction: 'SAVED_JOB', material: '', privacy: 'local-only', providerId: provider.id, model: provider.model }), status: 'succeeded', result, completionReason: 'stop' };
    const f = fixture([job]); const { container } = render(<BackgroundJobs providers={[provider]} locale="en" />);
    await screen.findByRole('article', { name: 'SAVED_JOB' });
    expect(container).not.toHaveTextContent(result);
    fireEvent.click(screen.getByRole('button', { name: 'View result' }));
    const area = await screen.findByRole('region', { name: 'Saved result' });
    expect(f.get).toHaveBeenCalledExactlyOnceWith(job.id);
    expect(area.querySelector('pre')?.textContent).toBe(result);
    expect(area.querySelector('img')).toBeNull(); expect(area.querySelector('script')).toBeNull();
    fireEvent.click(within(area).getByRole('button', { name: 'Close result' }));
    expect(screen.queryByRole('region', { name: 'Saved result' })).not.toBeInTheDocument();
  });

  it('cancels only the selected saved job and leaving the page does not cancel any job', async () => {
    const job = jobFrom({ operationId: crypto.randomUUID(), instruction: 'QUEUED_JOB', material: '', privacy: 'local-only', providerId: provider.id, model: provider.model });
    const f = fixture([job]); const rendered = render(<BackgroundJobs providers={[provider]} locale="zh-CN" />);
    await screen.findByRole('article', { name: 'QUEUED_JOB' });
    fireEvent.click(screen.getByRole('button', { name: '取消任务' }));
    await screen.findByText('已在本地取消');
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(job.id);
    rendered.unmount(); expect(f.unsubscribe).toHaveBeenCalledOnce(); expect(f.cancel).toHaveBeenCalledOnce();
  });

  it('shows a failed cancellation as unconfirmed and preserves the last authoritative state', async () => {
    const job = jobFrom({ operationId: crypto.randomUUID(), instruction: 'CANCEL_UNKNOWN_JOB', material: '', privacy: 'local-only', providerId: provider.id, model: provider.model });
    const f = fixture([job]); f.cancel.mockRejectedValueOnce(new Error('repository.commitUncertain'));
    render(<BackgroundJobs providers={[provider]} locale="en" />);
    await screen.findByRole('article', { name: 'CANCEL_UNKNOWN_JOB' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel job' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cancellation could not be confirmed');
    await waitFor(() => expect(screen.getByText('Queued')).toBeVisible());
  });

  it('opens the explicitly selected saved job from the attention center without submitting or cancelling', async () => {
    const saved = { ...jobFrom({ operationId: crypto.randomUUID(), instruction: 'ATTENTION_SAVED_JOB', material: '', privacy: 'local-only', providerId: provider.id, model: provider.model }), status: 'succeeded' as const, result: 'SAVED_ATTENTION_RESULT' };
    const f = fixture([saved]);
    render(<BackgroundJobs providers={[provider]} locale="en" openJobId={saved.id} />);
    const result = await screen.findByRole('region', { name: 'Saved result' });
    expect(result).toHaveTextContent('SAVED_ATTENTION_RESULT'); expect(result).toHaveAttribute('data-opened-job-id', saved.id);
    await waitFor(() => expect(result).toHaveFocus());
    expect(f.get).toHaveBeenCalledExactlyOnceWith(saved.id); expect(f.submit).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled();
  });

  it('does not publish an older job read after attention navigation selects another result', async () => {
    const first = { ...jobFrom({ operationId: crypto.randomUUID(), instruction: 'FIRST_JOB', material: '', privacy: 'local-only', providerId: provider.id, model: provider.model }), result: 'LATE_FIRST_JOB_BODY' };
    const second = { ...first, id: 'second-job', resultOwner: 'second-job', instruction: 'SECOND_JOB', result: 'CURRENT_SECOND_JOB_BODY' };
    const f = fixture([first, second]); let resolve: ((value: BackgroundJob) => void) | undefined;
    f.get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const view = render(<BackgroundJobs providers={[provider]} locale="en" openJobId={first.id} />);
    view.rerender(<BackgroundJobs providers={[provider]} locale="en" openJobId={second.id} />);
    expect(await screen.findByRole('region', { name: 'Saved result' })).toHaveTextContent('CURRENT_SECOND_JOB_BODY');
    await act(async () => resolve?.(first));
    expect(screen.queryByText('LATE_FIRST_JOB_BODY')).not.toBeInTheDocument(); expect(f.submit).not.toHaveBeenCalled();
  });

  it('refuses a saved-job response whose identity does not match the selected target', async () => {
    const saved = { ...jobFrom({ operationId: crypto.randomUUID(), instruction: 'WRONG_IDENTITY', material: '', privacy: 'local-only', providerId: provider.id, model: provider.model }), result: 'WRONG_JOB_BODY' };
    const f = fixture([saved]); f.get.mockResolvedValueOnce({ ...saved, id: 'different-job' });
    render(<BackgroundJobs providers={[provider]} locale="en" openJobId={saved.id} />);
    await screen.findByRole('alert'); expect(screen.queryByText('WRONG_JOB_BODY')).not.toBeInTheDocument(); expect(screen.queryByRole('region', { name: 'Saved result' })).not.toBeInTheDocument();
  });

});
