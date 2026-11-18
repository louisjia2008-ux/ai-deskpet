import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultPersona } from '../../shared/persona';
import type { Persona } from '../../shared/persona';
import { PersonaSettings } from './PersonaSettings';

const update = vi.fn(async (value: Persona) => value), setNickname = vi.fn(async () => undefined);
beforeEach(() => {
  update.mockClear(); setNickname.mockClear();
  Object.assign(window, { deskpet: { persona: { get: async () => ({ ...defaultPersona(), name: '旧名字' }), update }, relationship: { setNickname } } });
});
afterEach(cleanup);

it('saves the form, splits line lists, and uses the name as the companion name', async () => {
  render(<PersonaSettings locale="zh-CN" />);
  await waitFor(() => expect(screen.getByLabelText<globalThis.HTMLInputElement>('名字').value).toBe('旧名字'));
  fireEvent.change(screen.getByLabelText('名字'), { target: { value: 'Kitty' } });
  fireEvent.change(screen.getByLabelText('性格'), { target: { value: '傲娇' } });
  fireEvent.change(screen.getByLabelText('口头禅（一行一个）'), { target: { value: '才不是呢\n\n  哼  ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存人格' }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0]![0]).toMatchObject({ name: 'Kitty', personality: '傲娇', catchphrases: ['才不是呢', '哼'] });
  await screen.findByRole('status');
  expect(setNickname).toHaveBeenCalledWith('Kitty');
});

it('imports a character card into the form without saving it', async () => {
  render(<PersonaSettings locale="zh-CN" />);
  await waitFor(() => expect(screen.getByLabelText<globalThis.HTMLInputElement>('名字').value).toBe('旧名字'));
  const card = new globalThis.File(['x'], 'card.json', { type: 'application/json' });
  Object.defineProperty(card, 'text', { value: async () => JSON.stringify({ name: '小雪', personality: '粘人' }) });
  fireEvent.change(screen.getByLabelText('导入角色卡或笔记'), { target: { files: [card] } });
  await waitFor(() => expect(screen.getByLabelText<globalThis.HTMLInputElement>('名字').value).toBe('小雪'));
  expect(screen.getByRole('status').textContent).toBe('已填入表单，还没有保存。');
  expect(update).not.toHaveBeenCalled();
});
