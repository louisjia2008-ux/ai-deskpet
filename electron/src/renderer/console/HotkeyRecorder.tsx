import { useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift']);
const NAMED: Record<string, string> = {
  ' ': 'Space', '+': 'Plus', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', Enter: 'Return',
};
const NUMPAD: Record<string, string> = { NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec' };
const MAC = typeof navigator !== 'undefined' && /Mac/iu.test(navigator.platform);

/** The Electron accelerator for a key press, or null while only modifiers are held. */
export const acceleratorFor = (event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | null => {
  if (MODIFIER_KEYS.has(event.key)) return null;
  // Use the physical key, so Alt/Option combinations do not record a special character.
  const key = /^Key[A-Z]$/u.test(event.code) ? event.code.slice(3)
    : /^Digit[0-9]$/u.test(event.code) ? event.code.slice(5)
      : /^Numpad[0-9]$/u.test(event.code) ? `num${event.code.slice(6)}`
        : NUMPAD[event.code] ?? NAMED[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  const modifiers = [event.metaKey && (MAC ? 'Command' : 'Super'), event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean);
  // A global shortcut needs at least one modifier (F-keys excepted) so it never steals ordinary typing.
  if (modifiers.length === 0 && !/^F\d{1,2}$/u.test(key)) return null;
  return [...modifiers, key].join('+');
};

/** Press the combination instead of typing it; it is saved once, when complete. Esc cancels. */
export function HotkeyRecorder({ value, zh, onChange }: { value: string; zh: boolean; onChange(next: string): Promise<void> }): JSX.Element {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording) return;
    event.preventDefault();
    if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) { setRecording(false); return; }
    const next = acceleratorFor(event);
    if (next === null) return;
    setRecording(false); setBusy(true); setFailed(false);
    void onChange(next).catch(() => setFailed(true)).finally(() => setBusy(false));
  };
  return <span className="hotkey-recorder">
    <button type="button" id="hotkey" className={recording ? 'secondary hotkey-recording' : 'secondary'} disabled={busy} aria-pressed={recording}
      onClick={() => { setFailed(false); setRecording(current => !current); }} onKeyDown={onKeyDown} onBlur={() => setRecording(false)}>
      {recording ? (zh ? '请按下组合键（Esc 取消）' : 'Press the keys (Esc cancels)') : value || (zh ? '点此设置' : 'Click to set')}
    </button>
    {failed && <small role="alert">{zh ? '没能保存这个快捷键，已保留原设置。' : 'Could not save this shortcut; the previous one is kept.'}</small>}
  </span>;
}
