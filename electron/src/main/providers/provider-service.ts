import type { ProviderConfig, ProviderDiscoveryInput, ProviderModel, ProviderRequestObservation } from '../../shared';
import { providerDefinitions, providerFailureCode } from '../../shared';
import { randomUUID } from 'node:crypto';
import type { DomainRepository } from '../domain';
import type { SafeStorageVault } from '../security';
import { OpenAICompatibleAdapter } from './openai-compatible';
import type { ProviderUtilityClient } from './utility-client';
import type { ProviderAdapter, ProviderChatRequest } from './types';
import type { ProviderModelInspection } from './types';
import { assertProviderRequestBinding, normalizedProviderBaseUrl, prepareProviderChatRequest, providerBindingFingerprint } from './request-budget';
import { InferenceAdmission } from './inference-admission';
import { chatRequestLimits } from './chat-request-policy';

/** Aliases of a local server share a slot, across models and provider records.
 * Remote origins stay independent; no endpoint gains additional concurrency. */
const LOCAL_MODEL_POOL = 'local-machine';
const inferenceResourceKey = (provider: ProviderConfig): string => {
  const endpoint = normalizedProviderBaseUrl(provider);
  const hostname = endpoint.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return LOCAL_MODEL_POOL;
  return endpoint.origin;
};

export interface ProviderDispatchHooks {
  beforeLocalModel?(signal: AbortSignal): Promise<void>;
  prepared(record: { requestId: string; bindingDigest: string; bodySHA256: string; providerId: string; model: string;
    inputEstimate: number; maxInputTokens: number; maxOutputTokens: number; capacitySource: string; endpoint?: string }): Promise<void>;
  observed(observation: ProviderRequestObservation): Promise<void>;
  beforeDispatch?(requestId: string): void;
  notDispatched?(record: Parameters<ProviderDispatchHooks['prepared']>[0], outcome: 'failed' | 'aborted'): Promise<void>;
}

export interface CapturedProviderBinding {
  provider: ProviderConfig;
  model: string;
  bindingDigest: string;
  inspection: ProviderModelInspection;
  credentialRef?: string;
  adapter: ProviderAdapter;
}

export class ProviderService {
  readonly #admission = new InferenceAdmission();
  readonly #credentialEpochs = new Map<string, number>();
  readonly #credentialMutations = new Set<string>();
  #discovering = 0;
  #invalidateCredential(id: string): void { this.#credentialEpochs.set(id, (this.#credentialEpochs.get(id) ?? 0) + 1); }

  constructor(
    private readonly repository: DomainRepository,
    private readonly vault: SafeStorageVault,
    private readonly utility?: ProviderUtilityClient,
    private readonly dispatchHooks?: ProviderDispatchHooks,
  ) {}

  acquireLocalEmbeddingSlot(signal: AbortSignal): Promise<() => void> {
    return this.#admission.acquire('background', signal, { resourceKey: LOCAL_MODEL_POOL });
  }

  list(): ProviderConfig[] {
    return this.repository.read('providers');
  }

  async setModel(id: string, model: string): Promise<ProviderConfig> {
    const selected = model.trim();
    if (!selected || selected.length > 240 || [...selected].some((character) => character.charCodeAt(0) < 32)) throw new Error('provider.invalidModel');
    return this.repository.transaction((state) => {
      const provider = state.providers.find((item) => item.id === id && item.enabled);
      if (!provider) throw new Error('provider.unavailable');
      // Change only the model; credentials, endpoint and tool permissions stay intact.
      provider.model = selected;
      return structuredClone(provider);
    });
  }

  async upsert(input: Omit<ProviderConfig, 'secretState'>, apiKey?: string): Promise<ProviderConfig> {
    return this.#credentialMutation(input.id, () => this.#upsert(input, apiKey));
  }

  async #credentialMutation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.#credentialMutations.has(id)) throw new Error('provider.configurationBusy');
    this.#credentialMutations.add(id);
    try { return await operation(); } finally { this.#credentialMutations.delete(id); }
  }

  async #upsert(input: Omit<ProviderConfig, 'secretState'>, apiKey?: string): Promise<ProviderConfig> {
    const nextEndpoint = normalizedProviderBaseUrl({ ...input, secretState: 'missing' }).toString();
    const previous = this.repository.snapshot().providers.find((item) => item.id === input.id);
    if (previous?.secretState === 'unavailable' && apiKey === undefined) throw new Error('provider.credentialsRequired');
    // An edited endpoint must never inherit a secret intended for another service.
    if (apiKey === undefined && previous && (previous.kind !== input.kind
      || normalizedProviderBaseUrl(previous).toString() !== nextEndpoint)
      && this.vault.isAvailable() && await this.vault.hasSecret(input.id)) throw new Error('provider.credentialEndpointChanged');
    if (apiKey !== undefined) {
      this.#invalidateCredential(input.id);
      // A key file and the encrypted profile are separate durable writes. Save a
      // disabled marker first so any interruption fails closed, including after
      // a new process starts. Never roll old credentials back without proof.
      await this.repository.transaction((state) => {
        const current = state.providers.find((item) => item.id === input.id);
        if (current) { current.enabled = false; current.secretState = 'unavailable'; }
        else state.providers.push({ ...input, enabled: false, secretState: 'unavailable' });
        state.providerCredentialRefs[input.id] = randomUUID();
      });
      await this.vault.setSecret(input.id, apiKey);
    }
    const secretState = this.vault.isAvailable()
      ? (await this.vault.hasSecret(input.id))
        ? 'configured'
        : 'missing'
      : 'unavailable';
    const config: ProviderConfig = { ...input, secretState };
    await this.repository.transaction((state) => {
      const index = state.providers.findIndex((item) => item.id === config.id);
      if (index === -1) state.providers.push(config);
      else state.providers[index] = config;
    });
    return config;
  }

  async discoverModels(input: ProviderDiscoveryInput): Promise<ProviderModel[]> {
    if (this.#discovering >= 2) throw new Error('provider.discoveryBusy');
    this.#discovering++;
    try {
      const config: ProviderConfig = {
        id: input.existingProviderId ?? randomUUID(), kind: input.kind, name: 'Model discovery',
        baseUrl: input.baseUrl, model: '__catalog_only__', enabled: false, supportsTools: false, secretState: 'missing',
      };
      const endpoint = normalizedProviderBaseUrl(config).toString();
      let apiKey = input.apiKey ?? null;
      let assertCurrent = async (): Promise<void> => {};
      if (apiKey === null && input.existingProviderId) {
        const id = input.existingProviderId;
        const stored = this.repository.snapshot().providers.find((item) => item.id === id);
        if (!stored || stored.kind !== input.kind || normalizedProviderBaseUrl(stored).toString() !== endpoint) {
          throw new Error('provider.credentialEndpointChanged');
        }
        if (stored.secretState === 'unavailable') throw new Error('provider.credentialsRequired');
        const epoch = this.#credentialEpochs.get(id) ?? 0;
        apiKey = await this.vault.getSecret(id);
        assertCurrent = async () => {
          const current = this.repository.snapshot().providers.find((item) => item.id === id);
          if (!current || current.secretState === 'unavailable' || current.kind !== input.kind || normalizedProviderBaseUrl(current).toString() !== endpoint
            || (this.#credentialEpochs.get(id) ?? 0) !== epoch || await this.vault.getSecret(id) !== apiKey) {
            throw new Error('provider.bindingMismatch');
          }
        };
      }
      if (providerDefinitions.find((item) => item.kind === input.kind)?.apiKeyRequired && !apiKey?.trim()) {
        throw new Error('provider.credentialsRequired');
      }
      await assertCurrent();
      const credentials = { config, apiKey };
      const adapter = this.utility?.adapter(credentials) ?? new OpenAICompatibleAdapter(credentials);
      const result = await adapter.listModels();
      await assertCurrent();
      return result;
    } catch (error) {
      // Do not send upstream bodies, URLs, credentials or parse diagnostics to a renderer.
      throw new Error(providerFailureCode(error, 'provider.discoveryFailed'));
    } finally { this.#discovering--; }
  }

  async adapter(id: string): Promise<ProviderAdapter> {
    const config = this.repository.snapshot().providers.find((item) => item.id === id);
    if (config === undefined) throw new Error('Provider does not exist.');
    if (config.secretState === 'unavailable') throw new Error('provider.credentialsRequired');
    const epoch = this.#credentialEpochs.get(id) ?? 0;
    const credentials = { config, apiKey: await this.vault.getSecret(id) };
    const assertMetadataCurrent = async (): Promise<void> => {
      const key = await this.vault.getSecret(id);
      const current = this.repository.snapshot().providers.find((item) => item.id === id);
      if ((this.#credentialEpochs.get(id) ?? 0) !== epoch || key !== credentials.apiKey || !current || providerBindingFingerprint(current, config.model) !== providerBindingFingerprint(config, config.model)) throw new Error('provider.bindingMismatch');
    };
    await assertMetadataCurrent();
    const original = this.utility?.adapter(credentials, this.dispatchHooks?.observed.bind(this.dispatchHooks)) ?? new OpenAICompatibleAdapter(credentials);
    const captureBinding = this.captureBinding.bind(this);
    return {
      async *streamChat(request, signal, options) {
        // Existing non-chat callers also pass through the shared generation
        // limits. The configuration captured above must still be current.
        const binding = await captureBinding(id, request.model, config);
        yield* binding.adapter.streamChat(request, signal, options);
      },
      listModels: async (signal) => { await assertMetadataCurrent(); const result = await original.listModels(signal); await assertMetadataCurrent(); return result; },
      ...(original.inspectModel ? { inspectModel: async (model: string, signal?: AbortSignal) => { await assertMetadataCurrent(); return original.inspectModel!(model, signal); } } : {}),
    };
  }

  /** Capture endpoint and policy before resolving credentials or service metadata. */
  async credentialReference(id: string): Promise<string> {
    const existing = this.repository.snapshot().providerCredentialRefs[id];
    if (existing) return existing;
    return this.repository.transaction((state) => state.providerCredentialRefs[id] ??= randomUUID());
  }

  async #rotateCredentialReference(id: string): Promise<void> {
    await this.repository.transaction((state) => { state.providerCredentialRefs[id] = randomUUID(); });
  }

  async captureBinding(id: string, requestedModel?: string, expectedProvider?: ProviderConfig, expectedCredentialRef?: string): Promise<CapturedProviderBinding> {
    const current = this.repository.snapshot().providers.find((item) => item.id === id && item.enabled);
    if (!current) throw new Error('provider.unavailable');
    const provider = expectedProvider === undefined ? current : structuredClone(expectedProvider);
    const model = requestedModel ?? provider.model;
    const bindingDigest = providerBindingFingerprint(provider, model);
    if (providerBindingFingerprint(current, model) !== bindingDigest) throw new Error('provider.bindingMismatch');
    const credentialRef = await this.credentialReference(id);
    if (expectedCredentialRef !== undefined && expectedCredentialRef !== credentialRef) throw new Error('provider.bindingMismatch');
    const epoch = this.#credentialEpochs.get(id) ?? 0;
    const credentials = { config: structuredClone(provider), apiKey: await this.vault.getSecret(id) };
    const original = this.utility?.adapter(credentials, this.dispatchHooks?.observed.bind(this.dispatchHooks)) ?? new OpenAICompatibleAdapter(credentials);
    const assertCurrent = (): void => {
      const current = this.repository.snapshot().providers.find((item) => item.id === id && item.enabled);
      if ((this.#credentialEpochs.get(id) ?? 0) !== epoch || this.repository.snapshot().providerCredentialRefs[id] !== credentialRef || !current || providerBindingFingerprint(current, model) !== bindingDigest) throw new Error('provider.bindingMismatch');
    };
    const assertCredentialCurrent = async (): Promise<void> => {
      const currentKey = await this.vault.getSecret(id); assertCurrent();
      if (currentKey !== credentials.apiKey) throw new Error('provider.bindingMismatch');
    };
    await assertCredentialCurrent();
    let inspection: ProviderModelInspection = { contextWindowTokens: null, executionDestination: 'unknown', source: 'unknown' };
    if (original.inspectModel) {
      try { inspection = await original.inspectModel(model); }
      catch { /* Unknown metadata never becomes a local execution attestation. */ }
    }
    await assertCredentialCurrent();
    const hooks = this.dispatchHooks;
    const captured = { provider: structuredClone(provider), model, bindingDigest, inspection, credentialRef };
    const admission = this.#admission;
    const resourceKey = inferenceResourceKey(provider);
    const repository = this.repository;
    return {
      ...captured,
      adapter: {
        async *streamChat(request, signal, options) {
          const release = await admission.acquire(request.executionMode === 'background-text' ? 'background' : 'foreground', signal, { ...options, resourceKey });
          let preparedRecord: Parameters<ProviderDispatchHooks['prepared']>[0] | undefined;
          let adapterEntered = false;
          try {
          if (resourceKey === LOCAL_MODEL_POOL) await hooks?.beforeLocalModel?.(signal ?? new AbortController().signal);
          options?.assertCurrent?.();
          await assertCredentialCurrent();
          if (signal?.aborted) throw new DOMException('Provider request cancelled.', 'AbortError');
          if (request.model !== model || (request.identity && request.identity.bindingDigest !== bindingDigest)) throw new Error('provider.bindingMismatch');
          const limits = chatRequestLimits({ ...captured, adapter: original });
          if (request.contextBudget && request.contextBudget.contextWindowTokens > limits.contextBudget.contextWindowTokens) throw new Error('provider.invalidRequestBudget');
          const finalRequest: ProviderChatRequest = {
            ...request,
            ...(request.identity === undefined && limits.ollamaNumCtx !== undefined ? { ollamaNumCtx: limits.ollamaNumCtx } : {}),
            ...(request.identity === undefined && limits.wireProtocol ? { wireProtocol: limits.wireProtocol } : {}),
            ...(request.identity === undefined && request.reasoningEffort === undefined && limits.reasoningEffort ? { reasoningEffort: limits.reasoningEffort } : {}),
            maxOutputTokens: request.maxOutputTokens ?? limits.maxOutputTokens,
            outputTokenParameter: request.outputTokenParameter ?? limits.outputTokenParameter,
            contextBudget: request.contextBudget ?? limits.contextBudget,
            identity: request.identity ?? { requestId: randomUUID(), bindingDigest },
          };
          assertProviderRequestBinding(provider, finalRequest);
          const prepared = prepareProviderChatRequest(finalRequest);
          preparedRecord = { requestId: finalRequest.identity!.requestId, bindingDigest, bodySHA256: prepared.bodySHA256,
            providerId: provider.id, model, endpoint: normalizedProviderBaseUrl(provider).toString(), inputEstimate: prepared.inputEstimate, maxInputTokens: prepared.maxInputTokens!,
            maxOutputTokens: finalRequest.maxOutputTokens!, capacitySource: finalRequest.contextBudget!.capacitySource };
          try {
            await hooks?.prepared(preparedRecord);
          } catch (error) { if (error instanceof Error && (error.message === 'repository.commitUncertain' || error.message.startsWith('delegation.') || error.message.startsWith('consolidation.') || error.message.startsWith('automation.') || error.message === 'provider.budgetExceeded')) throw error; throw new Error('provider.requestRecordFailed'); }
          await assertCredentialCurrent();
          // A control mutation may already have renamed its authoritative file
          // while its acknowledgement is still pending. Join that authority
          // boundary before the final synchronous check and utility post.
          await options?.validateBeforeSend?.();
          await repository.flush();
          await repository.recoverAuthority();
          assertCurrent();
          hooks?.beforeDispatch?.(finalRequest.identity!.requestId);
          options?.assertCurrent?.();
          if (signal?.aborted) throw new DOMException('Provider request cancelled.', 'AbortError');
          adapterEntered = true;
          for await (const event of original.streamChat(finalRequest, signal)) {
            if (event.type === 'request-observation') {
              try { await hooks?.observed(event.observation); }
              catch (error) { if (error instanceof Error && (error.message === 'repository.commitUncertain' || error.message.startsWith('delegation.') || error.message.startsWith('consolidation.') || error.message.startsWith('automation.') || error.message === 'provider.budgetExceeded')) throw error; throw new Error('provider.requestRecordFailed'); }
            }
            yield event;
          }
          } catch (error) {
            if (!adapterEntered && preparedRecord !== undefined) {
              try { await hooks?.notDispatched?.(preparedRecord, signal?.aborted ? 'aborted' : 'failed'); }
              catch { /* Keep the original failure and the conservative reservation if durable cleanup is uncertain. */ }
            }
            throw error;
          } finally { release(); }
        },
        listModels: async (signal) => { await assertCredentialCurrent(); return original.listModels(signal); },
        ...(original.inspectModel ? { inspectModel: async (selected: string, signal?: AbortSignal) => { await assertCredentialCurrent(); return original.inspectModel!(selected, signal); } } : {}),
      },
    };
  }

  async remove(id: string): Promise<void> {
    return this.#credentialMutation(id, async () => {
    this.#invalidateCredential(id);
    await this.#rotateCredentialReference(id);
    await this.vault.deleteSecret(id);
    await this.repository.transaction((state) => {
      state.providers = state.providers.filter((item) => item.id !== id);
    });
    });
  }

  async clearSecret(id: string): Promise<ProviderConfig> {
    return this.#credentialMutation(id, async () => {
    this.#invalidateCredential(id);
    await this.#rotateCredentialReference(id);
    await this.vault.deleteSecret(id);
    return this.repository.transaction((state) => {
      const config = state.providers.find((item) => item.id === id);
      if (config === undefined) throw new Error('Provider does not exist.');
      config.secretState = 'missing';
      return structuredClone(config);
    });
    });
  }
}
