import { z } from 'zod';

const id = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
export const chatWorkPrivacySchema = z.enum(['local-only', 'cloud-allowed']);
export const chatWorkStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']);
export const chatWorkSourceSchema = z.object({
  url: z.url().max(2048).refine((value) => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } }),
  title: z.string().max(240), sha256: sha256.optional(),
}).strict();
const artifactPath = z.string().min(1).max(1024).refine((value) => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
  && !/^[a-z]:/iu.test(value) && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'));
export const chatWorkArtifactSchema = z.object({
  path: artifactPath,
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256,
  derivedFrom: z.object({ path: artifactPath, sha256, format: z.literal('pdf-export') }).strict().optional(),
}).strict();
export const chatArtifactReferenceSchema = z.object({ sessionId: id, taskId: id, path: chatWorkArtifactSchema.shape.path, sha256 }).strict();
export const chatArtifactSearchSchema = z.object({ query: z.string().trim().max(200).optional(), sessionId: id.optional(),
  offset: z.number().int().min(0).max(40_000).optional(), limit: z.number().int().min(1).max(50).optional() }).strict();
const plan = z.array(z.string().trim().min(1).max(500)).max(20);
export const chatWorkBeginSchema = z.object({ sessionId: id, runId: id, assistantMessageId: id,
  goal: z.string().trim().min(1).max(8000), privacy: chatWorkPrivacySchema }).strict();
export const chatWorkUpdateSchema = z.object({ plan: plan.optional(), notes: z.string().max(8000).optional(), nextStep: z.string().max(2000).optional() }).strict();
export const chatWorkTaskSchema = chatWorkBeginSchema.extend({
  id, status: chatWorkStatusSchema, plan, notes: z.string().max(8000), nextStep: z.string().max(2000), summary: z.string().max(8000),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), sources: z.array(chatWorkSourceSchema).max(40), artifacts: z.array(chatWorkArtifactSchema).max(40),
  evidenceTruncated: z.boolean().default(false),
  skillReferences: z.array(z.object({ id, revision: z.number().int().positive(), digest: sha256 }).strict()).max(80).optional(),
  historyLookupReferences: z.array(z.object({ sessionId: id, messageId: id, contentSHA256: sha256 }).strict()).max(256)
    .refine((references) => new Set(references.map((reference) => reference.messageId)).size === references.length).default([]),
}).strict();
export const chatWorkTasksSchema = z.array(chatWorkTaskSchema).max(1000).default([]);
export const chatWorkListSchema = z.object({
  destination: z.enum(['local', 'remote', 'unknown']).optional(), status: chatWorkStatusSchema.optional(),
  offset: z.number().int().min(0).max(10_000).optional(), limit: z.number().int().min(1).max(50).optional(),
}).strict();
export const chatHistorySearchSchema = z.object({ query: z.string().trim().min(1).max(200), targetSessionId: id.optional(),
  offset: z.number().int().min(0).max(100_000).optional(), limit: z.number().int().min(1).max(30).optional() }).strict();
export const chatHistoryReadSchema = z.object({ messageId: id,
  offset: z.number().int().min(0).max(2_000_000).optional(), maxCharacters: z.number().int().min(256).max(8000).optional() }).strict();
