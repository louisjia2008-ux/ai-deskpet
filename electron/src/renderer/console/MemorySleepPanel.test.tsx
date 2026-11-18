import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MemorySleepAPI, MemorySleepStatus } from '../../shared/memory-sleep';
import { MemorySleepPanel } from './MemorySleepPanel';

afterEach(cleanup);
const status: MemorySleepStatus = { settings: { enabled: true, hour: 3, timezone: 'Asia/Shanghai' }, running: false, lastRunAt: '2026-11-12T19:00:00.000Z', lastError: null, shallow: 4, deep: 2,
  reports: [{ id: 'r1', at: '2026-11-12T19:00:00.000Z', provider: 'Fixture · m', changes: [
    { id: 'c1', kind: 'merge', before: ['用户住在北京', '用户搬到了上海'], after: '用户现在住在上海', undoneAt: null },
    { id: 'c2', kind: 'drop', before: ['用户今天在调试 CSS'], after: null, undoneAt: '2026-11-12T20:00:00.000Z' },
  ] }] };

it('shows what last night changed and undoes one step', async () => {
  const api: MemorySleepAPI = { status: vi.fn(async () => status), configure: vi.fn(async input => ({ ...status, settings: input })), runNow: vi.fn(async () => status),
    undo: vi.fn(async () => ({ ...status, reports: [{ ...status.reports[0]!, changes: status.reports[0]!.changes.map(change => ({ ...change, undoneAt: '2026-11-12T21:00:00.000Z' })) }] })) };
  const changed = vi.fn(async () => undefined);
  render(<MemorySleepPanel api={api} locale="zh-CN" onMemoryChanged={changed} />);
  expect(await screen.findByText('用户现在住在上海')).toBeTruthy();
  expect(screen.getByText(/浅层 4 条 · 深层 2 条/u)).toBeTruthy();
  expect(screen.getAllByText('已撤销')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  await waitFor(() => expect(api.undo).toHaveBeenCalledExactlyOnceWith({ reportId: 'r1', changeId: 'c1' }));
  await waitFor(() => expect(screen.getAllByText('已撤销')).toHaveLength(2));
  expect(changed).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: '每晚自动整理' }));
  await waitFor(() => expect(api.configure).toHaveBeenCalledWith({ enabled: false, hour: 3, timezone: 'Asia/Shanghai' }));
});
