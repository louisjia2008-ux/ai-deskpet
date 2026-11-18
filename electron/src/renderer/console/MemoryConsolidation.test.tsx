import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeskPetApi, ProviderConfig } from '../../shared';
import type { ConsolidationBatch, ConsolidationCandidate, ConsolidationSource } from '../../shared/consolidation';
import { MemoryConsolidation } from './MemoryConsolidation';

const sessionId = 'acdb55c0-daae-42fc-b758-25589a88fc7b';
const otherSessionId = 'ebfc57b9-45c5-47c6-bea6-f8d435bf78a0';
const batchId = '82d127cd-0654-4620-a33c-113b6e89926a';
const sourceId = '8b0d4120-0b59-441b-a6c3-5f565fa354bb';
const providers: ProviderConfig[] = [{ id: '0db31044-183a-47b5-8422-f358184260b5', name: 'Synthetic local provider', model: 'frozen-model', kind: 'ollama', enabled: true, baseUrl: 'http://127.0.0.1:19441/v1', supportsTools: true, localExecutionConfirmed: true, secretState: 'missing' }];
const source: ConsolidationSource = { id: sourceId, revision: 4, fingerprint: 'source-body-sha', text: 'Synthetic subject A takes 12 mg only on weekdays; never on public holidays.', tags: ['synthetic'], privacy: 'local-only', scope: { kind: 'global' }, sourceReferences: [{ kind: 'manual-user', actionId: 'a7b2d247-fe28-48ed-a710-fb63da8e9671' }], sourceEventIds: ['event-user-1'], selectionVersion: 0 };
const candidate: ConsolidationCandidate = { segments: [{ text: 'A: 12 mg on weekdays, excluding public holidays.', sourceIds: [sourceId] }], coveredMemoryIds: [sourceId], uncoveredMemoryIds: [], conflicts: [] };
const savedBatch = (status: ConsolidationBatch['status'] = 'draft', overrides: Partial<ConsolidationBatch> = {}): ConsolidationBatch => ({
  id: batchId, sessionId, status, sources: [structuredClone(source)], candidate: status === 'draft' || status === 'generating' ? null : structuredClone(candidate), candidateVersion: status === 'draft' || status === 'generating' ? 0 : 1,
  binding: { provider: providers[0]!, model: 'frozen-model', digest: 'binding-digest', credentialRef: 'provider-ref', destination: 'local', limits: { maxOutputTokens: 512, outputTokenParameter: 'max_tokens', contextBudget: { contextWindowTokens: 4096, safetyMarginTokens: 256, capacitySource: 'configured' } } },
  budget: { inputEstimate: 310, maxInputTokens: 3328, maxOutputTokens: 512 }, createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z', jobId: status === 'draft' ? null : '6e37d326-4c4e-4cf4-9f72-e7e82903351c', jobStatus: status === 'generating' ? 'queued' : status === 'draft' ? null : 'succeeded', completionReason: null, invalidReason: null, active: status === 'applied', request: null, rawResponse: status === 'review' || status === 'applied' ? JSON.stringify(candidate) : null, receipts: [], ...overrides,
});
const fixture = (initial: ConsolidationBatch[] = [], available: ConsolidationSource[] = [source]) => {
  let batches = structuredClone(initial); let changed: (() => void) | undefined; const off = vi.fn();
  const sources = vi.fn<DeskPetApi['consolidation']['sources']>(async () => structuredClone(available));
  const list = vi.fn<DeskPetApi['consolidation']['list']>(async (id) => structuredClone(batches.filter((item) => item.sessionId === id)));
  const update = (batch: ConsolidationBatch): ConsolidationBatch => { batches = [structuredClone(batch), ...batches.filter((item) => item.id !== batch.id)]; return structuredClone(batch); };
  const preview = vi.fn<DeskPetApi['consolidation']['preview']>(async () => update(savedBatch()));
  const generate = vi.fn<DeskPetApi['consolidation']['generate']>(async () => update(savedBatch('generating')));
  const get = vi.fn<DeskPetApi['consolidation']['get']>(async (id) => structuredClone(batches.find((item) => item.id === id)!));
  const edit = vi.fn<DeskPetApi['consolidation']['edit']>(async (input) => update({ ...batches.find((item) => item.id === input.id)!, candidateVersion: input.expectedVersion + 1, candidate: structuredClone(input.candidate) }));
  const apply = vi.fn<DeskPetApi['consolidation']['apply']>(async (input) => update({ ...batches.find((item) => item.id === input.id)!, status: 'applied', active: input.enableRepresentation }));
  const disable = vi.fn<DeskPetApi['consolidation']['disable']>(async (input) => update({ ...batches.find((item) => item.id === input.id)!, status: 'disabled', active: false }));
  const cancel = vi.fn<DeskPetApi['consolidation']['cancel']>(async (input) => update({ ...batches.find((item) => item.id === input.id)!, status: 'cancelled', active: false }));
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { consolidation: { sources, list, preview, generate, get, edit, apply, disable, cancel, onChanged: (listener: () => void) => { changed = listener; return off; } } } });
  return { sources, list, preview, generate, get, edit, apply, disable, cancel, off, setBatches: (saved: ConsolidationBatch[]) => { batches = structuredClone(saved); changed?.(); } };
};
const mount = () => render(<MemoryConsolidation providers={providers} sessionId={sessionId} locale="en" />);
const chooseSources = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole('checkbox', { name: `Select source ${sourceId}` }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Consolidation provider' }), { target: { value: providers[0]!.id } });
};
const openReview = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: 'Review batch' }));
  await screen.findByRole('textbox', { name: 'Candidate JSON' });
  await waitFor(() => expect(screen.getByRole('region', { name: 'Consolidation candidate review' })).toHaveFocus());
};
const fidelityBox = () => screen.getByRole('checkbox', { name: 'I compared this version with every source, including conditions and conflicts' });
afterEach(cleanup);

describe('manual sourced consolidation UI', () => {
  it('does not generate on selection and shows frozen material, binding and budget before the explicit single generation', async () => {
    const f = fixture(); mount(); expect(screen.getByRole('button', { name: 'Review selected sources' })).toBeDisabled();
    await chooseSources(); expect(f.preview).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review selected sources' }));
    const preview = await screen.findByRole('region', { name: 'Consolidation material and binding' });
    expect(preview).toHaveTextContent(source.text); expect(preview).toHaveTextContent('frozen-model'); expect(preview).toHaveTextContent('310'); expect(preview).toHaveTextContent('3328'); expect(preview).toHaveTextContent('512');
    expect(f.preview.mock.calls[0]![0]).toMatchObject({ sessionId, memoryIds: [sourceId], providerId: providers[0]!.id, model: 'frozen-model' });
    expect(f.preview.mock.calls[0]![0]).not.toHaveProperty('text'); expect(f.generate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Generate candidate once' })); await waitFor(() => expect(f.generate).toHaveBeenCalledOnce());
    expect(f.generate.mock.calls[0]![0].id).toBe(batchId); expect(screen.queryByRole('button', { name: 'Generate candidate once' })).not.toBeInTheDocument(); expect(f.apply).not.toHaveBeenCalled();
  });

  it('uses host eligibility and leaves an empty source set unselectable', async () => {
    const f = fixture([], []); mount(); await waitFor(() => expect(f.sources).toHaveBeenCalledWith(sessionId));
    expect(screen.getByText(/No currently eligible memories/)).toBeInTheDocument(); expect(screen.queryByRole('checkbox', { name: /^Select source/u })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review selected sources' })).toBeDisabled(); expect(f.preview).not.toHaveBeenCalled();
  });

  it('reuses the exact preview operation after lost confirmation and blocks duplicate clicks or edits meanwhile', async () => {
    const f = fixture(); let fail: ((cause: Error) => void) | undefined;
    f.preview.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; })); mount(); await chooseSources();
    const button = screen.getByRole('button', { name: 'Review selected sources' }); fireEvent.click(button); fireEvent.click(button); expect(f.preview).toHaveBeenCalledOnce();
    await act(async () => fail?.(new Error('repository.commitUncertain'))); expect(await screen.findByRole('alert')).toHaveTextContent('Operation unconfirmed');
    expect(screen.getByRole('combobox', { name: 'Consolidation provider' })).toBeDisabled(); expect(screen.getByRole('checkbox', { name: `Select source ${sourceId}` })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Recover this operation' })); await waitFor(() => expect(f.preview).toHaveBeenCalledTimes(2));
    expect(f.preview.mock.calls[1]![0]).toEqual(f.preview.mock.calls[0]![0]); expect(f.generate).not.toHaveBeenCalled();
  });

  it('does not reopen candidate content or regenerate on mount; explicit review safely displays text', async () => {
    const malicious = '<img src="https://invalid.example/remote.png" onerror="alert(1)"><script>run()</script>';
    const c = { ...candidate, segments: [{ text: malicious, sourceIds: [sourceId] }] };
    const f = fixture([savedBatch('review', { candidate: c, rawResponse: malicious })]); const rendered = mount();
    await screen.findByRole('button', { name: 'Review batch' }); expect(screen.queryByText(malicious)).not.toBeInTheDocument(); expect(f.generate).not.toHaveBeenCalled();
    await openReview(); expect(screen.getAllByText(malicious).length).toBeGreaterThan(0); expect(rendered.container.querySelector('img')).toBeNull(); expect(rendered.container.querySelector('script')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Use this summary for eligible requests' })).not.toBeChecked(); expect(screen.getByRole('button', { name: 'Confirm reviewed version' })).toBeDisabled();
  });

  it('requires saving an edited candidate and reviewing its new version before applying', async () => {
    const f = fixture([savedBatch('review')]); mount(); await openReview(); fireEvent.click(fidelityBox());
    const next = { ...candidate, segments: [{ text: 'Weekdays only: A takes 12 mg; never on public holidays.', sourceIds: [sourceId] }] };
    fireEvent.change(screen.getByRole('textbox', { name: 'Candidate JSON' }), { target: { value: JSON.stringify(next, null, 2) } });
    expect(fidelityBox()).not.toBeChecked(); expect(fidelityBox()).toBeDisabled(); expect(screen.getByRole('button', { name: 'Confirm reviewed version' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save candidate edit' })); await waitFor(() => expect(f.edit).toHaveBeenCalledOnce());
    expect(f.edit.mock.calls[0]![0]).toMatchObject({ id: batchId, expectedVersion: 1, candidate: next }); await waitFor(() => expect(fidelityBox()).toBeEnabled());
    expect(fidelityBox()).not.toBeChecked(); fireEvent.click(fidelityBox()); fireEvent.click(screen.getByRole('button', { name: 'Confirm reviewed version' }));
    await waitFor(() => expect(f.apply).toHaveBeenCalledOnce()); expect(f.apply.mock.calls[0]![0]).toMatchObject({ id: batchId, expectedVersion: 2, fidelityReviewed: true, enableRepresentation: false });
  });

  it('never submits malformed candidate JSON or silently creates a repair generation', async () => {
    const f = fixture([savedBatch('review')]); mount(); await openReview();
    fireEvent.change(screen.getByRole('textbox', { name: 'Candidate JSON' }), { target: { value: '{"segments":[]}' } }); fireEvent.click(screen.getByRole('button', { name: 'Save candidate edit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No edit was submitted'); expect(f.edit).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
  });

  it('retains exact application version and enable choice when confirmation is unknown', async () => {
    const f = fixture([savedBatch('review')]); f.apply.mockRejectedValueOnce(new Error('repository.commitUncertain')); mount(); await openReview();
    fireEvent.click(fidelityBox()); fireEvent.click(screen.getByRole('checkbox', { name: 'Use this summary for eligible requests' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm reviewed version' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Operation unconfirmed'); expect(screen.getByRole('textbox', { name: 'Candidate JSON' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Recover this operation' })); await waitFor(() => expect(f.apply).toHaveBeenCalledTimes(2));
    expect(f.apply.mock.calls[1]![0]).toEqual(f.apply.mock.calls[0]![0]); expect(f.apply.mock.calls[1]![0]).toMatchObject({ expectedVersion: 1, enableRepresentation: true });
  });

  it('keeps a stale-version rejection unapplied and leaves review available', async () => {
    const f = fixture([savedBatch('review')]); f.apply.mockRejectedValueOnce(new Error('consolidation.staleCandidate')); mount(); await openReview();
    fireEvent.click(fidelityBox()); fireEvent.click(screen.getByRole('button', { name: 'Confirm reviewed version' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('host rejected'); expect(screen.getByRole('textbox', { name: 'Candidate JSON' })).toBeEnabled(); expect(screen.queryByRole('button', { name: 'Disable summary' })).not.toBeInTheDocument(); expect(f.generate).not.toHaveBeenCalled();
  });

  it('shows partial/conflicted coverage but cannot select it for normal requests', async () => {
    const f = fixture([savedBatch('review', { candidate: { ...candidate, uncoveredMemoryIds: [sourceId], conflicts: ['Unresolved weekday definition.'] } })]); mount(); await openReview();
    expect(screen.getByRole('checkbox', { name: 'Use this summary for eligible requests' })).toBeDisabled(); expect(screen.getByText('Unresolved weekday definition.')).toBeInTheDocument();
    fireEvent.click(fidelityBox()); fireEvent.click(screen.getByRole('button', { name: 'Confirm reviewed version' })); await waitFor(() => expect(f.apply).toHaveBeenCalledOnce()); expect(f.apply.mock.calls[0]![0].enableRepresentation).toBe(false);
  });

  it('updates an open review to the host-redacted invalid state instead of retaining obsolete body text', async () => {
    const f = fixture([savedBatch('review')]); mount(); await openReview(); expect(screen.getAllByText(source.text).length).toBeGreaterThan(0);
    await act(async () => f.setBatches([savedBatch('invalid', { candidate: null, rawResponse: null, sources: [{ ...source, text: '' }], invalidReason: 'consolidation.sourceChanged', active: false })]));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Candidate JSON' })).not.toBeInTheDocument());
    expect(screen.queryByText(candidate.segments[0]!.text)).not.toBeInTheDocument(); expect(screen.getByText('consolidation.sourceChanged')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Confirm reviewed version' })).not.toBeInTheDocument();
  });

  it('disables only an explicitly enabled saved summary and never regenerates it', async () => {
    const f = fixture([savedBatch('applied')]); mount(); await openReview(); fireEvent.click(screen.getByRole('button', { name: 'Disable summary' }));
    await waitFor(() => expect(f.disable).toHaveBeenCalledOnce()); expect(f.disable.mock.calls[0]![0]).toMatchObject({ id: batchId }); expect(screen.queryByRole('button', { name: 'Disable summary' })).not.toBeInTheDocument();
    expect(f.generate).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
  });

  it('clears old ownership on session switch and ignores a late read from the old session', async () => {
    const f = fixture([savedBatch('review')]); let resolve: ((batch: ConsolidationBatch) => void) | undefined;
    f.get.mockImplementationOnce(() => new Promise((accept) => { resolve = accept; })); const view = mount(); fireEvent.click(await screen.findByRole('button', { name: 'Review batch' }));
    view.rerender(<MemoryConsolidation providers={providers} sessionId={otherSessionId} locale="en" />);
    await act(async () => resolve?.(savedBatch('review'))); expect(screen.queryByRole('textbox', { name: 'Candidate JSON' })).not.toBeInTheDocument(); expect(f.generate).not.toHaveBeenCalled();
    await waitFor(() => expect(f.list).toHaveBeenCalledWith(otherSessionId)); expect(within(screen.getByRole('region', { name: 'Saved batches' })).queryByRole('button', { name: 'Review batch' })).not.toBeInTheDocument();
  });

  it('opens the selected saved candidate for review without generating or applying it', async () => {
    const f = fixture([savedBatch('review')]);
    render(<MemoryConsolidation providers={providers} sessionId={sessionId} locale="en" openBatchId={batchId} />);
    const review = await screen.findByRole('region', { name: 'Consolidation candidate review' });
    expect(review).toHaveAttribute('data-reviewed-batch-id', batchId);
    await waitFor(() => expect(review).toHaveFocus());
    expect(screen.getByRole('textbox', { name: 'Candidate JSON' })).toHaveValue(JSON.stringify(candidate, null, 2));
    expect(f.get).toHaveBeenCalledExactlyOnceWith(batchId); expect(f.generate).not.toHaveBeenCalled(); expect(f.preview).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
    expect(fidelityBox()).not.toBeChecked();
  });

  it('refuses a direct candidate read from a different parent session', async () => {
    const f = fixture([savedBatch('review', { sessionId: otherSessionId })]);
    render(<MemoryConsolidation providers={providers} sessionId={sessionId} locale="en" openBatchId={batchId} />);
    await screen.findByRole('alert'); expect(screen.queryByRole('textbox', { name: 'Candidate JSON' })).not.toBeInTheDocument(); expect(f.apply).not.toHaveBeenCalled();
  });

  it('discards a delayed first candidate when another attention target has been opened', async () => {
    const secondId = '58c81f89-ab86-4397-bad0-dd599c099c86';
    const secondCandidate = { ...candidate, segments: [{ text: 'CURRENT_SECOND_CANDIDATE', sourceIds: [sourceId] }] };
    const f = fixture([savedBatch('review'), savedBatch('review', { id: secondId, candidate: secondCandidate })]);
    let resolve: ((value: ConsolidationBatch) => void) | undefined;
    f.get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const view = render(<MemoryConsolidation providers={providers} sessionId={sessionId} locale="en" openBatchId={batchId} />);
    view.rerender(<MemoryConsolidation providers={providers} sessionId={sessionId} locale="en" openBatchId={secondId} />);
    await screen.findByRole('textbox', { name: 'Candidate JSON' });
    await act(async () => resolve?.(savedBatch('review')));
    expect(screen.getByRole('textbox', { name: 'Candidate JSON' })).toHaveValue(JSON.stringify(secondCandidate, null, 2)); expect(f.generate).not.toHaveBeenCalled();
  });

});
