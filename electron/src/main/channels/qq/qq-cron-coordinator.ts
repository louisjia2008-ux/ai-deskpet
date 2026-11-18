import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChatCronBinding, ChatCronSchedule, ChatCronStore } from '../../../shared/chat-cron';
import { QQ_CHANNEL_POLICY_VERSION, qqCronOperationSchema } from '../../../shared/qq-channel';
import type { QqAuthority, QqCronOperation } from '../../../shared/qq-channel';
import { chatCronInputSchema, chatCronUpdateSchema } from '../../domain/chat-cron-schemas';
import type { ChatCronService } from '../../domain/chat-cron-service';
import { assertQqCronCapacity, assertQqCronOccurrence, normalizeQqCronInput } from '../../security/qq-cron-policy';

interface Deps {
  store: ChatCronStore; cron: ChatCronService;
  assertAuthority(authority: QqAuthority): void;
  provider(owner: ChatCronBinding): { digest: string; credentialRef: string };
  permissionRevision(capability: string): number;
  webCallLimit(): number;
  now?: () => number;
}
const selected = z.object({ scheduleId: z.string().uuid() }).strict();
export class QqCronCoordinator {
  readonly #permissionSessionId = randomUUID();
  constructor(private readonly deps: Deps) {}
  prepare(authority: QqAuthority, owner: ChatCronBinding, action: QqCronOperation['action'], raw: Record<string, unknown>): QqCronOperation {
    this.deps.assertAuthority(authority);
    const state = this.deps.store.snapshot();
    let input;
    let scheduleId: string = randomUUID(), expectedRevision: number | null = null, enabled = true;
    if (action === 'create') input = normalizeQqCronInput(chatCronInputSchema.parse(raw));
    else {
      const value = action === 'update' ? chatCronUpdateSchema.extend({ scheduleId: z.string().uuid() }).strict().parse(raw)
        : selected.extend({ allowedCapabilities: chatCronInputSchema.shape.allowedCapabilities }).parse(raw);
      const schedule = state.chatCronSchedules.find(item => item.id === value.scheduleId);
      if (!schedule || schedule.cancelledAt || schedule.channel?.bindingId !== authority.bindingId || schedule.channel.senderId !== authority.senderId
        || schedule.sessionId !== authority.sessionId) throw new Error('cron.notFound');
      owner = { sessionId: schedule.sessionId, providerId: schedule.providerId, model: schedule.model };
      const { scheduleId: _id, ...patch } = value; void _id;
      const original = { title: schedule.title, instruction: schedule.instruction, expression: schedule.expression,
        timezone: schedule.timezone, allowedCapabilities: schedule.allowedCapabilities, missedPolicy: schedule.missedPolicy };
      input = normalizeQqCronInput(chatCronInputSchema.parse({ ...original, ...patch }));
      if (action === 'resume' && JSON.stringify(input.allowedCapabilities) !== JSON.stringify([...schedule.allowedCapabilities].sort())) throw new Error('cron.scopeChanged');
      scheduleId = schedule.id; expectedRevision = schedule.revision; enabled = action === 'resume' || schedule.enabled;
    }
    const provider = this.deps.provider(owner);
    const permissionRevisions = Object.fromEntries(['chat.cron', 'task.records', ...input.allowedCapabilities].map(id => [id, this.deps.permissionRevision(id)]));
    const operation = qqCronOperationSchema.parse({ version: 1, action, authority, owner, input, scheduleId, expectedRevision, enabled,
      approval: { version: 1, authorityId: authority.authorityId, providerDigest: provider.digest, credentialRef: provider.credentialRef,
        permissionSessionId: this.#permissionSessionId, permissionRevisions, webCallLimit: this.deps.webCallLimit(),
        modelCallLimit: 4, outputTokenLimit: 2048, runtimeLimitMs: 120_000, confirmationId: randomUUID() } });
    this.assertOperation(operation); return operation;
  }
  #assertLive(operation: QqCronOperation): void {
    this.deps.assertAuthority(operation.authority);
    const { approval, owner, authority } = operation;
    const provider = this.deps.provider(owner);
    if (owner.sessionId !== authority.sessionId || approval.authorityId !== authority.authorityId
      || approval.permissionSessionId !== this.#permissionSessionId || approval.webCallLimit !== this.deps.webCallLimit()
      || provider.digest !== approval.providerDigest || provider.credentialRef !== approval.credentialRef) throw new Error('qq.cronApprovalStale');
    const expectedKeys = ['chat.cron', 'task.records', ...operation.input.allowedCapabilities].sort();
    if (JSON.stringify(Object.keys(approval.permissionRevisions).sort()) !== JSON.stringify(expectedKeys)
      || Object.entries(approval.permissionRevisions).some(([id, revision]) => this.deps.permissionRevision(id) !== revision)) throw new Error('qq.cronApprovalStale');
    const state = this.deps.store.snapshot();
    const session = state.chatSessions.find(item => item.id === owner.sessionId);
    if (!session || session.channelBindingId !== authority.bindingId || session.archivedAt || session.deletedAt) throw new Error('qq.sessionOriginMismatch');
    if (JSON.stringify(normalizeQqCronInput(operation.input)) !== JSON.stringify(operation.input)) throw new Error('qq.cronOperationInvalid');
  }
  assertOperation(raw: QqCronOperation): void {
    const operation = qqCronOperationSchema.parse(raw); this.#assertLive(operation);
    const schedules = this.deps.store.snapshot().chatCronSchedules;
    assertQqCronCapacity(schedules, operation.action === 'create');
    assertQqCronOccurrence(operation.input, this.deps.now?.() ?? Date.now());
    if (operation.action === 'create') {
      if (operation.expectedRevision !== null || schedules.some(item => item.id === operation.scheduleId)) throw new Error('cron.scopeChanged');
    } else {
      const schedule = schedules.find(item => item.id === operation.scheduleId);
      if (!schedule || schedule.cancelledAt || schedule.revision !== operation.expectedRevision
        || schedule.channel?.bindingId !== operation.authority.bindingId || schedule.channel.senderId !== operation.authority.senderId
        || schedule.sessionId !== operation.owner.sessionId || schedule.providerId !== operation.owner.providerId || schedule.model !== operation.owner.model) throw new Error('cron.scopeChanged');
    }
  }
  apply(operation: QqCronOperation): Promise<ChatCronSchedule> {
    const frozen = qqCronOperationSchema.parse(operation);
    return this.deps.cron.applyQqConfirmed(frozen, () => this.#assertLive(frozen));
  }
  assertSchedule(schedule: ChatCronSchedule): void {
    const channel = schedule.channel, approval = channel?.approval;
    if (!channel || channel.policyVersion !== QQ_CHANNEL_POLICY_VERSION || !approval || !schedule.enabled || schedule.cancelledAt) throw new Error('qq.cronApprovalStale');
    const operation = qqCronOperationSchema.parse({ version: 1, action: 'resume',
      authority: { authorityId: approval.authorityId, bindingId: channel.bindingId, senderId: channel.senderId, sessionId: schedule.sessionId },
      owner: { sessionId: schedule.sessionId, providerId: schedule.providerId, model: schedule.model }, scheduleId: schedule.id,
      expectedRevision: schedule.revision, enabled: true, input: { title: schedule.title, instruction: schedule.instruction, expression: schedule.expression,
        timezone: schedule.timezone, allowedCapabilities: schedule.allowedCapabilities, missedPolicy: schedule.missedPolicy }, approval });
    this.#assertLive(operation); assertQqCronCapacity(this.deps.store.snapshot().chatCronSchedules, false);
  }
}
