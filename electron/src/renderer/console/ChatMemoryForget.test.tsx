import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../shared';
import { messages } from '../../shared';
import { ChatMemoryForget } from './ChatMemoryForget';

afterEach(cleanup);
const t = (key: string): string => messages['zh-CN'][key as keyof typeof messages['zh-CN']] ?? key;
const message: ChatMessage = {
  id: 'reply', sessionId: 'session', role: 'assistant', content: '', status: 'complete', errorCode: null, createdAt: '2026-10-23T00:00:00Z',
  memoryForget: { kind: 'choices', query: '我的暗号', totalMatches: 2, candidates: [
    { id: 'one', text: '我的暗号甲', updatedAt: '2026-10-23T00:00:00Z' }, { id: 'two', text: '我的暗号乙', updatedAt: '2026-10-23T00:00:00Z' },
  ] },
};

it('requires an explicit selection and blocks duplicate clicks while persistence is pending', async () => {
  let finish!: () => void; const select = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  render(<ChatMemoryForget message={message} disabled={false} t={t} select={select} view={vi.fn()} />);
  expect(select).not.toHaveBeenCalled();
  const button = within(screen.getByRole('listitem', { name: '我的暗号乙' })).getByRole('button');
  fireEvent.click(button); fireEvent.click(button);
  expect(select).toHaveBeenCalledExactlyOnceWith('two');
  expect(screen.getAllByRole('button', { name: '删除这条记忆' }).every((item) => item.hasAttribute('disabled'))).toBe(true);
  expect(screen.queryByText('已删除长期记忆')).not.toBeInTheDocument();
  await act(async () => finish());
});

it('keeps the choices and shows an actionable error without a false success on failure', async () => {
  const select = vi.fn().mockRejectedValue(new Error('memory.forgetStale'));
  render(<ChatMemoryForget message={message} disabled={false} t={t} select={select} view={vi.fn()} />);
  fireEvent.click(screen.getAllByRole('button', { name: '删除这条记忆' })[0]!);
  expect(await screen.findByRole('alert')).toHaveTextContent('请查看当前记忆并重新发送忘记请求');
  expect(screen.queryByText('已删除长期记忆')).not.toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
});

it('disables choices for read-only or busy conversations and displays the persisted deletion receipt', () => {
  const select = vi.fn(); const view = vi.fn();
  const rendered = render(<ChatMemoryForget message={message} disabled t={t} select={select} view={view} />);
  fireEvent.click(screen.getAllByRole('button', { name: '删除这条记忆' })[0]!); expect(select).not.toHaveBeenCalled();
  rendered.rerender(<ChatMemoryForget message={{ ...message, memoryForget: { kind: 'deleted', memoryId: 'one', text: '我的暗号甲', deletedAt: message.createdAt } }} disabled={false} t={t} select={select} view={view} />);
  expect(screen.getByRole('status')).toHaveTextContent('已删除长期记忆');
  expect(screen.getByText('我的暗号甲')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '删除这条记忆' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '查看记忆' })); expect(view).toHaveBeenCalledOnce();
});
