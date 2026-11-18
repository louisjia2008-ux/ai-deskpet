import { useEffect, useRef, useState } from 'react';

// Coalesce provider bursts into one short paint interval. Never add a per-letter
// delay or split the provider's text into new grapheme boundaries.
const STEP_MS = 40;

export const usePacedText = (text: string, animate: boolean): { text: string; pending: boolean } => {
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const enabled = animate && !reducedMotion;
  const [visible, setVisible] = useState(enabled ? '' : text);
  const shown = useRef(enabled ? '' : text);
  const target = useRef(text);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (query === undefined) return;
    const change = (): void => setReducedMotion(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    target.current = text;
    const show = (value: string): void => { shown.current = value; setVisible(value); };
    if (!enabled) {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      show(text);
      return;
    }
    // A retry may replace the text while retaining the same message ID.
    if (!text.startsWith(shown.current)) show('');
    const tick = (): void => {
      timer.current = null;
      show(target.current);
    };
    if (timer.current === null && shown.current !== text) timer.current = setTimeout(tick, STEP_MS);
  }, [text, enabled]);

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  return { text: enabled ? visible : text, pending: enabled && visible !== text };
};
