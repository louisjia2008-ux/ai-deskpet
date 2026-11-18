import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../shared';
import { ReplyBubbles } from './ReplyBubbles';

const message: ChatMessage = { id: 'one-assistant-turn', sessionId: 'synthetic-session', role: 'assistant', status: 'complete',
  content: 'Thank you for checking.\n\nWould you like to review the next step?', createdAt: '2026-10-29T00:00:00.000Z', errorCode: null };
afterEach(cleanup);

describe('reply bubbles presentation boundary', () => {
  it('renders several bubbles under one logical identity without duplicating memory or request receipts', () => {
    const logical = { ...message, memoryReceipts: [{ memoryId: 'one-memory', text: 'ONLY_PARENT_RENDERS_THIS_RECEIPT', savedAt: message.createdAt, reused: false }] };
    const { container, rerender } = render(<ReplyBubbles message={logical} />);
    expect(container.querySelectorAll('[data-assistant-message-id]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-segment-id]')).toHaveLength(2);
    expect(container).not.toHaveTextContent('ONLY_PARENT_RENDERS_THIS_RECEIPT');
    const ids = [...container.querySelectorAll('[data-segment-id]')].map((n) => n.getAttribute('data-segment-id'));
    rerender(<ReplyBubbles message={structuredClone(logical)} />);
    expect([...container.querySelectorAll('[data-segment-id]')].map((n) => n.getAttribute('data-segment-id'))).toEqual(ids);
    expect(logical.content).toBe(message.content);
  });

  it('leaves streaming, interrupted and non-assistant content to the existing parent renderer', () => {
    const { container, rerender } = render(<ReplyBubbles message={{ ...message, status: 'streaming' }} />); expect(container).toBeEmptyDOMElement();
    rerender(<ReplyBubbles message={{ ...message, status: 'cancelled' }} />); expect(container).toBeEmptyDOMElement();
    rerender(<ReplyBubbles message={{ ...message, role: 'user' }} />); expect(container).toBeEmptyDOMElement();
  });

  it('renders output as plain text and never creates executable markup or external images', () => {
    const text = '<script>window.executed = true</script>\n\n<img src="https://outside.invalid/tracker">';
    const { container } = render(<ReplyBubbles message={{ ...message, content: text }} />);
    expect(container).toHaveTextContent('<script>window.executed = true</script>');
    expect(container.querySelector('script')).toBeNull(); expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('.chat-message')).toHaveLength(0);
  });
});
