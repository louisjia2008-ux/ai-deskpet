import { useEffect, useState } from 'react';
import type { JSX } from 'react';

/**
 * One way to do anything that loses data: the first press arms it, a second press
 * on the red "confirm" button does it, and "cancel" (or waiting) disarms it.
 */
export function ConfirmButton({ label, confirmLabel, cancelLabel, disabled, onConfirm, className, ariaLabel }: {
  label: string; confirmLabel: string; cancelLabel: string; disabled?: boolean; onConfirm(): void; className?: string;
  /** Names the thing it acts on when the visible label alone is ambiguous in a list. */
  ariaLabel?: string;
}): JSX.Element {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 8_000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  if (!armed) return <button type="button" className={className ?? 'text-button'} aria-label={ariaLabel} disabled={disabled} onClick={() => setArmed(true)}>{label}</button>;
  return <span className="confirm-button-group">
    <button type="button" className="danger" disabled={disabled} onClick={() => { setArmed(false); onConfirm(); }}>{confirmLabel}</button>
    <button type="button" className="secondary" autoFocus onClick={() => setArmed(false)}>{cancelLabel}</button>
  </span>;
}
