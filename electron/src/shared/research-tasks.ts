import { z } from 'zod';

const id = z.string().uuid();
const timestamp = z.iso.datetime();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const researchTaskInputSchema = z.object({
  operationId: id,
  goal: z.string().trim().min(1).max(8_000),
  material: z.string().max(64_000),
  providerId: id,
  model: z.string().trim().min(1).max(240).nullable().default(null),
  allowRemote: z.boolean(),
  maxMinutes: z.number().int().min(2).max(30).default(10),
  maxToolCalls: z.number().int().min(4).max(40).default(20),
}).strict();
export type ResearchTaskInput = z.infer<typeof researchTaskInputSchema>;
/** What the form submits: with remote consent it names the exact service address that consent covers. */
export const researchTaskSubmitSchema = researchTaskInputSchema.extend({ expectedBaseUrl: z.string().url().max(2048).optional() }).strict();
export type ResearchTaskSubmit = ResearchTaskInput & { expectedBaseUrl?: string };

export const researchTaskResumeSchema = z.object({ id, operationId: id }).strict();
export const RESEARCH_TASK_STATUSES = ['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled', 'partial'] as const;
export type ResearchTaskStatus = typeof RESEARCH_TASK_STATUSES[number];
export const researchBindingSchema = z.object({ fingerprint: digest, destination: z.enum(['local', 'remote']) }).strict();
export type ResearchBinding = z.infer<typeof researchBindingSchema>;
export const researchArtifactSchema = z.object({ path: z.string().min(1).max(1024), bytes: z.number().int().positive(), sha256: digest }).strict();
export const researchSourceSchema = z.object({
  url: z.string().max(4096).refine(value => {
    try { const target = new URL(value); return ['http:', 'https:'].includes(target.protocol) && !target.username && !target.password; }
    catch { return false; }
  }),
  title: z.string().max(500),
}).strict();
export type ResearchArtifact = z.infer<typeof researchArtifactSchema>;
export type ResearchSource = z.infer<typeof researchSourceSchema>;

export const researchAttemptSchema = z.object({
  id, runId: id, operationId: id,
  status: z.enum(['running', 'completed', 'failed', 'interrupted', 'cancelled', 'partial']),
  startedAt: timestamp, deadlineAt: timestamp, finishedAt: timestamp.nullable(),
  summary: z.string().max(16_000), errorCode: z.string().max(120).nullable(),
  messageId: id.nullable(), artifacts: z.array(researchArtifactSchema).max(100), sources: z.array(researchSourceSchema).max(100),
}).strict();

export const researchTaskSchema = z.object({
  id, profileId: id, operationId: id, specDigest: digest,
  input: researchTaskInputSchema, binding: researchBindingSchema,
  sessionId: id.nullable(), reportPath: z.string().max(1024),
  status: z.enum(RESEARCH_TASK_STATUSES),
  pendingOperationId: id, currentAttemptId: id.nullable(), queueSequence: z.number().int().positive(),
  resumeOperationIds: z.array(id).max(29).default([]),
  createdAt: timestamp, updatedAt: timestamp, cancelRequestedAt: timestamp.nullable(),
  summary: z.string().max(16_000), errorCode: z.string().max(120).nullable(),
  artifacts: z.array(researchArtifactSchema).max(100), sources: z.array(researchSourceSchema).max(100),
  attempts: z.array(researchAttemptSchema).max(30),
}).strict().refine(task => task.reportPath === `research/${task.id}/report.md`);
export type ResearchTask = z.infer<typeof researchTaskSchema>;

export const researchExecutionResultSchema = z.object({
  status: z.enum(['completed', 'partial', 'failed']), summary: z.string().max(16_000),
  artifacts: z.array(researchArtifactSchema).max(100), sources: z.array(researchSourceSchema).max(100).optional(),
  messageId: id.optional(), errorCode: z.string().max(120).optional(),
}).strict();
export type ResearchExecutionResult = z.infer<typeof researchExecutionResultSchema>;

export interface ResearchTasksApi {
  list(): Promise<ResearchTask[]>;
  get(id: string): Promise<ResearchTask>;
  submit(input: ResearchTaskSubmit): Promise<ResearchTask>;
  cancel(id: string): Promise<ResearchTask>;
  resume(input: { id: string; operationId: string }): Promise<ResearchTask>;
  openResult(id: string): Promise<void>;
  onChanged(listener: () => void): () => void;
}

/** A relative artifact belongs to exactly this task; traversal and alternative
 * separators never gain access to another task or arbitrary workspace data. */
export const isResearchArtifactPath = (taskId: string, path: string): boolean => path.startsWith(`research/${taskId}/`)
  && !path.includes('\\') && !path.includes('\0') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
