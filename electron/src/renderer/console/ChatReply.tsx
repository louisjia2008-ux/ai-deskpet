import { useLayoutEffect } from 'react';
import type { JSX } from 'react';

import type { ChatMessage, ChatProgress, MessageKey } from '../../shared';
import { ChatMarkdown } from './ChatMarkdown';
import { ReplyBubbles } from './ReplyBubbles';
import { usePacedText } from './use-paced-text';

const toolLabels: Record<string, MessageKey> = {
  'memory.save': 'chat.progress.savingMemory',
  'memory.forget': 'chat.progress.forgettingMemory',
  'memory.edit': 'chat.progress.editingMemory',
  'web.search': 'chat.progress.searching',
  'web.read': 'chat.progress.readingWeb',
  'math.calculate': 'chat.progress.calculating',
  'workspace.list': 'chat.progress.browsingFiles',
  'workspace.search': 'chat.progress.searchingFiles',
  'workspace.read': 'chat.progress.readingFiles',
  'workspace.write': 'chat.progress.writingFiles',
  'timer.create': 'chat.progress.creatingTimer',
  'time.current': 'chat.progress.checkingTime',
};

export const ChatReply = ({ message, progress, animate, t, onReveal }: {
  message: ChatMessage; progress: ChatProgress | undefined; animate: boolean;
  t(key: string): string; onReveal(): void;
}): JSX.Element => {
  const revealed = usePacedText(message.content, animate && message.status === 'streaming');
  const current = message.status === 'streaming'
    ? progress ?? { phase: 'thinking' as const }
    : revealed.pending ? { phase: 'responding' as const } : undefined;
  const key: string | undefined = current === undefined ? undefined : current.phase === 'tool'
    ? toolLabels[current.toolId] ?? 'chat.progress.tool'
    : current.phase === 'preparing' ? 'chat.progress.preparing'
      : current.phase === 'queued' ? 'chat.progress.queued'
        : current.phase === 'awaiting-approval' ? 'chat.progress.awaitingApproval'
          : current.phase === 'recovering' ? 'chat.progress.recovering'
            : current.phase === 'composing' ? 'chat.progress.composing'
      : current.phase === 'responding' ? 'chat.progress.responding' : 'chat.progress.thinking';
  useLayoutEffect(() => { onReveal(); }, [revealed.text, key, onReveal]);
  return <>
    {key === undefined ? null : <p role="status" className="chat-waiting" data-phase={current?.phase === 'tool' ? current.toolId : current?.phase}><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>{t(key)}</p>}
    {message.status === 'complete' && !revealed.pending ? <ReplyBubbles message={message} /> : revealed.text.length === 0 ? null : <ChatMarkdown text={revealed.text} revealing={revealed.pending} />}
  </>;
};
