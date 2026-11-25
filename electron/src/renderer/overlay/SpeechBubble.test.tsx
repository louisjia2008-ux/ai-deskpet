import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SpeechBubble, bubblePlacement } from './SpeechBubble';

const start = new Date('2026-10-22T12:00:00Z');
const dismissBubble = vi.fn(async () => undefined);
const release = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(start); dismissBubble.mockClear(); release.mockClear();
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { character: { dismissBubble } } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const bubble = (revision = 1, expiresAt = new Date(Date.now() + 60_000).toISOString()) => <SpeechBubble key={revision} text="Time to stretch" revision={revision} expiresAt={expiresAt} closeLabel="Close speech bubble" onDismiss={release} />;

it('can be closed immediately and releases native interaction without a later duplicate close', async () => {
  render(bubble());
  fireEvent.click(screen.getByRole('button', { name: 'Close speech bubble' }));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(dismissBubble).toHaveBeenCalledWith(1);
  expect(release).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(61_000));
  expect(dismissBubble).toHaveBeenCalledOnce();
});

it('with motion, hands back the pointer at once and leaves before it is removed, even if replaced mid-exit', async () => {
  document.documentElement.style.setProperty('--motion-exit', '140ms');
  try {
    const { container, rerender } = render(bubble());
    fireEvent.click(screen.getByRole('button', { name: 'Close speech bubble' }));
    expect(release).toHaveBeenCalledOnce();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(container.querySelector('.speech-bubble.is-leaving')).not.toBeNull();
    expect(dismissBubble).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(140));
    expect(container.querySelector('.speech-bubble')).toBeNull();
    expect(dismissBubble).toHaveBeenCalledExactlyOnceWith(1);
    rerender(bubble(2));
    fireEvent.click(screen.getByRole('button', { name: 'Close speech bubble' }));
    rerender(bubble(3));
    expect(dismissBubble).toHaveBeenLastCalledWith(2);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(dismissBubble).toHaveBeenCalledTimes(2);
  } finally { document.documentElement.style.removeProperty('--motion-exit'); }
});

it('stays readable for one minute, fades, then clears the same bubble', async () => {
  render(bubble());
  await act(async () => vi.advanceTimersByTimeAsync(59_999));
  expect(screen.getByRole('status')).not.toHaveClass('is-fading');
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(screen.getByRole('status')).toHaveClass('is-fading');
  expect(dismissBubble).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(600));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(dismissBubble).toHaveBeenCalledWith(1);
  expect(release).toHaveBeenCalledOnce();
});

it('gives repeated text a new lifetime and cancels the older expiry', async () => {
  const { rerender } = render(bubble());
  await act(async () => vi.advanceTimersByTimeAsync(59_000));
  rerender(bubble(2));
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(screen.getByRole('status')).not.toHaveClass('is-fading');
  expect(dismissBubble).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(58_600));
  expect(dismissBubble).toHaveBeenCalledExactlyOnceWith(2);
});

it('does not flash an already expired bubble after a renderer reload', async () => {
  render(bubble(3, new Date(start.getTime() - 10_000).toISOString()));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(dismissBubble).toHaveBeenCalledWith(3);
});

it('sits over her head when the window has room there, else under her face, never on it', () => {
  // Scaled down in a 620px window: room above, so the bubble ends 10px over the top of her head.
  expect(bubblePlacement({ top: 232, height: 376, viewHeight: 620 })).toEqual({ above: true, style: { top: 'auto', bottom: 398, '--bubble-room': '152px' } });
  // Filling the window: below the face instead.
  expect(bubblePlacement({ top: 30, height: 578, viewHeight: 620 })).toEqual({ above: false, style: { top: 30 + 578 * 0.32 } });
  expect(bubblePlacement(null)).toBeNull();
  render(<SpeechBubble text="嘿嘿" revision={1} expiresAt={null} closeLabel="Close" model={{ top: 232, height: 376, viewHeight: 620 }} onDismiss={release} />);
  expect(screen.getByRole('status')).toHaveClass('is-above');
  expect(screen.getByRole('status').style.bottom).toBe('398px');
});

it('holds while the pointer is over it and gives a few seconds after leaving', async () => {
  render(bubble());
  await act(async () => vi.advanceTimersByTimeAsync(55_000));
  fireEvent.pointerEnter(screen.getByRole('status'));
  await act(async () => vi.advanceTimersByTimeAsync(120_000));
  expect(screen.getByRole('status')).not.toHaveClass('is-fading');
  expect(dismissBubble).not.toHaveBeenCalled();
  fireEvent.pointerLeave(screen.getByRole('status'));
  await act(async () => vi.advanceTimersByTimeAsync(7_999));
  expect(screen.getByRole('status')).not.toHaveClass('is-fading');
  await act(async () => vi.advanceTimersByTimeAsync(1 + 600));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(dismissBubble).toHaveBeenCalledOnce();
});
