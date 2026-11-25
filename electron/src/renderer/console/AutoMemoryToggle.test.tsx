import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AutoMemoryStatus } from '../../shared/auto-memory';
import { AutoMemoryToggle } from './AutoMemoryToggle';

afterEach(cleanup);
const providerId = '11111111-1111-4111-8111-111111111111';

it('lets the owner pick a cheaper model for background memory, or go back to the chat model', async () => {
  let status: AutoMemoryStatus = { enabled: true, model: null, activeProviderId: providerId };
  const setModel = vi.fn(async ({ model }: { model: { providerId: string; model: string } | null }) => (status = { ...status, model }));
  const api = { status: async () => status, configure: async () => status, setModel };
  render(<AutoMemoryToggle api={api} locale="zh-CN" listModels={async () => [{ id: 'gpt-6.2-sol' }, { id: 'gpt-6-luna' }]} />);
  const select = await screen.findByRole('combobox', { name: /后台记忆用的模型/u });
  expect(select).toHaveValue('');
  expect([...select.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['跟随聊天模型（默认）', 'gpt-6-luna', 'gpt-6.2-sol']);
  fireEvent.change(select, { target: { value: 'gpt-6-luna' } });
  await waitFor(() => expect(setModel).toHaveBeenLastCalledWith({ model: { providerId, model: 'gpt-6-luna' } }));
  await waitFor(() => expect(select).toHaveValue('gpt-6-luna'));
  fireEvent.change(select, { target: { value: '' } });
  await waitFor(() => expect(setModel).toHaveBeenLastCalledWith({ model: null }));
});

it('hides the picker when the provider cannot list its models', async () => {
  const status: AutoMemoryStatus = { enabled: true, model: null, activeProviderId: providerId };
  render(<AutoMemoryToggle api={{ status: async () => status, configure: async () => status, setModel: async () => status }} locale="en" listModels={async () => { throw new Error('offline'); }} />);
  await screen.findByText('Learn about me from conversations');
  expect(screen.queryByRole('combobox')).toBeNull();
});
