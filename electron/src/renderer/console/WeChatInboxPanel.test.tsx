import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WeChatInboxAPI, WeChatInboxItem } from '../../shared/wechat-inbox';
import { WeChatInboxExportSettings, WeChatInboxPanel } from './WeChatInboxPanel';

afterEach(cleanup);

const article: WeChatInboxItem = {
  id: 'a'.repeat(64), kind: 'article', title: 'Fixture article', source: 'Fixture author',
  at: 4, summary: 'Fixture digest', url: 'https://example.invalid/fixture',
};
const file: WeChatInboxItem = {
  id: 'b'.repeat(64), kind: 'file', title: 'Fixture file', source: 'Fixture chat', at: 5, summary: 'Fixture file details',
};

it('reads saved items, searches by keyword and deletes the selected item', async () => {
  const api = { list: vi.fn(async (query: string) => query ? [file] : [article, file]), remove: vi.fn(async () => undefined) };
  render(<WeChatInboxPanel api={api} locale="en" />);
  expect(await screen.findByRole('heading', { name: article.title })).toBeVisible();
  expect(screen.getByText(article.url!)).toBeVisible();
  expect(screen.getByText(file.summary)).toBeVisible();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search inbox' }), { target: { value: ' file ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await waitFor(() => expect(api.list).toHaveBeenLastCalledWith('file'));
  await waitFor(() => expect(screen.queryByText(article.title)).not.toBeInTheDocument());
  fireEvent.click(await screen.findByRole('button', { name: 'Remove from inbox Fixture file' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm (the WeChat message is not affected)' }));
  await waitFor(() => expect(api.remove).toHaveBeenCalledExactlyOnceWith(file.id));
  expect(await screen.findByText('Nothing matches this search.')).toBeVisible();
});

it('preserves a saved entry after a deletion error', async () => {
  const api = { list: vi.fn(async () => [article]), remove: vi.fn(async () => { throw Error('fixture failure'); }) };
  render(<WeChatInboxPanel api={api} locale="zh-CN" />);
  fireEvent.click(await screen.findByRole('button', { name: '从收件箱移除 Fixture article' }));
  fireEvent.click(screen.getByRole('button', { name: '确认移除（微信里的原消息不受影响）' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('未能删除这条内容。');
  expect(screen.getByRole('heading', { name: article.title })).toBeVisible();
});

it('keeps vault export off without a selected vault and reflects an explicit setting change', async () => {
  const api = { getExport: vi.fn(async () => false), setExport: vi.fn<WeChatInboxAPI['setExport']>(async () => undefined) };
  api.setExport.mockRejectedValueOnce(Error('wechat.inboxVaultRequired'));
  render(<WeChatInboxExportSettings api={api} locale="zh-CN" />);
  const toggle = screen.getByRole('checkbox', { name: '将新收藏同步到本地笔记库' });
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  expect(await screen.findByRole('alert')).toHaveTextContent('请先在设置里选择本地笔记库，再开启同步。');
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(api.setExport.mock.calls.map(args => args[0])).toEqual([true, true, false]);
});
