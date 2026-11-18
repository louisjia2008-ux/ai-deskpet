import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatProgress } from '../../shared';
import { ChatReply } from './ChatReply';
import { chatInteractionCopy } from './chat-interaction-copy';

const message: ChatMessage = { id: 'synthetic-assistant', sessionId: 'synthetic-session', role: 'assistant', status: 'streaming',
  content: 'A long provider reply that must appear immediately when generation ends.\n\nSecond paragraph.', createdAt: '2026-11-02T00:00:00Z', errorCode: null };
const t = (key: string): string => chatInteractionCopy.en[key] ?? key;
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('flushes the whole response at provider completion without waiting for presentation timers', () => {
  vi.useFakeTimers();
  const { rerender, container } = render(<ChatReply message={message} progress={{ phase: 'responding' }} animate t={t} onReveal={() => undefined} />);
  expect(container).not.toHaveTextContent('A long provider reply');
  rerender(<ChatReply message={{ ...message, status: 'complete' }} progress={undefined} animate t={t} onReveal={() => undefined} />);
  expect(container).toHaveTextContent('A long provider reply that must appear immediately when generation ends.');
  expect(container.querySelectorAll('[data-segment-id]')).toHaveLength(2);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  [{ phase: 'preparing' }, 'Preparing the request…'],
  [{ phase: 'queued' }, 'Waiting for the current inference service…'],
  [{ phase: 'awaiting-approval' }, 'Waiting for your approval…'],
  [{ phase: 'recovering', toolId: 'web.search' }, 'Correcting the tool request…'],
] as Array<[ChatProgress, string]>)('shows the actual %j stage', (progress, text) => {
  render(<ChatReply message={{ ...message, content: '' }} progress={progress} animate t={t} onReveal={() => undefined} />);
  expect(screen.getByRole('status')).toHaveTextContent(text);
});
