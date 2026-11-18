/** Decides when the companion has a reason to check in, from the clock and how long
 * the computer has been in use. It never sees the screen, apps, typing or content. */
export interface CareMoment { key: 'morning' | 'long-session' | 'late-night' | 'return' | 'silence' | 'diary' | 'reminder'; summary: string }

/** Reasons are host facts, never inferred screen content. Restraint is still evaluated by proactive-policy. */
export function contextualCareMoment(input: { now: number; minuteOfDay: number; lastOwnerTurnAt: string | null; diary?: string; reminder?: string }): CareMoment | null {
  // Never copy private material into an event that can outlive its source permission.
  // The dispatch context separately carries and revalidates the actual source.
  if (input.reminder) return { key: 'reminder', summary: 'A recent verified weather or agenda result may be worth a brief reminder. Use only the currently supplied reminder, never infer urgency.' };
  if (input.diary) return { key: 'diary', summary: 'A recent diary may contain something to mention. Use only the currently supplied diary summaries; if absent, give a brief optional hello.' };
  const gap = input.now - Date.parse(input.lastOwnerTurnAt ?? '');
  return gap >= 6 * 3_600_000 && input.minuteOfDay >= 9 * 60 && input.minuteOfDay < 21 * 60
    ? { key: 'silence', summary: 'It is daytime. The owner has not chatted for more than six hours. A brief optional hello is enough; do not imply monitoring or demand a reply.' } : null;
}

const AWAY_AFTER_SECONDS = 5 * 60;
const RETURN_AFTER_MS = 2 * 60 * 60_000;
const LONG_SESSION_MS = 90 * 60_000;

export class CareMoments {
  #activeSince: number | null = null;
  #awayFrom: number | null = null;
  #returnedAfterMs: number | null = null;
  #offeredOn = new Map<CareMoment['key'], string>();

  /** The candidate right now, if any. Report back with `offered` only once it was actually sent. */
  next(input: { now: number; idleSeconds: number; locked: boolean; day: string; minuteOfDay: number }): CareMoment | null {
    const { now, idleSeconds, locked, day, minuteOfDay } = input;
    if (locked || idleSeconds >= AWAY_AFTER_SECONDS) {
      this.#activeSince = null;
      this.#awayFrom ??= now - idleSeconds * 1_000;
      this.#returnedAfterMs = null;
      return null;
    }
    this.#activeSince ??= now;
    if (this.#awayFrom !== null) {
      if (now - this.#awayFrom >= RETURN_AFTER_MS) this.#returnedAfterMs = now - this.#awayFrom;
      this.#awayFrom = null;
    }
    const free = (key: CareMoment['key']): boolean => this.#offeredOn.get(key) !== day;
    if (free('morning') && minuteOfDay >= 6 * 60 && minuteOfDay < 11 * 60) {
      return { key: 'morning', summary: 'It is morning and the owner has just started using the computer for the first time today.' };
    }
    if (this.#returnedAfterMs !== null) {
      return { key: 'return', summary: `The owner has just come back to the computer after about ${Math.round(this.#returnedAfterMs / 3_600_000)} hours away.` };
    }
    if (free('late-night') && (minuteOfDay >= 23 * 60 || minuteOfDay < 2 * 60)) {
      return { key: 'late-night', summary: 'It is late at night and the owner is still using the computer. Gently suggest rest without nagging.' };
    }
    if (now - this.#activeSince >= LONG_SESSION_MS) {
      return { key: 'long-session', summary: `The owner has been using the computer for about ${Math.round((now - this.#activeSince) / 60_000)} minutes without a break. Gently suggest a short one.` };
    }
    return null;
  }

  offered(moment: CareMoment, input: { now: number; day: string }): void {
    this.#offeredOn.set(moment.key, input.day);
    if (moment.key === 'return') this.#returnedAfterMs = null;
    if (moment.key === 'long-session') this.#activeSince = input.now;
  }
}
