import { z } from 'zod';
import type { ProviderConfig } from './contracts';

export const modelFallbackSchema = z.object({
  enabled: z.boolean(),
  providerIds: z.array(z.string().uuid()).max(3).refine(ids => new Set(ids).size === ids.length),
}).strict().refine(value => !value.enabled || value.providerIds.length > 0);
export type ModelFallback = z.infer<typeof modelFallbackSchema>;
export const defaultModelFallback: ModelFallback = { enabled: false, providerIds: [] };

export const modelRoutingSchema = z.object({
  enabled:z.boolean(), localProviderId:z.string().uuid().nullable(), cloudProviderId:z.string().uuid().nullable(),
  fallback: modelFallbackSchema.optional(),
}).strict().refine(value => !value.enabled || !!value.localProviderId && value.localProviderId !== value.cloudProviderId);
export type ModelRouting = z.infer<typeof modelRoutingSchema>;
export const defaultModelRouting: ModelRouting = { enabled:false, localProviderId:null, cloudProviderId:null, fallback: defaultModelFallback };
const cloudKinds = new Set(['openai','openrouter','deepseek','glm','minimax']);
const loopback = (url: URL) => ['127.0.0.1','localhost','[::1]'].includes(url.hostname);

export const ollamaCloudModel = (model: string):boolean => /(?:^|[:-])cloud$/iu.test(model.trim());

export const routingDestination = (provider: ProviderConfig): 'local' | 'cloud' | 'unknown' => {
  let url: URL;
  try { url = new URL(provider.baseUrl); } catch { return 'unknown'; }
  if (!provider.enabled || url.username || url.password || !['https:', 'http:'].includes(url.protocol)) return 'unknown';
  if (cloudKinds.has(provider.kind) || !loopback(url) || (provider.kind === 'ollama' && ollamaCloudModel(provider.model))) return 'cloud';
  return provider.localExecutionConfirmed ? 'local' : 'unknown';
};

/** A local heuristic only offers a choice. It never authorizes cloud dispatch. */
export const complexRequest = (text: string): boolean =>
  [...text].length >= 700 || /深入分析|综合分析|研究报告|比较.{0,60}(优缺点|方案)|全面评估|多步骤|详细设计|deep research|in[- ]depth analysis|compare.{0,80}(tradeoffs?|alternatives?)|research report|design.{0,24}architecture/iu.test(text);
