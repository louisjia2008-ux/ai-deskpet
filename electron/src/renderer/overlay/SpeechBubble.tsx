import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import type { ModelBox } from '../live2d';
import { motionMs } from '../motion';

const FADE_MS = 600;
const HOLD_GRACE_MS = 8_000;
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
  // Reading it (pointer over it, or keyboard focus inside) holds the bubble; leaving gives a few more seconds.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  const [deadline, setDeadline] = useState(() => {
    const parsed = expiresAt === undefined || expiresAt === null ? NaN : Date.parse(expiresAt);
    return Number.isFinite(parsed) ? parsed : Date.now() + 60_000;
  });
  const [fading, setFading] = useState(Date.now() >= deadline);
  const [hidden, setHidden] = useState(Date.now() >= deadline + FADE_MS);
  const dismissed = useRef(false);
  const [opening, setOpening] = useState(false);
  // Closing hands back the pointer and focus at once, then the line goes back into her before it is removed.
  const [leaving, setLeaving] = useState(false);
  const pendingClose = useRef<number | null>(null);
  const close = useCallback((): void => {
    pendingClose.current = null;
    setHidden(true);
    void window.deskpet.character.dismissBubble(revision).catch(() => undefined);
  }, [revision]);
  const dismiss = useCallback((animate = true): void => {
    if (dismissed.current) return;
    dismissed.current = true;
    onDismiss();
    const exit = animate ? motionMs('--motion-exit') : 0;
    if (exit <= 0) { close(); return; }
    setLeaving(true);
    pendingClose.current = window.setTimeout(close, exit);
  }, [onDismiss, close]);
  // Replaced by a newer line mid-exit: the close still reaches the host.
  useEffect(() => () => {
    if (pendingClose.current === null) return;
    window.clearTimeout(pendingClose.current);
    void window.deskpet.character.dismissBubble(revision).catch(() => undefined);
  }, [revision]);

  useEffect(() => {
    if (held || opening) { setFading(false); return; }
    const fade = window.setTimeout(() => setFading(true), Math.max(0, deadline - Date.now()));
    const expire = window.setTimeout(() => dismiss(false), Math.max(0, deadline + FADE_MS - Date.now()));
    return () => { window.clearTimeout(fade); window.clearTimeout(expire); };
  }, [deadline, dismiss, held, opening]);
  const extend = (): void => setDeadline(current => Math.max(current, Date.now() + HOLD_GRACE_MS));

  if (hidden) return null;
  const placement = bubblePlacement(model);
  return <div className={`speech-bubble${placement?.above ? ' is-above' : ''}${leaving ? ' is-leaving' : fading ? ' is-fading' : ''}`} style={placement?.style}
    role={leaving ? undefined : 'status'} aria-hidden={leaving || undefined} inert={leaving}
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => { setHovered(false); extend(); }}
    onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setFocused(false); extend(); } }}>
    <div className="speech-bubble-text">{text}</div>
    {sessionId && <button type="button" className="speech-bubble-reply" disabled={opening} onClick={() => {
      setOpening(true);
      void window.deskpet.chat.openSession(sessionId).then(() => dismiss()).catch(() => setOpening(false));
    }}>{replyLabel}</button>}
    <button type="button" className="speech-bubble-close" aria-label={closeLabel} title={closeLabel} onClick={() => dismiss()}>×</button>
  </div>;
};
