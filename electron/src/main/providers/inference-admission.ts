import type { ProviderDispatchOptions } from './types';

export type InferencePriority = 'foreground' | 'background';

interface Waiter {
  priority: InferencePriority;
  signal: AbortSignal | undefined;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abort: () => void;
  onAdmissionState: ProviderDispatchOptions['onAdmissionState'];
}

interface ResourcePool {
  held: boolean;
  waiting: Waiter[];
}

interface AdmissionOptions extends ProviderDispatchOptions {
  resourceKey?: string;
}

const cancelled = (signal?: AbortSignal): unknown => signal?.reason ?? new DOMException('Provider request cancelled.', 'AbortError');
const notify = (waiter: Waiter, state: 'queued' | 'running'): void => {
  // Status observers must never interrupt dispatch or strand a held slot.
  try { waiter.onAdmissionState?.(state); } catch { /* Observability is best-effort. */ }
};

/** One in-process inference slot per resource, shared by chat and text jobs.
 * Foreground waiters take the next free slot; an active request is not preempted.
 * This is transport admission, not proof that a remote server stopped computing. */
export class InferenceAdmission {
  readonly #pools = new Map<string, ResourcePool>();

  acquire(priority: InferencePriority, signal?: AbortSignal, options: AdmissionOptions = {}): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(cancelled(signal));
    const resourceKey = options.resourceKey ?? 'default';
    const pool = this.#pools.get(resourceKey) ?? { held: false, waiting: [] };
    this.#pools.set(resourceKey, pool);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        priority, signal, resolve, reject, onAdmissionState: options.onAdmissionState,
        abort: () => {
          const index = pool.waiting.indexOf(waiter);
          if (index < 0) return;
          pool.waiting.splice(index, 1);
          signal?.removeEventListener('abort', waiter.abort);
          reject(cancelled(signal));
          this.#drain(resourceKey, pool);
        },
      };
      pool.waiting.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      if (pool.held) notify(waiter, 'queued');
      this.#drain(resourceKey, pool);
    });
  }

  #drain(resourceKey: string, pool: ResourcePool): void {
    if (pool.held) return;
    if (pool.waiting.length === 0) { this.#pools.delete(resourceKey); return; }
    const foreground = pool.waiting.findIndex((waiter) => waiter.priority === 'foreground');
    const waiter = pool.waiting.splice(foreground < 0 ? 0 : foreground, 1)[0]!;
    waiter.signal?.removeEventListener('abort', waiter.abort);
    if (waiter.signal?.aborted) { waiter.reject(cancelled(waiter.signal)); this.#drain(resourceKey, pool); return; }
    pool.held = true;
    let released = false;
    notify(waiter, 'running');
    waiter.resolve(() => {
      if (released) return;
      released = true;
      pool.held = false;
      this.#drain(resourceKey, pool);
    });
  }
}
