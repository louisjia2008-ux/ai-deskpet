import { useEffect, useState } from 'react';
import { motionMs } from '../motion';

/**
 * Keeps the last value rendered for one exit after it becomes null, so a closing layer can leave the way it came.
 * `leaving` is true during that exit: the caller removes interaction and focus at once. With no exit duration
 * (reduced motion, tests), it goes on the next commit.
 */
export const usePresence = <T,>(value: T | null, token = '--motion-exit'): { value: T | null; leaving: boolean } => {
  const [last, setLast] = useState<T | null>(value);
  if (value !== null && value !== last) setLast(value);
  const [gone, setGone] = useState(value === null);
  useEffect(() => {
    if (value !== null) { setGone(false); return; }
    const exit = motionMs(token);
    if (exit <= 0) { setGone(true); return; }
    const timer = window.setTimeout(() => setGone(true), exit);
    return () => window.clearTimeout(timer);
  }, [value, token]);
  if (value !== null) return { value, leaving: false };
  return gone || last === null ? { value: null, leaving: false } : { value: last, leaving: true };
};
