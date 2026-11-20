import { z } from 'zod';

export const MINECRAFT_OFFLINE_MODEL_LIMIT_MAX = 20;

export const minecraftAutonomyRangeSchema = z.enum(['overworld', 'nether', 'end']);
export type MinecraftAutonomyRange = z.infer<typeof minecraftAutonomyRangeSchema>;

export const minecraftAutonomyStatusSchema = z.object({
  enabled: z.boolean(),
  stage: z.number().int().min(0).max(7).nullable(),
  range: minecraftAutonomyRangeSchema,
  goal: z.string().max(120).nullable(),
  milestones: z.record(z.string().max(40), z.number().finite()),
  deaths: z.array(z.object({
    at: z.number().finite(), cause: z.string().max(160).nullable(), dimension: z.string().max(128).nullable(),
    stage: z.number().int().nullable(), card: z.string().max(120).nullable(),
  })).max(10),
  stagePauses: z.array(z.object({ stage: z.number().int(), until: z.number().finite() })).max(8),
});
export type MinecraftAutonomyStatus = z.infer<typeof minecraftAutonomyStatusSchema>;

export const minecraftDedicatedSettingsSchema = z.object({
  enabled: z.boolean(),
  memoryGb: z.number().int().min(2).max(6),
  allowPlanApproval: z.boolean(),
  autonomyRange: minecraftAutonomyRangeSchema,
  offlineModelDailyLimit: z.number().int().min(0).max(MINECRAFT_OFFLINE_MODEL_LIMIT_MAX),
}).strict();

export type MinecraftDedicatedSettings = z.infer<typeof minecraftDedicatedSettingsSchema>;

export const defaultMinecraftDedicatedSettings: MinecraftDedicatedSettings = {
  enabled: true, memoryGb: 3, allowPlanApproval: false, autonomyRange: 'end', offlineModelDailyLimit: 20,
};

export const minecraftDedicatedIdentitySchema = z.object({
  ownerName: z.string().trim().regex(/^[A-Za-z0-9_]{0,16}$/u),
  botName: z.string().trim().regex(/^[A-Za-z0-9_]{1,16}$/u),
}).strict().refine(value => value.ownerName.toLowerCase() !== value.botName.toLowerCase(), {
  path: ['ownerName'], message: 'The owner and bot must have different player names.',
});

export type MinecraftDedicatedIdentity = z.infer<typeof minecraftDedicatedIdentitySchema>;

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const blockPosition = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict();

export const minecraftSurveyPlanStatusSchema = z.object({
  planId: z.uuid(),
  revision: counter,
  template: z.string().min(1).max(80),
  status: z.enum(['draft', 'previewed', 'confirmed', 'running', 'paused', 'completed', 'failed', 'cancelled', 'expired']),
  reason: z.string().max(500).optional(),
  phase: z.string().max(80).optional(),
  waiting: z.string().max(500).optional(),
  completed: counter,
  total: counter,
  blocked: z.object({
    reason: z.string().max(500),
    pos: blockPosition.optional(),
    dimension: z.string().max(128).optional(),
    detail: z.string().max(500).optional(),
  }).strict().optional(),
  violations: counter,
  misplacements: counter,
  siteChanges: counter,
  lateAttempts: counter,
  started: z.boolean(),
  finishedAt: counter.optional(),
}).strict().refine(plan => plan.completed <= plan.total);

export type MinecraftSurveyPlanStatus = z.infer<typeof minecraftSurveyPlanStatusSchema>;

export interface MinecraftDedicatedServerSnapshot extends MinecraftDedicatedIdentity {
  settings: MinecraftDedicatedSettings;
  status: 'unpackaged' | 'eula_required' | 'stopped' | 'starting' | 'running' | 'stopping' | 'restarting' | 'gave_up' | 'error';
  error: string | null;
  port: number;
  startedAt: string | null;
  players: string[];
  worldPath: string;
  backupPath: string;
  lastBackupAt: string | null;
  eulaAcceptedAt: string | null;
  versions: { java: string | null; minecraft: string; mod: string | null; modSha256: string | null };
}

export interface MinecraftDedicatedSnapshot extends MinecraftDedicatedServerSnapshot {
  botConnected: boolean;
  autonomy?: MinecraftAutonomyStatus | null;
  botError: string | null;
  offlineModelUsed: number;
  plan: MinecraftSurveyPlanStatus | null;
}
