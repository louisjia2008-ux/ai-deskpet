import { setTimeout as delay } from 'node:timers/promises';

import {
  KNOWLEDGE_EMBEDDING_MODELS,
  type KnowledgeEmbeddingModel,
  type KnowledgeEmbeddingStatus,
} from '../../shared/knowledge-embedding';

const endpoint = 'http://127.0.0.1:11434';

function canonicalTag(model: string): string {
  return model.includes(':') ? model : model + ':latest';
}
export interface KnowledgeEmbeddings {
  embed(inputs: string[], signal: AbortSignal, model?: KnowledgeEmbeddingModel): Promise<number[][]>;
  status?(model: KnowledgeEmbeddingModel, signal: AbortSignal): Promise<KnowledgeEmbeddingStatus>;
}
type Fetch = typeof fetch;
export type AcquireLocalSlot = (signal: AbortSignal) => Promise<() => void>;

export class OllamaKnowledgeEmbeddings implements KnowledgeEmbeddings {
  #possiblyResident: KnowledgeEmbeddingModel | null = null;
  #recentChatRelease: { model: string; expiresAt: number } | undefined;
  constructor(
    private readonly acquire: AcquireLocalSlot,
    private readonly request: Fetch = fetch,
  ) {}
  async #json(path: string, init: RequestInit, signal: AbortSignal, limit: number): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(endpoint + path, {
        ...init,
        signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      throw new Error(signal.aborted ? 'knowledge.cancelled' : 'knowledge.ollamaUnavailable');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(response.status === 404 ? 'knowledge.embeddingModelMissing' : 'knowledge.ollamaRejected');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('knowledge.invalidEmbeddingResponse');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw new Error('knowledge.invalidEmbeddingResponse');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new Error('knowledge.invalidEmbeddingResponse');
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  async #resident(signal: AbortSignal): Promise<string[]> {
    const raw = (await this.#json('/api/ps', {}, AbortSignal.any([signal, AbortSignal.timeout(4_000)]), 128_000)) as {
      models?: Array<{ name?: string; model?: string }>;
    } | null;
    if (!raw || !Array.isArray(raw.models)) throw new Error('knowledge.residencyUnknown');
    return raw.models.map((m) => m?.name ?? m?.model ?? 'unknown');
  }
  /** Called while holding the same process-wide local slot as chat. If a previous
   * request lost its receipt, check actual residency before admitting another model. */
  async assertReleased(signal: AbortSignal): Promise<void> {
    const model = this.#possiblyResident;
    if (!model) return;
    // keep_alive:0 requested eviction after this request; never evict an unrelated model.
    for (let attempt = 0; attempt < 12; attempt++) {
      if (!(await this.#resident(signal)).some(name => canonicalTag(name) === canonicalTag(model))) {
        this.#possiblyResident = null;
        return;
      }
      await delay(250, undefined, { signal });
    }
    throw new Error('knowledge.embeddingStillLoaded');
  }
  expectChatRelease(model: string): void {
    this.#recentChatRelease = { model: canonicalTag(model), expiresAt: Date.now() + 5_000 };
  }
  async #requireIdle(signal: AbortSignal): Promise<void> {
    let resident = await this.#resident(signal);
    const expected = this.#recentChatRelease;
    while (resident.length && expected && resident.every(name => canonicalTag(name) === expected.model)) {
      const remaining = expected.expiresAt - Date.now();
      if (remaining <= 0) break;
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
      try {
        await delay(100, undefined, { signal: bounded });
        resident = await this.#resident(bounded);
      } catch (error) {
        signal.throwIfAborted();
        if (!bounded.aborted) throw error;
        break;
      }
    }
    if (resident.length) throw new Error('knowledge.localModelBusy');
  }
  async #requireLocalModel(model: KnowledgeEmbeddingModel, signal: AbortSignal): Promise<void> {
    if (!KNOWLEDGE_EMBEDDING_MODELS.includes(model)) throw new Error('knowledge.invalidEmbeddingModel');
    // A loopback daemon may expose a cloud alias. Inspect the selected model
    // locally before handing note material or queries to Ollama.
    const modelInfo = (await this.#json(
      '/api/show',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) },
      AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      4_000_000,
    )) as {
      remote_host?: unknown;
      remote_model?: unknown;
      details?: { format?: unknown };
      capabilities?: unknown;
    } | null;
    if (
      !modelInfo ||
      modelInfo.remote_host ||
      modelInfo.remote_model ||
      modelInfo.details?.format !== 'gguf' ||
      !Array.isArray(modelInfo.capabilities) ||
      !modelInfo.capabilities.includes('embedding')
    )
      throw new Error('knowledge.embeddingNotLocal');
  }
  async status(model: KnowledgeEmbeddingModel, signal: AbortSignal): Promise<KnowledgeEmbeddingStatus> {
    try {
      await this.#requireLocalModel(model, signal);
      return 'installed';
    } catch (error) {
      return error instanceof Error && error.message === 'knowledge.embeddingModelMissing' ? 'missing' : 'unavailable';
    }
  }
  // The vault supplies its selected model. A call without one uses the existing memory recall profile.
  async embed(inputs: string[], signal: AbortSignal, model: KnowledgeEmbeddingModel = 'nomic-embed-text'): Promise<number[][]> {
    if (!inputs.length || inputs.length > 16 || inputs.some((i) => !i || i.length > 3600))
      throw new Error('knowledge.embeddingBatch');
    const release = await this.acquire(signal);
    try {
      signal.throwIfAborted();
      await this.assertReleased(signal);
      await this.#requireIdle(signal);
      await this.#requireLocalModel(model, signal);
      signal.throwIfAborted();
      this.#possiblyResident = model;
      const result = (await this.#json(
        '/api/embed',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: inputs, truncate: false, keep_alive: 0 }),
        },
        // A caller can detach while Ollama is still loading. Let the one dispatched
        // bounded batch finish before releasing this slot; the caller's revoked
        // lease prevents persisting or exposing its result after this response.
        AbortSignal.timeout(100_000),
        2_000_000,
      )) as { embeddings?: unknown } | null;
      signal.throwIfAborted();
      const vectors = result?.embeddings;
      if (
        !Array.isArray(vectors) ||
        vectors.length !== inputs.length ||
        !vectors.every((v) => Array.isArray(v) && v.length > 0 && v.length <= 4096 && v.length === vectors[0]?.length && v.every((x) => typeof x === 'number' && Number.isFinite(x)))
      )
        throw new Error('knowledge.invalidEmbeddingResponse');
      return vectors as number[][];
    } finally {
      try {
        await this.assertReleased(AbortSignal.timeout(8_000));
      } finally {
        release();
      }
    }
  }
}
