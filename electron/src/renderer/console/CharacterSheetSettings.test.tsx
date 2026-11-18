import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultCharacterProfile, localDay } from '../../shared/character';
import type { CharacterProfile } from '../../shared/character';
import { CharacterSheetSettings } from './CharacterSheetSettings';

afterEach(cleanup);

it('fills the draft only into the form, saves it with today as the day her age counts from, and shows when she grows up', async () => {
  const updateCharacter = vi.fn(async (value: CharacterProfile) => value);
  Object.assign(window, { deskpet: { persona: { getCharacter: async () => defaultCharacterProfile(), updateCharacter } } });
  render(<CharacterSheetSettings locale="zh-CN" />);
  expect(await screen.findByText('没有设置年龄，她不会长大。')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '用草稿开始' }));
  expect(screen.getByRole('status')).toHaveTextContent('已填入草稿，还没有保存。');
  expect(updateCharacter).not.toHaveBeenCalled();
  expect((screen.getByLabelText('设定书') as globalThis.HTMLTextAreaElement).value).toContain('样子：');
  fireEvent.change(screen.getByLabelText('年龄'), { target: { value: '16' } });
  const today = localDay(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(screen.getByText(new RegExp(`现在 16 岁，${Number(today.slice(0, 4)) + 1}-${today.slice(5)} 满 17 岁。`))).toBeVisible();
  fireEvent.change(screen.getByLabelText('喜欢（一行一个）'), { target: { value: '草莓牛奶\n\n  下雪  ' } });
  fireEvent.change(screen.getByLabelText('主人的生日（可选）'), { target: { value: '02-29' } });
  fireEvent.click(screen.getByRole('button', { name: '保存设定' }));
  await waitFor(() => expect(updateCharacter).toHaveBeenCalledOnce());
  expect(updateCharacter.mock.calls[0]![0]).toMatchObject({ age: 16, ageSince: today, likes: ['草莓牛奶', '下雪'], ownerBirthday: '02-29' });
  expect(await screen.findByText('已保存，新的回复会用上。')).toBeVisible();
});
