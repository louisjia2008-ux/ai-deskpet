import { z } from 'zod';
import type { ChatCronBinding, ChatCronInput, ChatCronUpdate } from '../../shared/chat-cron';
import type { ChatCronService } from '../domain/chat-cron-service';
import { chatCronCapabilitiesSchema, chatCronInputSchema, chatCronUpdateSchema } from '../domain/chat-cron-schemas';
import type { ToolContext, ToolRegistry } from '../runtime/tool-registry';

interface Dependencies {
  service: ChatCronService;
  context(runId: string): ChatCronBinding | null;
  /** When present, QQ-originated cron mutations become host confirmation
   * drafts instead of executing immediately. The model never sees the code. */
  qqConfirmation?: {
    required(runId: string): boolean;
    createDraft(runId: string, action: 'create' | 'update' | 'resume', input: Record<string, unknown>): Promise<{ pending: true; expiresAt: string }>;
  };
}
const selected = z.object({ scheduleId: z.string().uuid() }).strict();
export const registerChatCronTools = (registry: ToolRegistry, dependencies: Dependencies): void => {
  const binding = (context: ToolContext): ChatCronBinding => {
    context.signal.throwIfAborted();
    const value = dependencies.context(context.runId);
    if (!value) throw new Error('cron.chatContextRequired');
    return { sessionId: value.sessionId, providerId: value.providerId, model: value.model };
  };
  const authorize = (context: ToolContext, owner: ChatCronBinding, additionalCheck?: () => void) => () => {
    context.signal.throwIfAborted();
    if (!context.assertAuthorized) throw new Error('cron.authorizationRequired');
    context.assertAuthorized();
    const current = dependencies.context(context.runId);
    if (!current || current.sessionId !== owner.sessionId || current.providerId !== owner.providerId || current.model !== owner.model) throw new Error('cron.chatContextRequired');
    additionalCheck?.();
  };
  const mutation = (id: string, title: string, inputSchema: z.ZodType<unknown>, execute: (input: unknown, context: ToolContext) => Promise<unknown>): void => {
    registry.register({ id, title, capabilityId: 'chat.cron', risk: 'high', sideEffect: true, inputSchema,
      description: 'Requires explicit chat approval. Runs only while DeskPet is open, in this original conversation with its captured provider/model. No private reads, recursive cron, system cron or daemon. Review allowedCapabilities as persistent scope.',
      execute });
  };
  mutation('cron.create', 'Create recurring chat task', chatCronInputSchema, async (input, context) => {
    const owner = binding(context);
    if (dependencies.qqConfirmation?.required(context.runId)) {
      authorize(context, owner)();
      return dependencies.qqConfirmation.createDraft(context.runId, 'create', input as Record<string, unknown>);
    }
    return dependencies.service.create(owner, input as ChatCronInput, authorize(context, owner), `${context.runId}:${context.taskId}`);
  });
  mutation('cron.update', 'Update recurring chat task', chatCronUpdateSchema.extend({ scheduleId: z.string().uuid() }).strict(), async (input, context) => {
    const { scheduleId, ...patch } = input as ChatCronUpdate & { scheduleId: string };
    const owner = binding(context);
    if (dependencies.qqConfirmation?.required(context.runId)) {
      authorize(context, owner)();
      return dependencies.qqConfirmation.createDraft(context.runId, 'update', input as Record<string, unknown>);
    }
    return dependencies.service.update(owner.sessionId, scheduleId, patch, authorize(context, owner));
  });
  for (const action of ['pause', 'cancel'] as const) mutation(`cron.${action}`, `${action === 'pause' ? 'Pause' : 'Cancel'} recurring chat task`, selected, async (input, context) => {
    const owner = binding(context);
    return dependencies.service[action](owner.sessionId, (input as { scheduleId: string }).scheduleId, authorize(context, owner));
  });
  mutation('cron.resume', 'Resume recurring chat task', selected.extend({ allowedCapabilities: chatCronCapabilitiesSchema }).strict(), async (input, context) => {
    const value = input as { scheduleId: string; allowedCapabilities: string[] }, owner = binding(context);
    if (dependencies.qqConfirmation?.required(context.runId)) {
      authorize(context, owner)();
      return dependencies.qqConfirmation.createDraft(context.runId, 'resume', input as Record<string, unknown>);
    }
    const assertScope = () => {
      const schedule = dependencies.service.list(owner.sessionId).find((item) => item.id === value.scheduleId);
      if (!schedule || JSON.stringify([...schedule.allowedCapabilities].sort()) !== JSON.stringify([...value.allowedCapabilities].sort())) throw new Error('cron.scopeChanged');
    };
    return dependencies.service.resume(owner.sessionId, value.scheduleId, authorize(context, owner, assertScope));
  });
  registry.register({ id: 'cron.list', title: 'List recurring tasks in this chat', capabilityId: 'task.records', risk: 'low', sideEffect: false,
    inputSchema: z.object({ offset: z.number().int().min(0).max(200).optional(), limit: z.number().int().min(1).max(20).optional() }).strict(),
    execute: async (input, context) => {
      const { offset = 0, limit = 10 } = input as { offset?: number; limit?: number }, all = dependencies.service.list(binding(context).sessionId);
      const schedules = all.slice(offset, offset + limit).map((schedule) => ({ ...schedule, instruction: schedule.instruction.slice(0, 500), instructionTruncated: schedule.instruction.length > 500 }));
      return { schedules, total: all.length, nextOffset: offset + schedules.length < all.length ? offset + schedules.length : null };
    } });
  registry.register({ id: 'cron.history', title: 'Read recurring task history in this chat', capabilityId: 'task.records', risk: 'low', sideEffect: false,
    inputSchema: z.object({ scheduleId: z.string().uuid().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    execute: async (input, context) => {
      const value = input as { scheduleId?: string; limit?: number }, runs = dependencies.service.history(binding(context).sessionId, value.scheduleId), limit = value.limit ?? 20;
      return { runs: runs.slice(0, limit), total: runs.length, truncated: runs.length > limit };
    } });
};
