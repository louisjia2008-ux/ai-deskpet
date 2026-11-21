import type { MinecraftAutonomyStatus } from './minecraft-dedicated';
import { z } from 'zod';
import type { MinecraftSurveyPlanStatus } from './minecraft-dedicated';

const coordinate = z.object({
  x: z.number().int().min(-30_000_000).max(30_000_000),
  y: z.number().int().min(-2048).max(2048),
  z: z.number().int().min(-30_000_000).max(30_000_000),
}).strict();

export const minecraftCompanionConfigSchema = z.object({
  host: z.string().trim().min(1).max(253).refine((value) => !/[\s/@?#]/.test(value), 'Invalid server address'),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(254),
  auth: z.enum(['offline', 'microsoft']),
  version: z.string().max(32).refine((value) => value === 'auto' || /^\d+(?:\.\d+){1,2}$/.test(value), 'Invalid Minecraft version'),
  /** The only player whose in-game chat may reach the model. Empty or absent turns in-game commands off. */
  ownerName: z.string().trim().max(16).refine((value) => value === '' || /^[A-Za-z0-9_]{1,16}$/.test(value), 'Invalid player name').optional(),
}).strict().superRefine((value, ctx) => {
  if (value.auth === 'offline' && !/^[A-Za-z0-9_]{1,16}$/.test(value.username)) {
    ctx.addIssue({ code: 'custom', path: ['username'], message: 'Offline username must contain 1–16 letters, numbers or underscores' });
  }
});

export const minecraftCompanionMaterialSchema = z.enum(['log', 'planks', 'stick', 'cobblestone']);
export const minecraftCompanionTaskSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('gatherLogs'), parameters: z.object({ count: z.number().int().min(1).max(64) }).strict() }).strict(),
  z.object({ name: z.literal('gatherMaterials'), parameters: z.object({
    chest: coordinate,
    requirements: z.array(z.object({ key: minecraftCompanionMaterialSchema, count: z.number().int().min(1).max(64) }).strict()).min(1).max(8),
  }).strict() }).strict(),
  z.object({ name: z.literal('homestead'), parameters: z.object({ anchor: coordinate.optional(), nearOwner: z.boolean().optional() }).strict() }).strict(),
  z.object({ name: z.literal('farm'), parameters: z.object({ center: coordinate.optional(), plots: z.number().int().min(1).max(16).optional(), bread: z.number().int().min(1).max(16).optional() }).strict() }).strict(),
  /** Walk to the configured owner player; `stay` keeps following and guarding them until cancelled. */
  z.object({ name: z.literal('followOwner'), parameters: z.object({ stay: z.boolean().optional() }).strict() }).strict(),
]);

export type MinecraftCompanionConfig = z.infer<typeof minecraftCompanionConfigSchema>;
/** Set by the model per task: how much the bot risks, and whether a following bot guards the owner before itself. */
export const minecraftCompanionPolicySchema = z.object({
  risk: z.enum(['cautious', 'normal', 'bold']).optional(),
  guard: z.enum(['self_first', 'owner_first']).optional(),
}).strict().refine((value) => value.risk !== undefined || value.guard !== undefined, 'Set risk, guard or both');
export type MinecraftCompanionPolicy = z.infer<typeof minecraftCompanionPolicySchema>;

export type MinecraftCompanionTaskInput = z.infer<typeof minecraftCompanionTaskSchema>;
export type MinecraftCompanionTaskStatus = 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface MinecraftCompanionTask {
  taskId: string;
  requestId: string;
  name: MinecraftCompanionTaskInput['name'];
  status: MinecraftCompanionTaskStatus;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
  connectionGeneration: number;
  /** Engine counters, never a guessed percentage or proof of world delivery. */
  progress: unknown;
  error: string | null;
}

export interface MinecraftCompanionObservation {
  at: number;
  alive: boolean;
  health: number | null;
  food: number | null;
  dimension: string | null;
  position: { x: number; y: number; z: number } | null;
  inventory: Record<string, number>;
  /** The bot's house in this world, remembered across connections; finished once built and furnished. */
  home?: { x: number; y: number; z: number; usable?: boolean; finished: boolean } | null;
}

export interface MinecraftCompanionEngine {
  autonomy?: MinecraftAutonomyStatus;
  running: string | null;
  paused: boolean;
  blocked: boolean;
  disposed: boolean;
  goal: { name: string; taskId: string | null; progress: unknown; stalls: number } | null;
}

export interface MinecraftCompanionSnapshot {
  runtimeState: 'stopped' | 'starting' | 'ready' | 'stopping' | 'error';
  connectionState: 'disconnected' | 'connecting' | 'ready' | 'error' | 'disposed';
  connectionGeneration: number;
  config: MinecraftCompanionConfig | null;
  task: MinecraftCompanionTask | null;
  observation: MinecraftCompanionObservation | null;
  engine: MinecraftCompanionEngine | null;
  safetyActive: boolean;
  plan?: MinecraftSurveyPlanStatus | null;
  controlPending: 'cancel' | 'disconnect' | null;
  events: Array<{ at: number; type: string; taskId: string | null; summary: string }>;
  auth: { userCode: string; verificationURI: string; expiresIn: number | null } | null;
  lastError: string | null;
  updatedAt: number;
}

export const initialMinecraftCompanionSnapshot = (): MinecraftCompanionSnapshot => ({
  runtimeState: 'stopped', connectionState: 'disconnected', connectionGeneration: 0,
  config: null, task: null, observation: null, engine: null, safetyActive: false,
  controlPending: null, events: [], auth: null, lastError: null, updatedAt: Date.now(),
});
