import { tmpdir as appTemporaryDirectory } from 'node:os';
import { randomUUID } from 'node:crypto';
import { warn } from 'node:console';
import { join } from 'node:path';
import { boundedChildEnvironment } from '../security/child-environment';
import { utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';

import { providerUtilityResponseSchema } from '../../utility/provider-protocol';
import type { ProviderUtilityCommand } from '../../utility/provider-protocol';
import type { ProviderAdapter, ProviderChatRequest, ProviderCredentials, ProviderModelInspection, ProviderStreamEvent } from './types';
import type { ProviderModel, ProviderRequestObservation } from '../../shared';
import { providerSilenceLimitMs } from './silence-limits';

interface StreamPending {
  kind: 'stream';
  queue: ProviderStreamEvent[];
  done: boolean;
  locallyStopped: boolean;
  transportDone: boolean;
  drained: Promise<void>;
  resolveDrain(): void;
  lateObserver: ((observation: ProviderRequestObservation) => Promise<void>) | undefined;
  lateObservations: Array<Promise<void>>;
  error: Error | null;
  wake: (() => void) | null;
  timeout: ReturnType<typeof setTimeout> | null;
  silenceLimitMs: number;
}

interface ModelsPending {
  kind: 'models';
  resolve(models: ProviderModel[]): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout> | null;
}

interface InspectionPending {
  kind: 'inspection';
  resolve(inspection: ProviderModelInspection): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout> | null;
}

type Pending = StreamPending | ModelsPending | InspectionPending;

export class ProviderUtilityClient {
  #process: UtilityProcess | null = null;
  #disposed = false;
  readonly #pending = new Map<string, Pending>();
  readonly #idleTimeoutMs: number;
  readonly #firstResponseTimeoutMs: number;
  readonly #streamTimeoutMs: number | undefined;
  readonly #drainTimeoutMs: number;
  #transportUncertain = false;

  constructor(private readonly modulePath = join(__dirname, 'utility.js'), idleTimeoutMs?: number, drainTimeoutMs = 2_000) {
    this.#idleTimeoutMs = idleTimeoutMs ?? 65_000;
    this.#drainTimeoutMs = drainTimeoutMs;
    this.#firstResponseTimeoutMs = idleTimeoutMs ?? 185_000;
    this.#streamTimeoutMs = idleTimeoutMs;
  }

  #ensureProcess(): UtilityProcess {
    if (this.#disposed) throw new Error('provider.unavailable');
    if (this.#process !== null) return this.#process;
    // Do not fork during initial keychain access: a synchronous macOS approval
    // dialog can block the parent long enough for Chromium to lose the child.
    const child = utilityProcess.fork(this.modulePath, [], { serviceName: 'DeskPet Provider Runtime', env: boundedChildEnvironment(), cwd: process.env.TMPDIR ?? appTemporaryDirectory() });
    this.#process = child;
    child.on('message', (message) => this.#receive(message));
    child.on('exit', (code) => {
      if (this.#process !== child) return;
      this.#process = null;
      // Only an observed process exit proves all owned local transports ended.
      this.#transportUncertain = false;
      warn(`DeskPet Provider runtime exited (${code}).`);
      for (const [requestId] of this.#pending) this.#fail(requestId, new Error('provider.unavailable'), true);
    });
    return child;
  }

  #fail(requestId: string, error: Error, transportStopped = false): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    if (pending.timeout !== null) clearTimeout(pending.timeout);
    pending.timeout = null;
    if (pending.kind !== 'stream') { this.#pending.delete(requestId); pending.reject(error); }
    else {
      pending.error = error; pending.done = true; pending.locallyStopped = true;
      if (transportStopped) this.#acknowledgeTransport(requestId, pending);
      pending.wake?.(); pending.wake = null;
    }
  }

  #acknowledgeTransport(requestId: string, pending: StreamPending): void {
    pending.transportDone = true;
    pending.resolveDrain();
    this.#pending.delete(requestId);
  }

  async #drain(pending: StreamPending): Promise<void> {
    if (pending.transportDone) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      pending.drained,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, this.#drainTimeoutMs); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    // A local cancel is not a worker acknowledgement. Keep generation closed
    // until actual worker exit if bounded cleanup could not be confirmed.
    // Metadata remains available; cancelling one job never kills this process.
    if (!pending.transportDone) this.#transportUncertain = true;
  }

  #watch(requestId: string, pending: Pending, first = false): void {
    if (pending.timeout !== null) clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => {
      this.#cancelRemote(requestId);
      this.#fail(requestId, new Error('provider.timeout'));
    }, pending.kind === 'stream' ? pending.silenceLimitMs : first ? this.#firstResponseTimeoutMs : this.#idleTimeoutMs);
  }

  #cancelRemote(requestId: string): void {
    try { this.#process?.postMessage({ version: 1, kind: 'provider:cancel', requestId }); }
    catch { /* Local cancellation and timeouts must still complete after exit. */ }
  }

  #receive(value: unknown): void {
    const parsed = providerUtilityResponseSchema.safeParse(value);
    if (!parsed.success) return;
    const response = parsed.data;
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined) return;
    if (pending.kind === 'inspection') {
      if (response.kind !== 'provider:inspect-model-result' && response.kind !== 'provider:error') return;
      if (pending.timeout !== null) clearTimeout(pending.timeout);
      this.#pending.delete(response.requestId);
      if (response.kind === 'provider:inspect-model-result') pending.resolve(response.inspection);
      else pending.reject(new Error(response.errorCode));
      return;
    }
    if (pending.kind === 'models') {
      if (response.kind !== 'provider:models-result' && response.kind !== 'provider:error') return;
      if (pending.timeout !== null) clearTimeout(pending.timeout);
      if (response.kind === 'provider:models-result') pending.resolve(response.models);
      else if (response.kind === 'provider:error') pending.reject(new Error(response.errorCode));
      if (response.kind === 'provider:models-result' || response.kind === 'provider:error') this.#pending.delete(response.requestId);
      return;
    }
    if (pending.timeout !== null) clearTimeout(pending.timeout);
    if (response.kind === 'provider:event') {
      if (pending.locallyStopped) {
        // Late transport accounting bypasses business output, including on an
        // early consumer return. Attach rejection handling immediately; finally
        // still awaits these original promises so authority failures propagate.
        if (response.event.type === 'request-observation' && pending.lateObserver) {
          const observation = response.event.observation;
          const recorded = Promise.resolve().then(() => pending.lateObserver!(observation));
          void recorded.catch(() => undefined);
          pending.lateObservations.push(recorded);
        }
      } else pending.queue.push(response.event);
    }
    else if (response.kind === 'provider:error') {
      pending.error ??= new Error(response.errorCode);
      pending.done = true;
      this.#acknowledgeTransport(response.requestId, pending);
    } else if (response.kind === 'provider:complete') {
      pending.done = true;
      this.#acknowledgeTransport(response.requestId, pending);
    }
    pending.wake?.();
    pending.wake = null;
    if (!pending.done) this.#watch(response.requestId, pending);
  }

  adapter(credentials: ProviderCredentials, lateObserver?: (observation: ProviderRequestObservation) => Promise<void>): ProviderAdapter {
    return new UtilityProviderAdapter(this, credentials, lateObserver);
  }

  async *stream(credentials: ProviderCredentials, request: ProviderChatRequest, signal?: AbortSignal, lateObserver?: (observation: ProviderRequestObservation) => Promise<void>): AsyncGenerator<ProviderStreamEvent> {
    if (signal?.aborted) throw new DOMException('Provider request cancelled.', 'AbortError');
    if (this.#transportUncertain || [...this.#pending.values()].some((item) => item.kind === 'stream' && item.locallyStopped && !item.transportDone)) throw new Error('provider.transportUncertain');
    this.#ensureProcess();
    const requestId = randomUUID();
    let resolveDrain!: () => void;
    const drained = new Promise<void>((resolve) => { resolveDrain = resolve; });
    const pending: StreamPending = { kind: 'stream', queue: [], done: false, locallyStopped: false, transportDone: false, drained, resolveDrain, lateObserver, lateObservations: [], error: null, wake: null, timeout: null,
      // Outlasts the worker's own limit, so the worker normally reports the timeout.
      silenceLimitMs: this.#streamTimeoutMs ?? providerSilenceLimitMs(credentials.config.kind) + 5_000 };
    let posted = false;
    this.#pending.set(requestId, pending);
    const cancel = () => {
      if (!pending.transportDone) this.#cancelRemote(requestId);
      pending.locallyStopped = true;
      if (pending.timeout !== null) clearTimeout(pending.timeout);
      pending.timeout = null;
      pending.error = new DOMException('Provider request cancelled.', 'AbortError');
      pending.done = true;
      pending.wake?.();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      this.#watch(requestId, pending, true);
      // Treat an uncertain post as possibly handed to the worker.
      posted = true;
      this.#post({ version: 1, kind: 'provider:chat', requestId, credentials, request });
      while (!pending.done || pending.queue.length > 0) {
        if (pending.queue.length === 0) await new Promise<void>((resolve) => { pending.wake = resolve; });
        while (pending.queue.length > 0) {
          const event = pending.queue.shift();
          if (event !== undefined) yield event;
        }
        if (pending.error !== null) throw pending.error;
      }
      if (pending.error !== null) throw pending.error;
    } finally {
      if (pending.timeout !== null) clearTimeout(pending.timeout);
      signal?.removeEventListener('abort', cancel);
      // Keep the caller's inference slot through local transport cleanup. The
      // worker only emits complete/error after the adapter's finally block.
      if (posted && !pending.transportDone) {
        pending.locallyStopped = true;
        this.#cancelRemote(requestId);
        await this.#drain(pending);
      }
      try { await Promise.all(pending.lateObservations); }
      finally { if (!posted || pending.transportDone) this.#pending.delete(requestId); }
    }
  }

  inspectModel(credentials: ProviderCredentials, model: string, signal?: AbortSignal): Promise<ProviderModelInspection> {
    if (signal?.aborted) return Promise.reject(new DOMException('Provider request cancelled.', 'AbortError'));
    try { this.#ensureProcess(); } catch { return Promise.reject(new Error('provider.unavailable')); }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.#cancelRemote(requestId);
        this.#fail(requestId, new DOMException('Provider request cancelled.', 'AbortError'));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      const pending: InspectionPending = {
        kind: 'inspection', timeout: null,
        resolve: (inspection) => { signal?.removeEventListener('abort', cancel); resolve(inspection); },
        reject: (error) => { signal?.removeEventListener('abort', cancel); reject(error); },
      };
      this.#pending.set(requestId, pending);
      this.#watch(requestId, pending);
      try { this.#post({ version: 1, kind: 'provider:inspect-model', requestId, credentials, model }); }
      catch { this.#fail(requestId, new Error('provider.unavailable')); }
    });
  }

  models(credentials: ProviderCredentials, signal?: AbortSignal): Promise<ProviderModel[]> {
    if (signal?.aborted) return Promise.reject(new DOMException('Provider request cancelled.', 'AbortError'));
    try { this.#ensureProcess(); } catch { return Promise.reject(new Error('provider.unavailable')); }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.#cancelRemote(requestId);
        this.#fail(requestId, new DOMException('Provider request cancelled.', 'AbortError'));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      const pending: ModelsPending = {
        kind: 'models',
        timeout: null,
        resolve: (models) => {
          signal?.removeEventListener('abort', cancel);
          resolve(models);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', cancel);
          reject(error);
        },
      };
      this.#pending.set(requestId, pending);
      this.#watch(requestId, pending);
      try { this.#post({ version: 1, kind: 'provider:models', requestId, credentials }); }
      catch { this.#fail(requestId, new Error('provider.unavailable')); }
    });
  }

  #post(command: ProviderUtilityCommand): void {
    if (this.#process === null) throw new Error('provider.unavailable');
    this.#process.postMessage(command);
  }

  dispose(): void {
    this.#disposed = true;
    this.#process?.kill();
    this.#process = null;
    for (const [requestId] of this.#pending) this.#fail(requestId, new Error('provider.unavailable'), true);
  }
}

class UtilityProviderAdapter implements ProviderAdapter {
  private readonly credentials: ProviderCredentials;

  constructor(
    private readonly client: ProviderUtilityClient,
    credentials: ProviderCredentials,
    private readonly lateObserver?: (observation: ProviderRequestObservation) => Promise<void>,
  ) {
    this.credentials = { config: { ...credentials.config }, apiKey: credentials.apiKey };
  }

  streamChat(request: ProviderChatRequest, signal?: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    return this.client.stream(this.credentials, request, signal, this.lateObserver);
  }

  listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    return this.client.models(this.credentials, signal);
  }

  inspectModel(model: string, signal?: AbortSignal): Promise<ProviderModelInspection> {
    return this.client.inspectModel(this.credentials, model, signal);
  }
}
