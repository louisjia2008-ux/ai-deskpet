import type { JSX } from 'react';
import type { ChatMessage } from '../../shared';

export const ChatContextReceipts = ({ message, t }: { message: ChatMessage; t(key: string): string }): JSX.Element | null => {
  if (!message.requestReceipts?.length) return null;
  const last = message.requestReceipts.at(-1)?.excludedContext;
  return <>{(last?.summarizedCount || last?.compactedToolPages || last?.historyCount) ? <p className="chat-interaction-note" role="note">
    {last.summarizedCount ? t('chat.historySummarized').replace('{count}',String(last.summarizedCount)) : ''}
    {last.historyCount ? ' ' + t('chat.historyExcluded').replace('{count}',String(last.historyCount)) : ''}
    {last.compactedToolPages ? ' ' + t('chat.toolPagesCompacted').replace('{count}',String(last.compactedToolPages)) : ''}
  </p> : null}<details className="chat-context-receipts"><summary>{t('chat.contextReceipt')}</summary>
    {message.requestReceipts.map((receipt) => {
      const observation = receipt.observations.at(-1);
      const phaseKey = receipt.phase === 'terminal' ? 'chat.contextCompleted' : receipt.phase === 'response-received'
        ? 'chat.contextResponded' : receipt.phase === 'fetch-invoked' ? 'chat.contextAttempted' : 'chat.contextPrepared';
      const input = observation?.usage.inputTokens ?? t('chat.contextUnknown');
      const output = observation?.usage.outputTokens ?? t('chat.contextUnknown');
      return <div key={receipt.requestId} data-request-id={receipt.requestId} className="request-receipt">
        <strong>{t(phaseKey)}</strong>
        {receipt.contextBinding && <p>{t('chat.contextModel')}: {receipt.contextBinding.model} · {t('chat.contextDestination')}: {t(`chat.contextDestination.${receipt.contextBinding.destination}`)}</p>}
        <p>{t('chat.contextSources')}: {receipt.contextTrace.memoryReferences.length} / {receipt.contextTrace.historyMessageIds.length}</p>
        {receipt.excludedContext && <p>{t('chat.contextExcluded')}: {receipt.excludedContext.memoryCount} / {receipt.excludedContext.historyCount}</p>}
        <p>{t(receipt.capacitySource === 'application-limit' ? 'chat.contextApplicationEstimate' : 'chat.contextEstimate')}: {receipt.inputEstimate} / {receipt.maxInputTokens}</p>
        {receipt.capacitySource === 'application-limit' && <p>{t('chat.contextProviderManaged')}</p>}
        <p>{t('chat.contextActual')}: {input} / {output}</p>
      </div>;
    })}
  </details></>;
};
