import type { ProviderConfig } from '../../../shared';
import type { ProviderService } from '../../providers';
import { OpenAICompatibleAdapter } from '../../providers/openai-compatible';
import { providerBindingFingerprint } from '../../providers/request-budget';
import type { WeChatArticleGuard } from './wechat-articles';

export interface WeChatEvidenceRoute {
  provider: ProviderConfig;
  routeFingerprint: string;
  destination: 'local' | 'remote';
  credentialRef: string | null;
}

const loopback = 'http://127.0.0.1:11434/v1';
export const wechatLocalEvidenceRoute = (model: string): WeChatEvidenceRoute => {
  const provider: ProviderConfig = {
    id: '6d9f2953-8781-4549-936a-ea0e9d88b5d1', kind: 'ollama', name: 'WeChat local Ollama',
    baseUrl: loopback, model, enabled: true, supportsTools: false, secretState: 'missing', localExecutionConfirmed: true, ollamaNumCtx: 4_096,
  };
  return { provider, routeFingerprint: providerBindingFingerprint(provider, model), destination: 'local', credentialRef: null };
};

export async function chooseWeChatEvidenceRoute(host: {
  cloudAllowed(): Promise<boolean>;
  remote(): Promise<WeChatEvidenceRoute | null>;
  local(): Promise<WeChatEvidenceRoute>;
}): Promise<WeChatEvidenceRoute> {
  if (await host.cloudAllowed()) {
    const route = await host.remote();
    if (route) return route;
  }
  return host.local();
}

const identity = (route: WeChatEvidenceRoute): string =>
  JSON.stringify([route.destination, route.routeFingerprint, route.credentialRef, providerBindingFingerprint(route.provider, route.provider.model)]);

/** Capture a route only after authorization, with no generic agent, tools or memory. */
export async function completeWeChatEvidence(input: {
  prompt: string; data: string; guard: WeChatArticleGuard; select(): Promise<WeChatEvidenceRoute>;
  providers: Pick<ProviderService, 'captureBinding' | 'acquireLocalEmbeddingSlot'>;
  modelResult?(provider: ProviderConfig, error?: unknown): void;
}): Promise<string> {
  const { guard, select } = input;
  await guard.assertCurrent();
  const chosen = await select();
  const model = chosen.provider.model;
  const snapshot = identity(chosen);
  const signal = AbortSignal.any([guard.signal, AbortSignal.timeout(65_000)]);
  const current = async (): Promise<void> => {
    signal.throwIfAborted();
    await guard.assertCurrent();
    if (identity(await select()) !== snapshot) throw Error('wechat.evidenceRouteChanged');
    await guard.assertCurrent();
    signal.throwIfAborted();
  };
  const local = chosen.destination === 'local';
  if (local && (chosen.provider.kind !== 'ollama' || chosen.provider.baseUrl !== loopback || chosen.credentialRef !== null)) throw Error('wechat.evidenceNotLocal');
  const loopbackAdapter = local ? new OpenAICompatibleAdapter({ config: chosen.provider, apiKey: null }) : null;
  const adapter = loopbackAdapter ??
    (await input.providers.captureBinding(chosen.provider.id, model, chosen.provider, chosen.credentialRef ?? undefined)).adapter;
  const release = local ? await input.providers.acquireLocalEmbeddingSlot(signal) : undefined;
  try {
    await current();
    if (loopbackAdapter) {
      const inspection = await loopbackAdapter.inspectModel(model, signal);
      if (inspection.localGguf !== true || inspection.executionDestination === 'remote') throw Error('wechat.evidenceNotLocal');
      await current();
    }
    let reply = '', finished = false;
    const request = { model, executionMode: 'background-text' as const, maxOutputTokens: 700,
      ...(local ? { reasoningEffort: 'none' as const } : {}),
      messages: [{ role: 'system' as const, content: input.prompt }, { role: 'user' as const, content: input.data }] };
    for await (const event of adapter.streamChat(request, signal, { validateBeforeSend: current, assertCurrent: () => signal.throwIfAborted() })) {
      signal.throwIfAborted();
      if (event.type === 'tool-call') throw Error('wechat.evidenceUnexpectedToolCall');
      if (event.type === 'text') reply += event.text;
      if (reply.length > 6_000) throw Error('wechat.evidenceResponseTooLong');
      if (event.type === 'done') finished = ['stop', 'completed', 'end_turn'].includes(event.finishReason ?? '');
    }
    await current();
    if (!finished || !reply.trim()) throw Error('wechat.evidenceIncomplete');
    if (!local) input.modelResult?.(chosen.provider);
    return reply;
  } catch (error) {
    if (!local && !signal.aborted) input.modelResult?.(chosen.provider, error);
    throw error;
  } finally {
    release?.();
  }
}
