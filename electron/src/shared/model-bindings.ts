import { z } from 'zod';

export type ModelBindingFeature = 'schedule' | 'chat-cron' | 'qq' | 'telegram' | 'research' | 'wechat' | 'chat' | 'subagent' | 'proactive';

export const modelBindingIdSchema = z.string().min(1).max(256);
export const modelChangeConsentSchema = z.object({
  previousModel: z.string().min(1).max(240),
  followIds: z.array(modelBindingIdSchema).max(10000),
}).strict();
export type ModelChangeConsent = z.infer<typeof modelChangeConsentSchema>;

export interface ModelBindingDisplay {
  id: string;
  feature: ModelBindingFeature;
  label: string;
}

export interface DefaultModelImpact {
  previousModel: string;
  followers: number;
  pinned: ModelBindingDisplay[];
}

export interface DefaultModelChange {
  followers: number;
  failed: number;
}

export const modelBindingSelectionSchema = z.object({
  id: modelBindingIdSchema,
  providerId: z.string().uuid(),
  model: z.string().min(1).max(240),
}).strict();
export const modelBindingFailureSchema = modelBindingSelectionSchema.extend({
  at: z.iso.datetime(),
}).strict();
export type ModelBindingFailure = z.infer<typeof modelBindingFailureSchema>;

/** Names are resolved on demand for the local console. */
export interface ModelBindingIssue extends ModelBindingDisplay, Omit<ModelBindingFailure, 'id'> {
  code: 'provider.pinnedModelUnavailable' | 'provider.modelUnavailable';
  providerName: string;
  followModel: string | null;
}
