import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirmedMemoryMetadata } from '../src/main/domain/context-provenance';
import { DomainRepository } from '../src/main/domain/repository';
import type { ProviderAdapter, ProviderChatRequest, ProviderDispatchOptions } from '../src/main/providers/types';
import type { MemoryItem } from '../src/shared';
import { adapter, evalSettings } from './runner';

/** A throwaway encrypted profile, as the app keeps one; removed by `dispose`. */
export const scratchRepository = async (): Promise<{ repository: DomainRepository; dispose(): Promise<void> }> => {
  const directory = await mkdtemp(join(tmpdir(), 'deskpet-eval-'));
  const repository = new DomainRepository(join(directory, 'profile.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 41) });
  await repository.initialize();
  return { repository, dispose: () => rm(directory, { recursive: true, force: true }) };
};

/** The production adapter for the model under test, keeping a copy of each request and of the raw reply text. */
export const recordingAdapter = (): { adapter: ProviderAdapter; requests: ProviderChatRequest[]; replies: Array<{ text: string; finished: boolean }> } => {
  const settings = evalSettings(), real = adapter(settings.model, settings.baseUrl);
  const requests: ProviderChatRequest[] = [], replies: Array<{ text: string; finished: boolean }> = [];
  const recorded = {
    async *streamChat(request: ProviderChatRequest, signal?: AbortSignal, options?: ProviderDispatchOptions) {
      await options?.validateBeforeSend?.();
      requests.push(structuredClone(request));
      const reply = { text: '', finished: false };
      replies.push(reply);
      for await (const event of real.streamChat(request, signal)) {
        if (event.type === 'text') reply.text += event.text;
        if (event.type === 'done' && (event.finishReason === 'stop' || event.finishReason === 'completed')) reply.finished = true;
        yield event;
      }
    },
  } as unknown as ProviderAdapter;
  return { adapter: recorded, requests, replies };
};

/** A memory as the app stores one the owner may send to the cloud. */
export const storedMemory = (text: string, input: { origin: 'auto-profile' | 'manual-user'; layer?: 'shallow' | 'deep'; updatedAt: string }): MemoryItem => {
  const metadata = confirmedMemoryMetadata({ origin: input.origin, sourceReferences: [{ kind: 'manual-user', actionId: randomUUID() }], privacy: 'cloud-allowed' });
  return { id: randomUUID(), text, tags: input.origin === 'auto-profile' ? ['auto'] : [], source: 'user', createdAt: input.updatedAt, updatedAt: input.updatedAt,
    contextMetadata: input.layer ? { ...metadata, layer: input.layer } : metadata };
};
