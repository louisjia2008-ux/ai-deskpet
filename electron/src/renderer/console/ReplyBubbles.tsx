import type { JSX } from 'react';
import type { ChatMessage } from '../../shared';
import type { ReplySegment } from '../../shared/automation';
import { ChatMarkdown } from './ChatMarkdown';
import { segmentAssistantReply } from './reply-segments';
import './next-usage.css';

const expressions: Record<ReplySegment['expression'], string | null> = { neutral: null, happy: '🙂', curious: '🤔', reassuring: '🌿' };

/** Complete assistant text only. Streaming/cancelled/failed text stays with the
 * existing ChatReply renderer; receipts/copy controls stay once on its parent. */
export const ReplyBubbles = ({ message }: { message: ChatMessage }): JSX.Element | null => {
  if (message.role !== 'assistant' || message.status !== 'complete') return null;
  const segments = segmentAssistantReply(message.id, message.content);
  return <div className="reply-bubbles" data-assistant-message-id={message.id}>
    {segments.map((segment) => <div className="reply-bubble" key={segment.id} data-segment-id={segment.id} data-expression={segment.expression}>
      {expressions[segment.expression] === null ? null : <span className="reply-expression" aria-hidden="true">{expressions[segment.expression]}</span>}
      <ChatMarkdown text={segment.text.trim()} />
    </div>)}
  </div>;
};
