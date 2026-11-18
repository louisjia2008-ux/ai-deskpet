import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeskPetApi, ProviderConfig } from '../../shared';
import type { DelegationBatch, DelegationDraft, DelegationResult, DelegationSubmit } from '../../shared/delegations';
import { Delegations } from './Delegations';

const sessionId = '7ee9aa14-8a5f-4a02-998f-3ee3b17570eb';
const nextSessionId = 'a5a23038-9db5-4bec-98fd-2de5746cfbc6';
const providers: ProviderConfig[] = [
  { id: 'bb22a70e-03b7-4eb1-9a90-1cd7ef9c3fbe', name: 'Provider A', kind: 'ollama', baseUrl: 'http://127.0.0.1:19101/v1', model: 'model-a', enabled: true, supportsTools: true, secretState: 'missing', localExecutionConfirmed: true },
  { id: '2231e3fd-88ba-413f-a2ad-8ddd1554a81b', name: 'Provider B', kind: 'lm-studio', baseUrl: 'http://127.0.0.1:19102/v1', model: 'model-b', enabled: true, supportsTools: true, secretState: 'missing', localExecutionConfirmed: true },
];
const draft: DelegationDraft = { sessionId, intentVersion: 1, goal: 'SYNTHETIC_PARENT_GOAL', currentBatchId: null };
const batchFrom = (input: DelegationSubmit): DelegationBatch => ({
  id: 'd7d01dd2-f7df-4507-b145-1d99d10b3183', profileId: '81751e07-ae6f-43fc-bae1-dd6731807c80', sessionId: input.sessionId,
  operationId: input.operationId, intentVersion: input.intentVersion, goal: input.goal, deadlineAt: input.deadlineAt,
  createdAt: '2026-10-28T00:00:00.000Z', cancelRequestedAt: null, historicalAt: null, status: 'active',
  budget: { maxEstimatedTokens: input.budget?.maxEstimatedTokens ?? 0, maxRequests: input.children.length, settledTokens: 0, outstandingTokens: 2000 * input.children.length, releasedTokens: 0, reservedRequests: input.children.length },
  children: input.children.map((child, index) => ({ id: `child-${index + 1}`, jobId: `job-${index + 1}`, sessionId: `independent-session-${index + 1}`,
    instruction: child.instruction, providerName: providers.find((provider) => provider.id === child.providerId)?.name ?? 'Unknown', model: child.model,
    status: 'queued', completionReason: null, finishReason: null, checks: child.requirements.map((rule) => ({ id: rule.id, kind: rule.kind, status: 'unchecked' })),
    factVerification: 'unverified', reservation: { reservedTokens: 2000, chargedTokens: 0, state: 'reserved', reportedTokens: null },
  })),
});
const submitted = (): DelegationSubmit => ({ operationId: crypto.randomUUID(), sessionId, intentVersion: 1, goal: 'SAVED_PARENT_GOAL',
  deadlineAt: '2026-10-28T00:10:00.000Z', budget: { maxEstimatedTokens: 12000, maxRequests: 3 }, children: [
    { instruction: 'SAVED_CHILD_A', material: 'A_ONLY', privacy: 'local-only', providerId: providers[0]!.id, model: 'model-a', requirements: [] },
    { instruction: 'SAVED_CHILD_B', material: 'B_ONLY', privacy: 'local-only', providerId: providers[1]!.id, model: 'model-b', requirements: [] },
  ] });
const fixture = (initial: DelegationBatch[] = []) => {
  let batches = initial; let changed: (() => void) | undefined;
  const resultByChild = new Map<string, DelegationResult>();
  const list = vi.fn<DeskPetApi['delegations']['list']>(async (id) => structuredClone(batches.filter((batch) => batch.sessionId === id)));
  const submit = vi.fn<DeskPetApi['delegations']['submit']>(async (input) => {
    const batch = batches.find((item) => item.operationId === input.operationId) ?? batchFrom(input); batches = [batch, ...batches.filter((item) => item.id !== batch.id)]; return structuredClone(batch);
  });
  const getResult = vi.fn<DeskPetApi['delegations']['getResult']>(async ({ batchId, childId }) => {
    const batch = batches.find((item) => item.id === batchId)!; const child = batch.children.find((item) => item.id === childId)!;
    return structuredClone(resultByChild.get(childId) ?? { batchId, childId, sessionId: child.sessionId, status: child.status, completionReason: child.completionReason,
      finishReason: child.finishReason, result: null, checks: [], factVerification: 'unverified', historical: batch.historicalAt !== null });
  });
  const cancelChild = vi.fn<DeskPetApi['delegations']['cancelChild']>(async ({ batchId, childId }) => {
    batches = batches.map((batch) => batch.id === batchId ? { ...batch, status: 'partial', children: batch.children.map((child) => child.id === childId ? { ...child, status: 'cancelled' } : child) } : batch); changed?.(); return structuredClone(batches.find((batch) => batch.id === batchId)!);
  });
  const cancelBatch = vi.fn<DeskPetApi['delegations']['cancelBatch']>(async (id) => {
    batches = batches.map((batch) => batch.id === id ? { ...batch, status: 'cancelled', cancelRequestedAt: '2026-10-28T00:01:00.000Z', children: batch.children.map((child) => child.status === 'succeeded' ? child : { ...child, status: 'cancelled' }) } : batch); changed?.(); return structuredClone(batches.find((batch) => batch.id === id)!);
  });
  const replace = vi.fn<DeskPetApi['delegations']['replace']>(async ({ batchId, goal }) => {
    const old = batches.find((batch) => batch.id === batchId)!;
    batches = batches.map((batch) => batch.id === batchId ? { ...batch, historicalAt: '2026-10-28T00:01:00.000Z', status: 'historical' } : batch); changed?.();
    return { sessionId: old.sessionId, intentVersion: old.intentVersion + 1, goal, currentBatchId: null };
  });
  const unsubscribe = vi.fn();
  const listModels = vi.fn(async (id: string) => (id === providers[0]!.id ? ['model-a', 'child-special'] : ['model-b', 'child-b-special']).map((model) => ({ id: model, displayName: model, contextWindow: null, supportsTools: false })));
  const setModel = vi.fn();
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { providers: { listModels, setModel }, delegations: { list, submit, getResult, cancelBatch, cancelChild, replace,
    openDraft: vi.fn(async () => draft), onChanged: (listener: () => void) => { changed = listener; return unsubscribe; } } } });
  return { list, submit, getResult, cancelBatch, cancelChild, replace, unsubscribe, listModels, setModel, resultByChild, setBatches: (value: DelegationBatch[]) => { batches = value; changed?.(); } };
};
const fillChild = (index: number, providerIndex = 0): void => {
  fireEvent.change(screen.getByRole('textbox', { name: `Child ${index} instruction` }), { target: { value: `CHILD_${index}_INSTRUCTION` } });
  fireEvent.change(screen.getByRole('textbox', { name: `Child ${index} selected material (paste text)` }), { target: { value: `CHILD_${index}_ONLY_MATERIAL` } });
  fireEvent.change(screen.getByRole('combobox', { name: `Child ${index} provider` }), { target: { value: providers[providerIndex]!.id } });
};
const renderDraft = () => {
  const onDraftChange = vi.fn(); render(<Delegations sessionId={sessionId} providers={providers} locale="en" draft={draft} onDraftChange={onDraftChange} />); return onDraftChange;
};
afterEach(cleanup);

describe('controlled delegation UI', () => {
  it('requires an explicit binding for each child, reviews separate materials/rules and limits the editor to three', async () => {
    const f = fixture(); renderDraft();
    expect(screen.queryByRole('spinbutton', { name: /budget|requests/i })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Child 1 provider' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Child 1 model' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Child 1 instruction' })).toHaveAttribute('maxlength', '16000');
    expect(screen.getByRole('textbox', { name: 'Child 1 selected material (paste text)' })).toHaveAttribute('maxlength', '16000');
    expect(screen.getByRole('button', { name: 'Submit delegation' })).toBeDisabled();
    fillChild(1); fireEvent.click(screen.getByRole('button', { name: 'Add child' })); fillChild(2, 1);
    expect(screen.getByRole('combobox', { name: 'Child 2 model' })).toHaveValue('model-b');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Child 1 Exact full-text requirement' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Child 1 expected full text' }), { target: { value: 'EXACT_RESULT' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Child 2 English word-count requirement' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Child 2 other requirements (unchecked)' }), { target: { value: 'Be scientifically correct' } });
    const preview = screen.getByText('Delegation submission preview').parentElement!;
    expect(preview).toHaveTextContent('CHILD_1_ONLY_MATERIAL'); expect(preview).toHaveTextContent('CHILD_2_ONLY_MATERIAL');
    expect(preview).toHaveTextContent('Provider A'); expect(preview).toHaveTextContent('Provider B'); expect(preview).toHaveTextContent('EXACT_RESULT');
    fireEvent.click(screen.getByRole('button', { name: 'Submit delegation' }));
    await waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    const payload = f.submit.mock.calls[0]![0];
    expect(payload.children).toHaveLength(2); expect(payload.children[0]).toMatchObject({ material: 'CHILD_1_ONLY_MATERIAL', providerId: providers[0]!.id, model: 'model-a', privacy: 'local-only' });
    expect(payload.children[1]).toMatchObject({ material: 'CHILD_2_ONLY_MATERIAL', providerId: providers[1]!.id, model: 'model-b', privacy: 'local-only' });
    expect(payload.children[0]?.requirements[0]).toMatchObject({ kind: 'exact-text', expected: 'EXACT_RESULT' });
    expect(payload.children[1]?.requirements.map((rule) => rule.kind)).toEqual(['english-word-count', 'unimplemented']);
    expect(payload).not.toHaveProperty('budget'); expect(f.getResult).not.toHaveBeenCalled();
  });

  it('shows reported token records and unknown children without exposing old budget limits', async () => {
    const saved = batchFrom(submitted()); saved.budget.maxEstimatedTokens = 1;
    saved.children[0]!.reservation = { reservedTokens: 2000, chargedTokens: 1000010, state: 'settled', reportedTokens: 1000010 };
    const f = fixture([saved]); void f;
    render(<Delegations sessionId={sessionId} providers={providers} locale="en" draft={null} onDraftChange={vi.fn()} />);
    const card = await screen.findByRole('article', { name: saved.goal });
    expect(card).toHaveTextContent('1000010');
    const summary = card.querySelector('.delegation-usage-summary')!;
    expect(summary).toHaveTextContent('Children with unknown usage1'); expect(summary).toHaveTextContent('Child requests2');
    expect(screen.queryByText(/admission|allowance|budget/i, { selector: 'dt' })).not.toBeInTheDocument();
    expect(within(card).getAllByText('Reported tokens: Unknown')).toHaveLength(1);
  });

  it('selects each subagent model from its own catalog without changing main chat or siblings', async () => {
    const f = fixture(); renderDraft(); fillChild(1);
    fireEvent.click(screen.getByRole('button', { name: 'Add child' })); fillChild(2, 1);
    const firstPicker = screen.getByRole('combobox', { name: 'Child 1 model' });
    const secondPicker = screen.getByRole('combobox', { name: 'Child 2 model' });
    await waitFor(() => expect(within(firstPicker).getByRole('option', { name: /^child-special/u })).toBeInTheDocument());
    await waitFor(() => expect(within(secondPicker).getByRole('option', { name: /^child-b-special/u })).toBeInTheDocument());
    fireEvent.change(firstPicker, { target: { value: 'child-special' } });
    expect(secondPicker).toHaveValue('model-b'); expect(providers[0]!.model).toBe('model-a');
    fireEvent.change(secondPicker, { target: { value: 'child-b-special' } });
    expect(firstPicker).toHaveValue('child-special'); expect(f.setModel).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Submit delegation' }));
    await waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    expect(f.submit.mock.calls[0]![0].children.map((child) => child.model)).toEqual(['child-special', 'child-b-special']);
    expect(f.setModel).not.toHaveBeenCalled();
  });

  it('never offers a fourth editor and never starts a task merely by editing or closing a draft', async () => {
    const f = fixture(); const changed = renderDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Add child' })); fireEvent.click(screen.getByRole('button', { name: 'Add child' }));
    expect(screen.getAllByRole('group', { name: /^Child \d$/u })).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Add child' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Delegation goal' }), { target: { value: 'EDITED_DRAFT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close draft' }));
    expect(changed).toHaveBeenCalledWith(null); expect(f.submit).not.toHaveBeenCalled(); expect(f.cancelBatch).not.toHaveBeenCalled();
  });

  it('reuses one operation, deadline and exact payload after an unconfirmed submission, blocking duplicate clicks', async () => {
    const f = fixture(); let reject: ((error: Error) => void) | undefined;
    f.submit.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })); renderDraft(); fillChild(1);
    const submit = screen.getByRole('button', { name: 'Submit delegation' }); fireEvent.click(submit); fireEvent.click(submit);
    expect(f.submit).toHaveBeenCalledOnce(); expect(screen.getByRole('textbox', { name: 'Delegation goal' })).toBeDisabled();
    await act(async () => reject?.(new Error('repository.commitUncertain')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Submission unconfirmed');
    expect(screen.getByRole('textbox', { name: 'Child 1 selected material (paste text)' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Recover this submission' }));
    await waitFor(() => expect(f.submit).toHaveBeenCalledTimes(2));
    expect(f.submit.mock.calls[1]![0]).toEqual(f.submit.mock.calls[0]![0]);
  });

  it('allows a new explicit submission after a definite binding rejection', async () => {
    const f = fixture(); f.submit.mockRejectedValueOnce(new Error('provider.bindingMismatch')); renderDraft(); fillChild(1);
    fireEvent.click(screen.getByRole('button', { name: 'Submit delegation' })); expect(await screen.findByRole('alert')).toHaveTextContent('rejected before acceptance');
    expect(screen.getByRole('textbox', { name: 'Delegation goal' })).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Child 1 instruction' }), { target: { value: 'REVIEWED_CHILD_INSTRUCTION' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit delegation' })); await waitFor(() => expect(f.submit).toHaveBeenCalledTimes(2));
    expect(f.submit.mock.calls[1]![0].operationId).not.toBe(f.submit.mock.calls[0]![0].operationId);
    expect(f.submit.mock.calls[1]![0].children[0]?.instruction).toBe('REVIEWED_CHILD_INSTRUCTION'); expect(f.submit.mock.calls[1]![0]).not.toHaveProperty('budget');
  });

  it('rejects an oversized UTF-8 envelope locally without sending IPC and leaves the draft editable', async () => {
    const f = fixture(); renderDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Add child' })); fireEvent.click(screen.getByRole('button', { name: 'Add child' }));
    for (const index of [1, 2, 3]) {
      fillChild(index);
      fireEvent.change(screen.getByRole('textbox', { name: `Child ${index} instruction` }), { target: { value: '文'.repeat(16000) } });
      fireEvent.change(screen.getByRole('textbox', { name: `Child ${index} selected material (paste text)` }), { target: { value: '料'.repeat(16000) } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Submit delegation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('rejected before acceptance'); expect(f.submit).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Child 1 instruction' })).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Child 1 instruction' }), { target: { value: 'SMALLER_EXPLICIT_INSTRUCTION' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Child 1 selected material (paste text)' }), { target: { value: 'SMALLER_EXPLICIT_MATERIAL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit delegation' })); await waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
  });

  it('keeps provider-controlled raw finish text hidden until explicit result viewing', async () => {
    const batch = batchFrom(submitted()); const marker = 'PROVIDER_FINISH_REASON_HIDDEN_BODY';
    batch.children[0] = { ...batch.children[0]!, status: 'succeeded', completionReason: 'job.completed', finishReason: null };
    const f = fixture([batch]); f.resultByChild.set('child-1', { batchId: batch.id, childId: 'child-1', sessionId: 'independent-session-1', status: 'succeeded',
      completionReason: marker, finishReason: marker, result: marker, checks: [], factVerification: 'unverified', historical: false });
    const view = render(<Delegations sessionId={sessionId} providers={providers} locale="en" draft={null} onDraftChange={vi.fn()} />);
    const card = await screen.findByRole('article', { name: 'SAVED_CHILD_A' });
    expect(view.container.textContent).not.toContain(marker); expect(view.container.innerHTML).not.toContain(marker); expect(f.getResult).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: 'View result' }));
    const result = await screen.findByRole('region', { name: 'Child result' }); expect(result.querySelector('[data-result-body]')?.textContent).toBe(marker);
    expect(result).toHaveTextContent(`Original finish reason: ${marker}`);
  });

  it('separates execution, mixed check outcomes and unverified facts without leaking result or actual counts before viewing', async () => {
    const batch = batchFrom(submitted()); batch.status = 'partial';
    batch.children[0] = { ...batch.children[0]!, status: 'succeeded', completionReason: 'stop', finishReason: 'stop', checks: [
      { id: 'r1', kind: 'exact-text', status: 'passed' }, { id: 'r2', kind: 'english-word-count', status: 'failed' }, { id: 'r3', kind: 'unimplemented', status: 'unchecked' },
    ] };
    const f = fixture([batch]); const body = '<img src="https://synthetic.invalid/tracker"><script>verified()</script>\nCLAIMED_VERIFIED_RESULT';
    f.resultByChild.set('child-1', { batchId: batch.id, childId: 'child-1', sessionId: 'independent-session-1', status: 'succeeded', completionReason: 'stop', finishReason: 'stop', result: body,
      checks: [{ id: 'r1', kind: 'exact-text', status: 'passed', policy: 'nfc-crlf-full-body-v1' }, { id: 'r2', kind: 'english-word-count', status: 'failed', actualWordCount: 17, policy: 'ascii-words-v1' }, { id: 'r3', kind: 'unimplemented', status: 'unchecked', policy: 'unsupported' }], factVerification: 'unverified', historical: false });
    const { container } = render(<Delegations sessionId={sessionId} providers={providers} locale="en" draft={null} onDraftChange={vi.fn()} />);
    const card = await screen.findByRole('article', { name: 'SAVED_CHILD_A' });
    expect(card).toHaveTextContent('Execution status: Execution ended'); expect(card).toHaveTextContent('Exact full text 1: Passed');
    expect(card).toHaveTextContent('English word range 2: Failed'); expect(card).toHaveTextContent('Other requirement 3: Unchecked');
    expect(card).toHaveTextContent('Fact verification: Unverified'); expect(container).not.toHaveTextContent(body);
    expect(screen.queryByText(/Actual English words/u)).not.toBeInTheDocument(); expect(f.getResult).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: 'View result' })); const result = await screen.findByRole('region', { name: 'Child result' });
    expect(f.getResult).toHaveBeenCalledExactlyOnceWith({ batchId: batch.id, childId: 'child-1' });
    expect(result.querySelector('[data-result-body]')?.textContent).toBe(body); expect(result.querySelector('img')).toBeNull(); expect(result.querySelector('script')).toBeNull();
    expect(result).toHaveTextContent('Actual English words: 17'); expect(result).toHaveTextContent('Fact verification: Unverified');
  });

  it('identifies the displayed child and clears an old result when another explicit read fails', async () => {
    const batch = batchFrom(submitted()); const f = fixture([batch]);
    f.resultByChild.set('child-1', { batchId: batch.id, childId: 'child-1', sessionId: 'independent-session-1', status: 'succeeded', completionReason: 'stop', finishReason: 'stop', result: 'FIRST_CHILD_SAVED_BODY', checks: [], factVerification: 'unverified', historical: false });
    render(<Delegations sessionId={sessionId} providers={providers} locale="en" draft={null} onDraftChange={vi.fn()} />);
    fireEvent.click(within(await screen.findByRole('article', { name: 'SAVED_CHILD_A' })).getByRole('button', { name: 'View result' }));
    const result = await screen.findByRole('region', { name: 'Child result' }); expect(result).toHaveTextContent('SAVED_CHILD_A');
    expect(result.querySelector('[data-result-child-id]')).toHaveAttribute('data-result-child-id', 'child-1');
    f.getResult.mockRejectedValueOnce(new Error('repository.commitUncertain'));
    fireEvent.click(within(screen.getByRole('article', { name: 'SAVED_CHILD_B' })).getByRole('button', { name: 'View result' }));
    await screen.findByRole('alert'); expect(screen.queryByText('FIRST_CHILD_SAVED_BODY')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Child result' })).not.toBeInTheDocument();
  });

  it('targets child cancellation separately, preserves its sibling and never cancels when the component unmounts', async () => {
    const batch = batchFrom(submitted()); const f = fixture([batch]);
    const view = render(<Delegations sessionId={sessionId} providers={providers} locale="en" draft={null} onDraftChange={vi.fn()} />);
    const a = await screen.findByRole('article', { name: 'SAVED_CHILD_A' });
    fireEvent.click(within(a).getByRole('button', { name: 'Cancel child' }));
    await waitFor(() => expect(a).toHaveTextContent('Cancelled locally'));
    expect(f.cancelChild).toHaveBeenCalledExactlyOnceWith({ batchId: batch.id, childId: 'child-1' });
    expect(screen.getByRole('article', { name: 'SAVED_CHILD_B' })).toHaveTextContent('Execution status: Queued'); expect(f.cancelBatch).not.toHaveBeenCalled();
    view.unmount(); expect(f.unsubscribe).toHaveBeenCalledOnce(); expect(f.cancelChild).toHaveBeenCalledOnce();
  });

  it('preserves completed child cards when the batch is cancelled', async () => {
    const batch = batchFrom(submitted()); batch.status = 'partial'; batch.children[0] = { ...batch.children[0]!, status: 'succeeded' }; const f = fixture([batch]);
    render(<Delegations sessionId={sessionId} providers={providers} locale="en" draft={null} onDraftChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel batch' }));
    await waitFor(() => expect(screen.getByRole('article', { name: 'SAVED_CHILD_B' })).toHaveTextContent('Cancelled locally'));
    expect(f.cancelBatch).toHaveBeenCalledExactlyOnceWith(batch.id); expect(screen.getByRole('article', { name: 'SAVED_CHILD_A' })).toHaveTextContent('Execution status: Execution ended');
  });

  it('replaces an explicit goal into a new unsubmitted draft, retains old cards as history and clears open result', async () => {
    const batch = batchFrom(submitted()); const f = fixture([batch]);
    const Controlled = () => { const [value, setValue] = useState<DelegationDraft | null>(null); return <Delegations sessionId={sessionId} providers={providers} locale="en" draft={value} onDraftChange={setValue} />; };
    render(<Controlled />); const card = await screen.findByRole('article', { name: 'SAVED_CHILD_A' });
    fireEvent.click(within(card).getByRole('button', { name: 'View result' })); await screen.findByRole('region', { name: 'Child result' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Replacement goal' }), { target: { value: 'EXPLICIT_NEW_GOAL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace goal' }));
    await screen.findByRole('form', { name: 'Delegation draft' });
    expect(f.replace).toHaveBeenCalledExactlyOnceWith({ batchId: batch.id, operationId: expect.any(String), goal: 'EXPLICIT_NEW_GOAL' });
    expect(screen.getByRole('textbox', { name: 'Delegation goal' })).toHaveValue('EXPLICIT_NEW_GOAL');
    expect(screen.getByRole('combobox', { name: 'Child 1 provider' })).toHaveValue(''); expect(f.submit).not.toHaveBeenCalled();
    expect(screen.getByRole('article', { name: 'SAVED_PARENT_GOAL' })).toHaveTextContent('Historical goal');
    expect(screen.queryByRole('region', { name: 'Child result' })).not.toBeInTheDocument();
  });

  it('recovers an unknown goal replacement using its original operation and goal', async () => {
    const batch = batchFrom(submitted()); const f = fixture([batch]); f.replace.mockRejectedValueOnce(new Error('repository.commitUncertain'));
    render(<Delegations sessionId={sessionId} providers={providers} locale="en" draft={null} onDraftChange={vi.fn()} />);
    const replacement = await screen.findByRole('textbox', { name: 'Replacement goal' });
    fireEvent.change(replacement, { target: { value: 'REPLACEMENT_WITH_UNCERTAIN_ACK' } }); fireEvent.click(screen.getByRole('button', { name: 'Replace goal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not confirmed'); expect(replacement).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Recover goal replacement' })); await waitFor(() => expect(f.replace).toHaveBeenCalledTimes(2));
    expect(f.replace.mock.calls[1]![0]).toEqual(f.replace.mock.calls[0]![0]); expect(f.submit).not.toHaveBeenCalled();
  });

  it('does not retain another chat’s cards or late result when the parent session changes', async () => {
    const batch = batchFrom(submitted()); const f = fixture([batch]); let resolve: ((result: DelegationResult) => void) | undefined;
    f.getResult.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const view = render(<Delegations sessionId={sessionId} providers={providers} locale="en" draft={null} onDraftChange={vi.fn()} />);
    fireEvent.click(within(await screen.findByRole('article', { name: 'SAVED_CHILD_A' })).getByRole('button', { name: 'View result' }));
    view.rerender(<Delegations sessionId={nextSessionId} providers={providers} locale="en" draft={null} onDraftChange={vi.fn()} />);
    await act(async () => resolve?.({ batchId: batch.id, childId: 'child-1', sessionId: 'old-independent-session', status: 'succeeded', completionReason: 'stop', finishReason: 'stop', result: 'LATE_OLD_CHAT_RESULT', checks: [], factVerification: 'unverified', historical: false }));
    expect(screen.queryByRole('article', { name: 'SAVED_CHILD_A' })).not.toBeInTheDocument(); expect(screen.queryByRole('region', { name: 'Child result' })).not.toBeInTheDocument();
    expect(screen.queryByText('LATE_OLD_CHAT_RESULT')).not.toBeInTheDocument(); expect(f.cancelBatch).not.toHaveBeenCalled();
  });

  it('focuses the selected parent batch from attention without reading or generating child results', async () => {
    const batch = batchFrom(submitted()); const f = fixture([batch]);
    render(<Delegations sessionId={sessionId} providers={providers} locale="en" draft={null} onDraftChange={vi.fn()} focusBatchId={batch.id} />);
    const card = await screen.findByRole('article', { name: batch.goal });
    expect(card).toHaveAttribute('data-attention-target', 'true'); expect(card).toHaveFocus();
    expect(f.list).toHaveBeenCalledWith(sessionId); expect(f.getResult).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.cancelBatch).not.toHaveBeenCalled();
  });

  it('refuses a result read whose child identity differs from the selected saved child', async () => {
    const batch = batchFrom(submitted()); const f = fixture([batch]);
    f.getResult.mockResolvedValueOnce({ batchId: batch.id, childId: 'wrong-child', sessionId: 'independent-session-1', status: 'succeeded', completionReason: 'stop', finishReason: 'stop', result: 'WRONG_CHILD_BODY', checks: [], factVerification: 'unverified', historical: false });
    render(<Delegations sessionId={sessionId} providers={providers} locale="en" draft={null} onDraftChange={vi.fn()} focusBatchId={batch.id} />);
    fireEvent.click(within(await screen.findByRole('article', { name: 'SAVED_CHILD_A' })).getByRole('button', { name: 'View result' }));
    await screen.findByRole('alert'); expect(screen.queryByText('WRONG_CHILD_BODY')).not.toBeInTheDocument();
  });

  it('ignores an old child read even after navigation leaves and returns to the same parent session', async () => {
    const batch = batchFrom(submitted()); const f = fixture([batch]); let resolve: ((value: DelegationResult) => void) | undefined;
    f.getResult.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const props = { providers, locale: 'en' as const, draft: null, onDraftChange: vi.fn(), focusBatchId: batch.id };
    const view = render(<Delegations {...props} sessionId={sessionId} />);
    fireEvent.click(within(await screen.findByRole('article', { name: 'SAVED_CHILD_A' })).getByRole('button', { name: 'View result' }));
    view.rerender(<Delegations {...props} sessionId={nextSessionId} />); await waitFor(() => expect(f.list).toHaveBeenCalledWith(nextSessionId));
    view.rerender(<Delegations {...props} sessionId={sessionId} />); await screen.findByRole('article', { name: 'SAVED_CHILD_A' });
    await act(async () => resolve?.({ batchId: batch.id, childId: 'child-1', sessionId: 'independent-session-1', status: 'succeeded', completionReason: 'stop', finishReason: 'stop', result: 'STALE_BEFORE_NAVIGATION_BODY', checks: [], factVerification: 'unverified', historical: false }));
    expect(screen.queryByText('STALE_BEFORE_NAVIGATION_BODY')).not.toBeInTheDocument(); expect(screen.queryByRole('region', { name: 'Child result' })).not.toBeInTheDocument(); expect(f.submit).not.toHaveBeenCalled();
  });

});
