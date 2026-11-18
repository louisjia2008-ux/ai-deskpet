import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import type { ModelBox } from '../live2d';

const FADE_MS = 600;
// Space above her head the bubble needs before it sits there rather than under her face.
const ABOVE_ROOM = 120;

/** Over her head when the window has room there, else just under the face; never on it. */
export const bubblePlacement = (box: ModelBox | null | undefined): { above: boolean; style: CSSProperties } | null => {
  if (!box) return null;
  if (box.top >= ABOVE_ROOM) return { above: true, style: { top: 'auto', bottom: box.viewHeight - box.top + 10, '--bubble-room': `${Math.round(box.top - 80)}px` } as CSSProperties };
  // A full-body model has its face in the top third of its height.
  return { above: false, style: { top: Math.max(36, box.top + box.height * 0.32) } };
};

export const SpeechBubble = ({ text, revision, expiresAt, closeLabel, sessionId, replyLabel, model, onDismiss }: {
  text: string; revision: number; expiresAt: string | null | undefined; closeLabel: string; sessionId?: string | null | undefined; replyLabel?: string; model?: ModelBox | null; onDismiss(): void;
}): JSX.Element | null => {
  const [deadline] = useState(() => {
    const parsed = expiresAt === undefined || expiresAt === null ? NaN : Date.parse(expiresAt);
    return Number.isFinite(parsed) ? parsed : Date.now() + 60_000;
  });
  const [fading, setFading] = useState(Date.now() >= deadline);
  const [hidden, setHidden] = useState(Date.now() >= deadline + FADE_MS);
  const dismissed = useRef(false);
  const [opening, setOpening] = useState(false);
  const dismiss = useCallback((): void => {
    if (dismissed.current) return;
    dismissed.current = true;
    setHidden(true);
    onDismiss();
    void window.deskpet.character.dismissBubble(revision).catch(() => undefined);
  }, [revision, onDismiss]);

  useEffect(() => {
    const fade = window.setTimeout(() => setFading(true), Math.max(0, deadline - Date.now()));
    const expire = window.setTimeout(dismiss, Math.max(0, deadline + FADE_MS - Date.now()));
    return () => { window.clearTimeout(fade); window.clearTimeout(expire); };
  }, [deadline, dismiss]);

  if (hidden) return null;
  const placement = bubblePlacement(model);
  return <div className={`speech-bubble${placement?.above ? ' is-above' : ''}${fading ? ' is-fading' : ''}`} style={placement?.style} role="status">
    <div className="speech-bubble-text">{text}</div>
    {sessionId && <button type="button" className="speech-bubble-reply" disabled={opening} onClick={() => {
      setOpening(true);
      void window.deskpet.chat.openSession(sessionId).then(dismiss).catch(() => setOpening(false));
    }}>{replyLabel}</button>}
    <button type="button" className="speech-bubble-close" aria-label={closeLabel} title={closeLabel} onClick={dismiss}>×</button>
  </div>;
};
