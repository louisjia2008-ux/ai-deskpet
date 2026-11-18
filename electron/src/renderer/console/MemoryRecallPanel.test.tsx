import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MemoryRecallAPI, MemoryRecallSearchResult } from '../../shared/memory-recall';
import { MemoryRecallPanel } from './MemoryRecallPanel';

afterEach(cleanup);
const result: MemoryRecallSearchResult = { query: '周末散步', mode: 'semantic', reason: 'ready', consideredCount: 2, eligibleCount: 2,
  matches: [{ id: 'memory-1', revision: 1, text: '我喜欢平缓的步道。', tags: ['户外'], privacy: 'local-only', sourceCount: 1, similarity: 0.92 }] };
const setup = (search: MemoryRecallAPI['search'] = async () => result) => {
  const api = { search: vi.fn(search), cancel: vi.fn(async () => undefined) };
  const open = vi.fn();
  const view = render(<MemoryRecallPanel api={api} sessionId="session-1" locale="zh-CN" onOpenMemory={open} />);
  return { api, open, ...view };
};
const start = () => {
  fireEvent.change(screen.getByRole('textbox', { name: '记得的大意' }), { target: { value: ' 周末散步 ' } });
  fireEvent.click(screen.getByRole('button', { name: '在本机查找' }));
};

it('starts only on explicit submit and previews real host matches', async () => {
  const f = setup();
  expect(f.api.search).not.toHaveBeenCalled();
  start();
  expect(await screen.findByText('我喜欢平缓的步道。')).toBeTruthy();
  expect(f.api.search).toHaveBeenCalledWith({ operationId: expect.any(String), sessionId: 'session-1', query: '周末散步' });
  expect(screen.getByText(/按大意检索 2 条记忆/u)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '查看记忆' }));
  expect(f.open).toHaveBeenCalledWith('memory-1');
});

it('labels model-busy fallback as keywords, without claiming semantic success', async () => {
  setup(async () => ({ ...result, mode: 'lexical', reason: 'unavailable', unavailableReason: 'model-busy', consideredCount: 0,
    matches: [{ ...result.matches[0]!, similarity: undefined }].map(({ similarity, ...match }) => { void similarity; return match; }) }));
  start();
  expect(await screen.findByText(/本地模型正在使用中，这次按关键词查找/u)).toBeTruthy();
  expect(screen.queryByText('语义匹配')).toBeNull();
});

it('lets cancellation finish safely and ignores a late successful result', async () => {
  let finish: ((value: MemoryRecallSearchResult) => void) | undefined;
  const f = setup(() => new Promise(resolve => { finish = resolve; }));
  start();
  expect(screen.getByText(/正在准备本机检索/u)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '取消检索' }));
  expect(f.api.cancel).toHaveBeenCalledWith({ operationId: f.api.search.mock.calls[0]![0].operationId });
  expect(screen.getByText(/已派发的本机批次会安全收尾/u)).toBeTruthy();
  finish!(result);
  expect(await screen.findByText('已取消本次检索。')).toBeTruthy();
  expect(screen.queryByText('我喜欢平缓的步道。')).toBeNull();
});

it('cancels when switching conversations and does not show the old scope result', async () => {
  let finish: ((value: MemoryRecallSearchResult) => void) | undefined;
  const f = setup(() => new Promise(resolve => { finish = resolve; }));
  start();
  f.rerender(<MemoryRecallPanel api={f.api} sessionId="another-session" locale="zh-CN" />);
  expect(f.api.cancel).toHaveBeenCalledTimes(1);
  finish!(result);
  await waitFor(() => expect(screen.getByRole('button', { name: '在本机查找' })).not.toBeDisabled());
  expect(screen.queryByText('我喜欢平缓的步道。')).toBeNull();
});

it('clearly reports partial coverage', async () => {
  setup(async () => ({ ...result, mode: 'partial', reason: 'limit', consideredCount: 16, eligibleCount: 120 }));
  start();
  expect(await screen.findByText(/已按大意检索 16 \/ 120 条记忆/u)).toBeTruthy();
});

it('offers only the search question to chat and never copies private match text', async () => {
  const useQuery = vi.fn(), f = setup();
  f.rerender(<MemoryRecallPanel api={f.api} sessionId="session-1" locale="zh-CN" onUseQuery={useQuery} />);
  start(); await screen.findByText('我喜欢平缓的步道。');
  fireEvent.click(screen.getByRole('button', { name: '用这个问题继续聊天' }));
  expect(useQuery).toHaveBeenCalledWith(result.query);
  expect(JSON.stringify(useQuery.mock.calls)).not.toContain(result.matches[0]!.text);
  f.rerender(<MemoryRecallPanel api={f.api} sessionId="session-1" locale="zh-CN" onUseQuery={useQuery} continuationDisabled />);
  expect(screen.getByRole('button', { name: '用这个问题继续聊天' })).toBeDisabled();
});

it('removes a previously displayed result when current memory authority changes', async () => {
  const f = setup();
  f.rerender(<MemoryRecallPanel api={f.api} sessionId="session-1" memoryVersion="1" locale="zh-CN" />);
  start(); await screen.findByText('我喜欢平缓的步道。');
  f.rerender(<MemoryRecallPanel api={f.api} sessionId="session-1" memoryVersion="2" locale="zh-CN" />);
  expect(screen.queryByText('我喜欢平缓的步道。')).toBeNull();
});
