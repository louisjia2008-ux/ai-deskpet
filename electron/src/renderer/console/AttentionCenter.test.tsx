import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionAPI, AttentionItem, AttentionSnapshot } from '../../shared/attention';
import { AttentionCenter } from './AttentionCenter';

const item = (kind: AttentionItem['kind'] = 'result', index = 1): AttentionItem => ({
  id: `background-job:${index}`, fingerprint: String(index).padStart(64, '0'), source: kind === 'review' ? 'consolidation' : 'background-job', kind,
  title: `Saved work ${index}`, status: kind === 'review' ? 'review' : kind === 'action' ? 'interrupted' : 'completed', updatedAt: '2026-11-01T13:00:00.000Z',
  target: { kind: kind === 'review' ? 'consolidation' : 'background-job', id: String(index), sessionId: null }, completedChildren: kind === 'action' ? 0 : 1, totalChildren: 1,
});
const snapshotFor = (items: AttentionItem[]): AttentionSnapshot => ({ items, counts: { action: items.filter(value => value.kind === 'action').length, review: items.filter(value => value.kind === 'review').length, result: items.filter(value => value.kind === 'result').length },
  runningCount: 2, olderResults: 1, sourceCounts: { backgroundJobs: items.length, delegations: 0, consolidations: 0 } });
const fixture = (items = [item(), item('action', 2), item('review', 3)]) => {
  let saved = snapshotFor(items), changed: (() => void) | undefined;
  const snapshot = vi.fn<AttentionAPI['snapshot']>(async () => structuredClone(saved));
  const acknowledge = vi.fn<AttentionAPI['acknowledge']>(async input => { saved = snapshotFor(saved.items.filter(value => value.id !== input.id)); });
  const stop = vi.fn(), onOpen = vi.fn();
  const api: AttentionAPI = { snapshot, acknowledge, onChanged: listener => { changed = listener; return stop; } };
  return { api, snapshot, acknowledge, onOpen, stop, replace: (items: AttentionItem[]) => { saved = snapshotFor(items); changed?.(); } };
};
afterEach(cleanup);

describe('attention center', () => {
  it('explains grouped automatic failures and opens diagnostics in place without dispatch or a background job lookup', async () => {
    const notice: AttentionItem = { ...item('result'), id: 'proactive:group', source: 'proactive', kind: 'notice', title: '', status: 'failed',
      target: { kind: 'proactive', id: 'group', sessionId: null }, automaticIssue: { occurrences: 7, providerName: 'OpenAI', model: 'gpt-6.1-sol',
        errorCode: 'provider.unsupportedParameter', firstAt: '2026-11-01T12:00:00.000Z' } };
    const f = fixture([notice]); render(<AttentionCenter api={f.api} locale="zh-CN" onOpen={f.onOpen} />);
    expect(await screen.findByRole('article', { name: '主动问候暂时未成功' })).toBeVisible();
    expect(screen.getByText(/无需回复或批准/)).toBeVisible();
    expect(screen.getByText('近期失败次数: 7')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '查看问候诊断' }));
    expect(screen.getByText(/OpenAI · gpt-6.1-sol/)).toBeVisible();
    expect(screen.getByText(/请求包含此模型不支持的参数/)).toBeVisible();
    expect(f.onOpen).not.toHaveBeenCalled(); expect(f.acknowledge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '移出待处理' }));
    await waitFor(() => expect(screen.queryByRole('article')).not.toBeInTheDocument());
    expect(f.acknowledge).toHaveBeenCalledExactlyOnceWith({ id: notice.id, fingerprint: notice.fingerprint });
  });

  it('opens an existing target without acknowledging or dispatching work, and filters the saved owner list', async () => {
    const f = fixture(); render(<AttentionCenter api={f.api} locale="en" onOpen={f.onOpen} />);
    const result = await screen.findByRole('article', { name: 'Saved work 1' });
    expect(screen.getAllByRole('article')).toHaveLength(3); expect(f.acknowledge).not.toHaveBeenCalled();
    fireEvent.click(within(result).getByRole('button', { name: 'View result' })); expect(f.onOpen).toHaveBeenCalledExactlyOnceWith(item().target);
    expect(f.acknowledge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Ready for review 1' })); expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByRole('article', { name: 'Saved work 3' })).toBeVisible(); expect(f.onOpen).toHaveBeenCalledOnce();
  });

  it('marks only the selected fingerprint and waits for the saved snapshot before removing it', async () => {
    const f = fixture(); render(<AttentionCenter api={f.api} locale="zh-CN" onOpen={f.onOpen} />);
    const result = await screen.findByRole('article', { name: 'Saved work 1' });
    fireEvent.click(within(result).getByRole('button', { name: '标记已查看' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Saved work 1' })).not.toBeInTheDocument());
    expect(f.acknowledge).toHaveBeenCalledExactlyOnceWith({ id: item().id, fingerprint: item().fingerprint }); expect(f.onOpen).not.toHaveBeenCalled();
    act(() => f.replace([item('result', 4)])); expect(await screen.findByRole('article', { name: 'Saved work 4' })).toBeVisible();
  });

  it('keeps a stale item visible until refreshed authority confirms the change', async () => {
    const f = fixture([item()]); f.acknowledge.mockRejectedValueOnce(new Error('attention.stale'));
    render(<AttentionCenter api={f.api} locale="en" onOpen={f.onOpen} />);
    const card = await screen.findByRole('article', { name: 'Saved work 1' }); fireEvent.click(within(card).getByRole('button', { name: 'Mark viewed' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This item has changed'); expect(card).toBeVisible();
  });

  it('retains prior cards after a read failure and renders supplied titles as text', async () => {
    const unsafe = { ...item(), title: '<img src=x onerror="window.syntheticAttack=true">' }, f = fixture([unsafe]);
    render(<AttentionCenter api={f.api} locale="en" onOpen={f.onOpen} />);
    const card = await screen.findByRole('article', { name: unsafe.title }); expect(card.querySelector('img')).toBeNull();
    f.snapshot.mockRejectedValueOnce(new Error('repository.commitUncertain')); act(() => f.replace([unsafe]));
    expect(await screen.findByRole('alert')).toHaveTextContent('the items below are from before'); expect(card).toBeVisible();
    // The failed read offers its own retry; there is no standing refresh button.
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('limits the initial list to fifty cards and permits deliberate expansion', async () => {
    const f = fixture(Array.from({ length: 70 }, (_, index) => item('result', index + 1)));
    render(<AttentionCenter api={f.api} locale="en" onOpen={f.onOpen} />);
    await screen.findByRole('article', { name: 'Saved work 1' }); expect(screen.getAllByRole('article')).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' })); expect(screen.getAllByRole('article')).toHaveLength(70);
  });
});
