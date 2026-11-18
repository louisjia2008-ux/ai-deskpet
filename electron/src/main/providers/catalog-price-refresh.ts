/** Price discovery is best effort. Concurrent first requests share its result
 * before freezing prices; a network failure gets a short retry cooldown. */
export class CatalogPriceRefresh {
  readonly #entries = new Map<string, { notBefore: number; pending?: Promise<void> | undefined }>();
  constructor(private readonly now: () => number = Date.now) {}

  run(key: string, refresh: () => Promise<unknown>): Promise<void> {
    const previous = this.#entries.get(key);
    if (previous?.pending) return previous.pending;
    if (previous && this.now() < previous.notBefore) return Promise.resolve();
    const entry: { notBefore: number; pending?: Promise<void> | undefined } = { notBefore: 0 };
    // Defer invocation until the entry is visible to other request owners.
    entry.pending = Promise.resolve().then(refresh).then(
      () => { entry.notBefore = this.now() + 86_400_000; },
      () => { entry.notBefore = this.now() + 300_000; },
    ).finally(() => { entry.pending = undefined; });
    this.#entries.set(key, entry);
    return entry.pending;
  }
}
