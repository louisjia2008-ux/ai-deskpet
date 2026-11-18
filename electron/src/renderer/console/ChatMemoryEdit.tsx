import { useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ChatMessage } from '../../shared';

export const ChatMemoryEdit = ({ message, disabled, t, select, view }: {
  message: ChatMessage; disabled: boolean; t(key: string): string;
  select(memoryId: string): Promise<void>; view(): void;
}): JSX.Element | null => {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const pending = useRef(false);
  const result = message.memoryEdit;
  if (!result) return null;
  const choose = async (id: string): Promise<void> => {
    if (disabled || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await select(id); }
    catch (reason) { setError(reason instanceof Error && reason.message.includes('repository.commitUncertain') ? 'repository.commitUncertain' : reason instanceof Error && reason.message.includes('memory.editStale') ? 'memory.editStale' : 'memory.editFailed'); }
    finally { pending.current = false; setBusy(false); }
  };
  return <section className="memory-receipt memory-edit" aria-label={t('memory.editTitle')} aria-busy={busy}>
    {result.kind === 'updated' && <><strong role="status">{t('memory.updated')}</strong><p><small>{t('memory.before')}</small><br />{result.before}</p><p><small>{t('memory.after')}</small><br />{result.after}</p></>}
    {result.kind === 'choices' && <><p>{t('memory.after')}：{result.replacement}</p><ul className="memory-forget-choices">{result.candidates.map((candidate) => <li key={candidate.id} aria-label={candidate.text}><p>{t('memory.before')}：{candidate.text}</p><button type="button" className="secondary" disabled={disabled || busy || message.status !== 'complete'} onClick={() => void choose(candidate.id)}>{t('memory.editThis')}</button></li>)}</ul>{result.totalMatches > result.candidates.length && <small>{t('memory.forgetMore')}</small>}</>}
    {error && <p role="alert">{t(error)}</p>}
    <button type="button" className="secondary" onClick={view}>{t('memory.view')}</button>
  </section>;
};
