import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePacedText } from './use-paced-text';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('coalesces a burst within one short frame without splitting emoji or combining characters', () => {
  const { result, rerender } = renderHook(({ text }) => usePacedText(text, true), { initialProps: { text: '' } });
  rerender({ text: 'A👨‍👩‍👧‍👦éB' });
  expect(result.current).toEqual({ text: '', pending: true });
  act(() => vi.advanceTimersByTime(20));
  expect(result.current.text).toBe('');
  rerender({ text: 'A👨‍👩‍👧‍👦éBC' });
  act(() => vi.advanceTimersByTime(20));
  expect(result.current).toEqual({ text: 'A👨‍👩‍👧‍👦éBC', pending: false });
});

it('flushes on stop, resets for a retry, and shows historical replies immediately', () => {
  const { result, rerender } = renderHook(({ text, animate }) => usePacedText(text, animate), { initialProps: { text: 'Received answer', animate: true } });
  act(() => vi.advanceTimersByTime(20));
  expect(result.current.text).toBe('');
  rerender({ text: 'Received answer', animate: false });
  expect(result.current).toEqual({ text: 'Received answer', pending: false });
  expect(vi.getTimerCount()).toBe(0);
  rerender({ text: '', animate: true });
  rerender({ text: 'Retry', animate: true });
  act(() => vi.advanceTimersByTime(40));
  expect(result.current.text).toBe('Retry');
  rerender({ text: 'Historical answer', animate: false });
  expect(result.current.text).toBe('Historical answer');
});

it('bounds the presentation delay for a large response and clears pending work on unmount', () => {
  const text = '字'.repeat(10_000);
  const { result, unmount } = renderHook(() => usePacedText(text, true));
  expect(result.current.text).toBe('');
  act(() => vi.advanceTimersByTime(40));
  expect(result.current).toEqual({ text, pending: false });
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('respects reduced motion', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const { result } = renderHook(() => usePacedText('Show this immediately', true));
  expect(result.current).toEqual({ text: 'Show this immediately', pending: false });
});
