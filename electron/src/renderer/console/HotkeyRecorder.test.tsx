import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { acceleratorFor, HotkeyRecorder } from './HotkeyRecorder';

afterEach(cleanup);
const key = (key: string, code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
  ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

it('builds an accelerator from the physical key and requires a modifier', () => {
  expect(acceleratorFor(key(' ', 'Space', { altKey: true }))).toBe('Alt+Space');
  expect(acceleratorFor(key('∂', 'KeyD', { altKey: true, shiftKey: true }))).toBe('Alt+Shift+D');
  expect(acceleratorFor(key('k', 'KeyK', { metaKey: true }))).toMatch(/^(Command|Super)\+K$/u);
  expect(acceleratorFor(key('k', 'KeyK'))).toBeNull();
  expect(acceleratorFor(key('Alt', 'AltLeft', { altKey: true }))).toBeNull();
  expect(acceleratorFor(key('F5', 'F5'))).toBe('F5');
  expect(acceleratorFor(key('+', 'Equal', { ctrlKey: true, shiftKey: true }))).toBe('Control+Shift+Plus');
  expect(acceleratorFor(key('1', 'Numpad1', { altKey: true }))).toBe('Alt+num1');
});

it('saves once, only when the combination is complete, and Esc cancels', async () => {
  const onChange = vi.fn<(next: string) => Promise<void>>(async () => undefined);
  render(<HotkeyRecorder value="Alt+Space" zh={false} onChange={onChange} />);
  const button = screen.getByRole('button', { name: 'Alt+Space' });
  fireEvent.click(button);
  fireEvent.keyDown(button, key('Escape', 'Escape'));
  expect(screen.getByRole('button', { name: 'Alt+Space' })).toBeVisible();
  fireEvent.click(button);
  fireEvent.keyDown(button, key('Shift', 'ShiftLeft', { shiftKey: true }));
  fireEvent.keyDown(button, key('k', 'KeyK', { metaKey: true, shiftKey: true }));
  await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
  expect(onChange.mock.calls[0]![0]).toMatch(/^(Command|Super)\+Shift\+K$/u);
});
