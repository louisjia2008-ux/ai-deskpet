import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmButton } from './ConfirmButton';

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('needs a second, explicit press and defaults focus to cancel', () => {
  const onConfirm = vi.fn();
  render(<ConfirmButton label="Delete" confirmLabel="Delete this memory" cancelLabel="Cancel" onConfirm={onConfirm} />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(onConfirm).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('button', { name: 'Delete' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete this memory' }));
  expect(onConfirm).toHaveBeenCalledOnce();
});

it('disarms by itself when left alone', () => {
  vi.useFakeTimers();
  render(<ConfirmButton label="Delete" confirmLabel="Confirm" cancelLabel="Cancel" onConfirm={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  act(() => { vi.advanceTimersByTime(8_000); });
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
});
