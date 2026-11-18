import { z } from 'zod';

export const recommendedSkillIds = ['bilingual-writing', 'evidence-review', 'ib-economics', 'project-review'] as const;
export const recommendedServerIds = ['deepwiki', 'microsoft-learn', 'playwright', 'github'] as const;
export type RecommendedSkillId = typeof recommendedSkillIds[number];
export type RecommendedServerId = typeof recommendedServerIds[number];

export const skillSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(160), text: z.string().min(1).max(32_000), enabled: z.boolean(),
  // Optional provenance preserves older installed snapshots. Local paths never enter the model catalog.
  description: z.string().max(1200).optional(), sourceDirectory: z.string().min(1).max(4096).optional(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u).optional(), revision: z.number().int().positive().optional(),
  installedAt: z.iso.datetime().optional(), updatedAt: z.iso.datetime().optional(),
  catalogId: z.enum(recommendedSkillIds).optional(),
  // A desktop owner's approval applies to this exact revision. Imported and
  // changed skills remain private until the owner reviews them again.
  exposure: z.enum(['local-only', 'public']).optional(),
  userMethod: z.boolean().optional(), sourceTaskId: z.string().uuid().optional(),
}).strict();
export const mcpEndpoint = (raw: string): string => {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || /[{}$\\]/u.test(raw)) throw new Error('extensions.endpoint');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (loopback && url.protocol === 'http:' && url.port) {
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  } else if (url.protocol !== 'https:' || url.port || !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/iu.test(url.hostname)
    || /(?:^|\.)(?:local|internal|localhost|home|lan)$/iu.test(url.hostname)) throw new Error('extensions.endpoint');
  return url.toString();
};
export const mcpEndpointSchema = z.string().max(2048).refine(raw => { try { mcpEndpoint(raw); return true; } catch { return false; } });
const boundedJson = (limit: number) => (value: unknown): boolean => { try { return JSON.stringify(value).length <= limit; } catch { return false; } };
/** One tool the owner reviewed for desktop chat, pinned to the exact definition it saw. */
const chatToolGrantSchema = z.object({ name: z.string().min(1).max(128), digest: z.string().regex(/^[a-f0-9]{64}$/u), description: z.string().max(2000),
  inputSchema: z.object({ type: z.literal('object') }).passthrough().refine(boundedJson(16_000)) }).strict();
/** `private` results make the task and conversation local-only, like a workspace read. */
const chatAccessSchema = z.object({ results: z.enum(['private', 'public']), tools: z.array(chatToolGrantSchema).min(1).max(16) }).strict();
const mcpServerSchema = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(100), endpoint: mcpEndpointSchema, bridgeDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(), enabled: z.boolean(), revision: z.number().int().positive(), preset: z.enum(recommendedServerIds).optional(), chatAccess: chatAccessSchema.optional() }).strict();
export const desktopExtensionsSchema = z.object({ skills: z.array(skillSchema).max(80), servers: z.array(mcpServerSchema).max(32) }).strict();
export type InstalledSkill = z.infer<typeof skillSchema>;
export type McpServer = z.infer<typeof mcpServerSchema>;
/** The readable part of a granted tool's chat ID. */
export const chatToolIdName = (name: string): string => name.replace(/[^A-Za-z0-9_-]/gu, '_');
export type ChatToolGrant = z.infer<typeof chatToolGrantSchema>;
export type ChatAccess = z.infer<typeof chatAccessSchema>;
export type McpServerView = Omit<McpServer,'bridgeDigest'|'chatAccess'> & {privateBridge?:true;authConfigured?:boolean;chatAccess?:{results:ChatAccess['results'];tools:Array<Pick<ChatToolGrant,'name'|'digest'>>}};
export interface DesktopExtensionsState { skills: Omit<InstalledSkill, 'text'>[]; servers: McpServerView[] }
export interface RecommendedExtension {
  id: RecommendedSkillId | RecommendedServerId; name: string; description: string; installed: boolean;
}
export interface RecommendedExtensionsCatalog { skills: RecommendedExtension[]; servers: RecommendedExtension[] }
export const recommendedInstallSchema = z.object({ skills: z.array(z.enum(recommendedSkillIds)).max(4).default([]), servers: z.array(z.enum(recommendedServerIds)).max(4).default([]), enabled: z.boolean().default(false) }).strict();
export type RecommendedInstall = z.infer<typeof recommendedInstallSchema>;
export interface SkillCatalogEntry { id: string; name: string; description: string; revision: number; digest: string; exposure?: 'local-only' | 'public' }
export interface SkillReference extends SkillCatalogEntry { text: string }
export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; digest: string }
export interface ManifestPreview { id: string; servers: Array<{ name: string; endpoint: string; privateBridge?:true }>; skipped: number; duplicates: number }
export interface ToolQuestionAnswer {result:McpResult;answer:string|null}
export interface McpResult { isError: boolean; text: string }
export const extensionInputs = {
  'extensions:preview-bridge': z.object({}).strict(),
  'extensions:preview-manifest': z.object({}).strict(),
  'extensions:inspect-preview': z.object({ previewId: z.string().uuid(), index: z.number().int().min(0).max(31) }).strict(),
  'extensions:import-manifest': z.object({ previewId: z.string().uuid() }).strict(),
  'extensions:state': z.object({}).strict(), 'extensions:install-skill': z.object({}).strict(),
  'extensions:catalog': z.object({}).strict(),
  'extensions:install-recommended': recommendedInstallSchema,
  'extensions:configure-token': z.object({ id:z.string().uuid(), token:z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/u).nullable() }).strict(),
  'extensions:read-skill': z.object({ id: z.string().uuid() }).strict(),
  'extensions:update-skill': z.object({ id: z.string().uuid() }).strict(),
  'extensions:set-skill-exposure': z.object({ id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/u), revision: z.number().int().positive(), exposure: z.enum(['local-only', 'public']) }).strict(),
  'extensions:save-method': z.object({ id: z.string().uuid().optional(), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(), expectedRevision: z.number().int().positive().optional(), name: z.string().trim().min(1).max(160), text: z.string().trim().min(1).max(32_000), sourceTaskId: z.string().uuid().optional() }).strict(),
  'extensions:toggle': z.object({ kind: z.enum(['skill','server']), id: z.string().uuid(), enabled: z.boolean() }).strict(),
  'extensions:remove': z.object({ kind: z.enum(['skill','server']), id: z.string().uuid() }).strict(),
  'extensions:run-skill': z.object({ id: z.string().uuid(), operationId: z.string().uuid(), providerId: z.string().uuid(), model: z.string().trim().min(1).max(240), task: z.string().trim().min(1).max(8000) }).strict(),
  'extensions:add-server': z.object({ name: z.string().trim().min(1).max(100), endpoint: mcpEndpointSchema }).strict(),
  'extensions:list-tools': z.object({ id: z.string().uuid() }).strict(),
  'extensions:set-chat-tools': z.object({ id: z.string().uuid(), results: z.enum(['private', 'public']), tools: z.array(z.object({ name: z.string().min(1).max(128), digest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()).max(16) }).strict(),
  'extensions:ask-tool': z.object({ operationId:z.string().uuid(), id:z.string().uuid(), name:z.string().min(1).max(128), digest:z.string().regex(/^[a-f0-9]{64}$/u),
    providerId:z.string().uuid(), model:z.string().min(1).max(240), question:z.string().trim().min(1).max(8000) }).strict(),
  'extensions:cancel-question': z.object({ operationId:z.string().uuid() }).strict(),
  'extensions:call-tool': z.object({ id: z.string().uuid(), name: z.string().min(1).max(128), digest: z.string().regex(/^[a-f0-9]{64}$/u), arguments: z.record(z.string(), z.unknown()) }).strict(),
};
export interface DesktopExtensionsAPI {
  state(): Promise<DesktopExtensionsState>;
  catalog?(): Promise<RecommendedExtensionsCatalog>;
  installRecommended?(input:RecommendedInstall):Promise<DesktopExtensionsState>;
  configureToken(id:string, token:string|null):Promise<DesktopExtensionsState>;
  previewBridge(): Promise<ManifestPreview | null>;
  previewManifest(): Promise<ManifestPreview | null>;
  inspectPreview(previewId: string, index: number): Promise<McpTool[]>;
  importManifest(previewId: string): Promise<DesktopExtensionsState>;
  installSkill(): Promise<DesktopExtensionsState>;
  updateSkill(id: string): Promise<DesktopExtensionsState>;
  setSkillExposure?(input: z.infer<typeof extensionInputs['extensions:set-skill-exposure']>): Promise<DesktopExtensionsState>;
  saveMethod?(input: z.infer<typeof extensionInputs['extensions:save-method']>): Promise<DesktopExtensionsState>;
  readSkill(id: string): Promise<string>;
  toggle(kind: 'skill' | 'server', id: string, enabled: boolean): Promise<DesktopExtensionsState>;
  remove(kind: 'skill' | 'server', id: string): Promise<DesktopExtensionsState>;
  runSkill(input: z.infer<typeof extensionInputs['extensions:run-skill']>): Promise<{ jobId: string }>;
  addServer(name: string, endpoint: string): Promise<DesktopExtensionsState>;
  listTools(id: string): Promise<McpTool[]>;
  setChatTools?(input: z.infer<typeof extensionInputs['extensions:set-chat-tools']>): Promise<DesktopExtensionsState>;
  askTool(input:z.infer<typeof extensionInputs['extensions:ask-tool']>):Promise<ToolQuestionAnswer>;
  cancelQuestion(operationId:string):Promise<void>;
  callTool(input: z.infer<typeof extensionInputs['extensions:call-tool']>): Promise<McpResult>;
}
