import { cleanReplyText } from '../../../shared/qq-sticker-reply';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import type { QqChannelStore } from './qq-channel-store';
import { QqPrivateCare } from './qq-private-care';
import type { QqCarePolicy } from './qq-private-care';
import type { QqAdapterEvents, QqInboundMessage, QqSendResult } from './qq-official-adapter';
import type { QqAuthority, QqChannelConfig, QqChannelState, QqChannelStatus, QqCronOperation, QqOutboxItem, QqTransportKind, QqReplyImage, QqInboundQueueItem } from '../../../shared/qq-channel';
import { defaultQqChannelState, qqCronOperationSchema, qqGroupIdFromSender, qqGroupSender, qqReplyImageSchema, QQ_GROUP_DAILY_LIMIT, QQ_MAX_GROUPS, QQ_MAX_MESSAGE_CHARACTERS, QQ_PAIRING_COMMAND, QQ_MAX_QUEUED_MESSAGES, QQ_MAX_INBOUND_RECORDS } from '../../../shared/qq-channel';
import type { QqGatewayEvent, QqPairingIssue } from '../../../shared/qq-channel';
import { qqCronConfirmationText, qqCronDigest } from '../../security/qq-cron-policy';
import { qqDeliveryText } from './qq-delivery-text';
import { privateCronText } from '../../domain/chat-cron-run';
import { qqRunFailureText } from './qq-run-failure';
import { applyQqReminder, parseQqReminder, qqReminderDeliveryText, REMINDER_GRACE_MS } from './qq-reminders';
import { parseChatCommand } from '../../domain/chat-commands';
import type { ChatCommand, ChatCommandTarget } from '../../domain/chat-commands';

export interface QqTransportCredentials { transport: QqTransportKind; appId: string; onebotUrl: string; secret: string }
/** Narrow transport contract: no policy authority, including in test fakes. */
export interface QqTransport {
  readonly lastError: string | null;
  readonly gatewayEvents?: QqGatewayEvent[];
  start(credentials: QqTransportCredentials, events: QqAdapterEvents): Promise<void>;
  stop(): void;
  sendToUser(openId: string, content: string, replyTo?: string, controls?: QqSendControls): Promise<QqSendResult>;
  sendToGroup(groupId: string, content: string, replyTo?: string, controls?: QqSendControls): Promise<QqSendResult>;
  sendImageToUser?(openId: string, image: QqResolvedReplyImage, replyTo?: string, controls?: QqSendControls): Promise<QqSendResult>;
  sendImageToGroup?(groupId: string, image: QqResolvedReplyImage, replyTo?: string, controls?: QqSendControls): Promise<QqSendResult>;
}
export interface QqResolvedReplyImage { base64: string; mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; sha256: string }
export interface QqSendControls {
  signal: AbortSignal;
  assertCurrent(): void;
  singleBubble?: boolean;
  /** A queued image shares this official text reply's passive message limit. */
  reserveImageReply?: boolean;
}
export interface QqHostSurface {
  privateCarePolicy?(): QqCarePolicy | null;
  createBindingSession(bindingId: string, groupId?: string): Promise<{ sessionId: string }>;
  migrateGroupTitles?(groups: ReadonlyArray<{ id: string; sessionId: string; groupId: string }>): Promise<void>;
  runMessage(input: QqAuthority & { text: string; providerId: string | null; model: string | null }): Promise<
    { ok: true; reply: string; runId: string; assistantMessageId: string; attachments?: QqReplyImage[]; stickerOnly?: true }
    | { ok: false; code: string }>;
  resolveReplyImage?(assetId: string, authority: QqAuthority): Promise<QqResolvedReplyImage>;
  /** Synchronous, repeated immediately before the transport POST. */
  assertDelivery(item: QqOutboxItem): void;
  /** Must synchronously cancel runs before awaiting persistent schedule pauses. */
  onStopped(): Promise<void>;
  assertCronOperation?(operation: QqCronOperation): void;
  applyConfirmedCron?(operation: QqCronOperation): Promise<{ id: string; title: string; enabled: boolean }>;
  /** Owner commands such as /model, answered by the host without a model run. */
  chatCommand?(command: ChatCommand, target: ChatCommandTarget): Promise<string>;
  /** The doctor's answer to 「体检」: status codes and counts only. */
  checkup?(): Promise<string>;
}
export interface QqChannelServiceDeps {
  store: QqChannelStore;
  adapter: QqTransport;
  getSecret(): Promise<string | null>;
  profileId(): string;
  host: QqHostSurface;
  now?: () => Date;
  onChanged?(): void;
}

const sameAuthority = (left: QqAuthority, right: QqAuthority): boolean =>
  left.authorityId === right.authorityId && left.bindingId === right.bindingId
  && left.senderId === right.senderId && left.sessionId === right.sessionId;

const hasConfirmedTextReply = (image: QqOutboxItem, text: QqOutboxItem | undefined): boolean =>
  text?.kind === image.kind && ['reply', 'cron'].includes(text.kind) && !text.attachment && text.status === 'sent' && sameAuthority(image.authority, text.authority)
  && text.runId === image.runId && text.assistantMessageId === image.assistantMessageId
  && text.scheduleId === image.scheduleId && text.scheduleRevision === image.scheduleRevision
  && text.replyTo === image.replyTo && (text.sourceSHA256 ?? createHash('sha256').update(text.content).digest('hex')) === image.sourceSHA256;

const hasPrivateOfficialInbound = (state: QqChannelState, authority: QqAuthority, replyTo: string | null | undefined): boolean =>
  state.config.transport === 'official' && qqGroupIdFromSender(authority.senderId) === null
  && !!replyTo && state.processedMessageIds.includes(replyTo);

const endpoint = (state: QqChannelState): string => state.config.transport === 'onebot' ? state.config.onebotUrl : state.config.appId;
const WEB_BUDGET_REPLY_TIMEOUT_MS = 5 * 60_000;

interface ActivePrivateRun {
  authority: QqAuthority;
  generation: number;
  replyTo: string;
  runId: string | null;
  executing: boolean;
}

interface WebBudgetWaiter {
  active: ActivePrivateRun;
  runId: string;
  noticeId: string;
  expiresAt: number;
  signal: AbortSignal;
  delivery: AbortController;
  onAbort(): void;
  resolve(approved: boolean): void;
  timer?: ReturnType<typeof setTimeout>;
}

export class QqChannelService {
  #pairingIssue: QqPairingIssue | null = null;
  #groupPairingIssue: QqPairingIssue | null = null;
  readonly #store: QqChannelStore;
  readonly #privateCare: QqPrivateCare;
  #privateCareResult: { bindingId: string; result: NonNullable<QqChannelStatus['privateCareResult']> } | null = null;
  readonly #adapter: QqTransport;
  readonly #deps: QqChannelServiceDeps;
  readonly #now: () => Date;
  #connection: QqChannelStatus['connection'] = 'disabled';
  #management: Promise<unknown> = Promise.resolve();
  #managementPending = 0;
  #inbox: Promise<unknown> = Promise.resolve();
  #flushPromise: Promise<void> | null = null;
  #flushRequested = false;
  #generation = 0;
  #revoked = true;
  #controller = new AbortController();
  #secretConfigured = false;
  #busy = false;
  #queueWork: { generation: number; promise: Promise<void> } | null = null;
  #privateImageTestActive = false;
  #activePrivateRun: ActivePrivateRun | null = null;
  #webBudgetWaiter: WebBudgetWaiter | null = null;
  #remindersBlocked = false;
  #reminderPolicyEpoch = 0;
  #reminderController = new AbortController();

  constructor(deps: QqChannelServiceDeps) {
    this.#deps = deps; this.#store = deps.store; this.#adapter = deps.adapter;
    this.#now = deps.now ?? (() => new Date());
    this.#privateCare = new QqPrivateCare({ store: deps.store, now: this.#now,
      policy: () => deps.host.privateCarePolicy?.() ?? null, authority: () => this.authority(),
      online: () => this.#connection === 'online' && !this.#revoked, flush: () => this.#flush() });
  }

  async initialize({ deferConnection = false } = {}): Promise<void> {
    await this.#store.initialize();
    await this.#store.update(draft => {
      if (draft.profileId !== this.#deps.profileId()) {
        Object.assign(draft, defaultQqChannelState(), { profileId: this.#deps.profileId() });
      }
      // Never resume a pending confirmation or an uncertain in-flight POST.
      draft.confirmations = []; draft.pairingCandidate = null;
      draft.config.pairingCode = null; draft.config.pairingExpiresAt = null;
      draft.groupCandidate = null; draft.groupPairing = null;
      for (const item of draft.outbox) if (item.webBudgetRunId && ['pending', 'sending', 'failed'].includes(item.status)) {
        item.status = 'discarded'; item.errorCode = 'qq.webBudgetExpired';
      }
      for (const item of draft.outbox) if (item.kind === 'care' && ['pending', 'failed'].includes(item.status)) {
        item.status = 'discarded'; item.errorCode = 'qq.careExpired';
      }
      for (const item of draft.outbox) if (item.status === 'sending') {
        item.status = 'unknown'; item.errorCode = 'qq.sendUnknown';
      }
      for (const item of draft.inboundQueue) if (item.status === 'running') {
        this.#finishInbound(item, 'interrupted');
        if (draft.binding && item.authority.authorityId === draft.authorityId
          && item.authority.bindingId === draft.binding.id && draft.config.enabled && !draft.stopped) {
          try {
            this.#queueNotice(draft, item.authority, item.messageId,
              '上次任务在执行时中断，结果尚未确认，未自动重试。尚未开始的排队任务会继续处理；可用 /queue 查看、/cancel-queue 取消。');
          } catch { draft.lastError = 'qq.outboxFull'; }
        }
      }
    });
    const legacyGroups = this.#store.snapshot().groups.filter(group => !group.titleMigrated);
    if (legacyGroups.length && this.#deps.host.migrateGroupTitles) {
      await this.#deps.host.migrateGroupTitles(legacyGroups);
      await this.#store.update(draft => {
        for (const group of draft.groups) if (legacyGroups.some(legacy => legacy.id === group.id)) group.titleMigrated = true;
      });
    }
    if (!deferConnection) await this.startConnection();
  }

  async startConnection(): Promise<void> {
    this.#revoked = false;
    await this.#syncConnection(this.#generation);
    void this.#drainPrivateQueue().catch(() => undefined);
  }

  async followModel(expected: { providerId: string; model: string }, preserveQueued: boolean): Promise<boolean> {
    const changed = await this.#store.update(draft => {
      if (draft.config.providerId !== expected.providerId || draft.config.model !== expected.model) return false;
      draft.config.model = null;
      if (preserveQueued) {
        for (const item of draft.inboundQueue) {
          if ((item.status === 'queued' || item.status === 'paused') && item.providerId === expected.providerId && item.model === expected.model) item.model = null;
        }
      }
      return true;
    });
    if (changed) this.#changed();
    return changed;
  }

  status(): QqChannelStatus {
    const state = this.#store.snapshot();
    const privatePush = state.outbox.filter(item => item.authority.authorityId === state.authorityId
      && item.authority.bindingId === state.binding?.id && (item.kind !== 'reply' && item.kind !== 'system' || !!item.reminderDueAt)
      && item.lastAttemptAt !== null).sort((a,b) => b.lastAttemptAt!.localeCompare(a.lastAttemptAt!))[0];
    return {
      privateBindingId: state.binding?.id ?? null,
      privateCareEnabled: state.binding?.privateCareGrant?.authorityId === state.authorityId,
      ...(this.#privateCareResult?.bindingId === state.binding?.id && this.#privateCareResult ? {privateCareResult:this.#privateCareResult.result} : {}),
      enabled: state.config.enabled, stopped: state.stopped || this.#revoked,
      connection: !this.#revoked && state.config.enabled && !state.stopped ? this.#connection : 'disabled',
      transport: state.config.transport,
      appIdConfigured: endpoint(state).length > 0, secretConfigured: this.#secretConfigured,
      appId: state.config.appId, onebotUrl: state.config.onebotUrl,
      bound: state.binding !== null, bindingDisplayName: state.binding?.displayName ?? null,
      privateRemindersEnabled: !this.#remindersBlocked && state.binding?.remindersAuthorityId === state.authorityId,
      pairingCandidate: state.pairingCandidate,
      pairingIssue: state.binding ? null : this.#pairingIssue,
      groupPairingIssue: state.groupPairing ? this.#groupPairingIssue : null,
      gatewayEvents: this.#adapter.gatewayEvents ?? [],
      groups: state.groups.map(group => ({ id: group.id, groupId: group.groupId, openToMembers: group.openToMembers })),
      groupCandidate: state.groupCandidate && { id: state.groupCandidate.id, groupId: state.groupCandidate.groupId, expiresAt: state.groupCandidate.expiresAt },
      groupRequests: state.groupUsage.date === this.#today() ? state.groupUsage.requests : 0,
      groupDailyLimit: QQ_GROUP_DAILY_LIMIT,
      providerId: state.config.providerId, model: state.config.model,
      dailyRequests: state.dailyUsage.date === this.#today() ? state.dailyUsage.requests : 0,
      dailyRequestLimit: state.config.dailyRequestLimit, webCallLimit: state.config.webCallLimit,
      pendingOutbox: state.outbox.filter(item => item.status === 'pending' || item.status === 'sending').length,
      failedOutbox: state.outbox.filter(item => item.status === 'failed').length,
      uncertainOutbox: state.outbox.filter(item => item.status === 'unknown').length,
      lastPrivatePush: privatePush ? { status: privatePush.status, at: privatePush.lastAttemptAt!,
        errorCode: privatePush.errorCode && /^(?:qq\.send(?:Http|Retcode|Code)_\d{1,10}|qq\.(?:sendBlocked|sendFailed|sendUnknown|sendPartial|unconfirmedReceipt|proactivePermission|recipientDeclined|proactiveRateLimit|friendRequired|replyLimit|replyExpired))$/u.test(privatePush.errorCode)
          ? privatePush.errorCode : null } : null,
      lastError: state.lastError ?? this.#adapter.lastError,
    };
  }

  #changed(): void { this.#deps.onChanged?.(); }
  async setPrivateCare(bindingId: string, enabled: boolean): Promise<QqChannelStatus> {
    await this.#privateCare.setEnabled(bindingId, enabled); this.#privateCareResult = null; this.#changed(); return this.status();
  }
  async offerPrivateCare(): Promise<void> { await this.#privateCare.offer(); }
  async sendPrivateCareNow(bindingId: string): Promise<QqChannelStatus> {
    let result: NonNullable<QqChannelStatus['privateCareResult']> = 'sent';
    try { await this.#privateCare.offer(bindingId); }
    catch (error) {
      const codes = { 'qq.careUnavailable':'setup','qq.careQuiet':'quiet','qq.careFrequency':'frequency',
        'qq.careOffline':'offline','qq.careUnknown':'unknown','qq.careNotDelivered':'failed' } as const;
      const code = error instanceof Error ? error.message : '';
      if (!Object.hasOwn(codes,code)) throw error;
      result = codes[code as keyof typeof codes];
    }
    this.#privateCareResult = { bindingId, result }; this.#changed(); return this.status();
  }

  /** The doctor's report to the bound owner, outside chat history and usage. True only when QQ confirmed it;
   * an undelivered report is discarded rather than sent late, when it may no longer be true. */
  async notifyOwner(content: string): Promise<boolean> {
    const state = this.#store.snapshot();
    if (!state.config.enabled || state.stopped || !state.binding || this.#connection !== 'online' || this.#revoked) return false;
    const id = randomUUID();
    await this.#enqueue(this.authority(), { kind: 'system', content, id });
    await this.#flush();
    const status = this.#store.snapshot().outbox.find(item => item.id === id)?.status;
    if (status === 'pending') await this.#store.update(draft => {
      const item = draft.outbox.find(row => row.id === id);
      if (item?.status === 'pending') { item.status = 'discarded'; item.errorCode = 'qq.sendBlocked'; }
    });
    return status === 'sent';
  }

  /** One explicit owner test, outside chat history, usage and the durable outbox. */
  async sendPrivateImageTest(expectedBindingId: string, resolve: (authority: QqAuthority) => Promise<{
    image: QqResolvedReplyImage;
    title: string;
  }>): Promise<{ result: QqSendResult; title: string }> {
    const failed = (error: string) => ({ result: { ok: false, unknown: false, error }, title: '' });
    if (this.#privateImageTestActive) return failed('qq.imageTestBusy');
    if (this.#store.snapshot().config.transport !== 'official') return failed('qq.imageTestOfficialOnly');
    let authority: QqAuthority;
    try { authority = this.authority(); }
    catch { return failed('qq.authorityRevoked'); }
    if (authority.bindingId !== expectedBindingId) return failed('qq.authorityRevoked');
    if (this.#connection !== 'online') return failed('qq.imageTestOffline');
    const send = this.#adapter.sendImageToUser;
    if (!send) return failed('qq.imageUnsupported');

    const generation = this.#generation;
    const signal = this.#controller.signal;
    const assertCurrent = (): void => {
      if (signal.aborted || generation !== this.#generation || this.#store.snapshot().config.transport !== 'official') {
        throw new Error('qq.authorityRevoked');
      }
      this.assertAuthorized(authority);
      if (this.#connection !== 'online') throw new Error('qq.imageTestOffline');
    };
    this.#privateImageTestActive = true;
    try {
      let selected: Awaited<ReturnType<typeof resolve>> | null;
      try { selected = await resolve({ ...authority }); }
      catch { selected = null; }
      try { assertCurrent(); }
      catch (error) {
        return failed(error instanceof Error && error.message === 'qq.imageTestOffline' ? error.message : 'qq.authorityRevoked');
      }
      if (!selected) return failed('qq.imageUnavailable');
      const title = typeof selected.title === 'string' ? selected.title.trim().slice(0, 160) : '';
      try {
        const result = await send.call(this.#adapter, authority.senderId, selected.image, undefined, { signal, assertCurrent });
        return { result, title };
      } catch {
        // A transport rejection may follow the final POST. Do not auto-retry.
        return { result: { ok: false, unknown: true, error: 'qq.sendUnknown' }, title };
      }
    } finally { this.#privateImageTestActive = false; }
  }

  #today(): string { return this.#now().toISOString().slice(0, 10); }
  #manage<T>(operation: () => Promise<T>): Promise<T> {
    this.#managementPending++;
    const work = this.#management.then(operation, operation).finally(() => { this.#managementPending--; });
    this.#management = work.catch(() => undefined);
    return work;
  }

  /** Memory authority is revoked BEFORE any filesystem, token or network await. */
  #revoke(): number {
    this.#cancelWebBudget(); this.#activePrivateRun = null;
    this.#revoked = true; this.#generation += 1; this.#busy = false;
    this.#controller.abort(); this.#controller = new AbortController();
    this.#adapter.stop(); this.#connection = 'disabled';
    return this.#generation;
  }
  #invalidate(draft: QqChannelState, keepQueue = false): void {
    if (draft.binding) delete draft.binding.privateCareGrant;
    draft.authorityId = randomUUID(); draft.confirmations = [];
    draft.pairingCandidate = null; draft.config.pairingCode = null; draft.config.pairingExpiresAt = null;
    draft.groupCandidate = null; draft.groupPairing = null;
    for (const item of draft.inboundQueue) {
      if (item.status === 'running') this.#finishInbound(item, 'interrupted');
      else if (item.status === 'queued' || item.status === 'paused') {
        if (keepQueue) { item.status = 'paused'; item.updatedAt = this.#now().toISOString(); }
        else this.#cancelInbound(draft, item);
      }
    }
    for (const item of draft.outbox) {
      if (item.status === 'sending') { item.status = 'unknown'; item.errorCode = 'qq.sendUnknown'; }
      else if (item.status === 'pending' || item.status === 'failed') {
        item.status = 'discarded'; item.errorCode = 'qq.authorityRevoked';
      }
    }
  }

  async configure(patch: { [K in keyof Omit<QqChannelConfig, 'pairingCode' | 'pairingExpiresAt'>]?: QqChannelConfig[K] | undefined }): Promise<QqChannelStatus> {
    // Only an idle queue has a committed snapshot of every earlier change.
    // In particular, a disable following an in-flight enable must still revoke
    // immediately even when the stored config still says "disabled".
    if (this.#managementPending === 0) {
      const state = this.#store.snapshot();
      const changed = (Object.keys(patch) as Array<keyof typeof patch>)
        .some(key => patch[key] !== undefined && patch[key] !== state.config[key]);
      const resume = patch.enabled === true && state.stopped;
      if (!changed && !resume) return this.status();
    }
    const generation = this.#revoke();
    const stopping = this.#deps.host.onStopped();
    return this.#manage(async () => {
      await stopping;
      await this.#store.update(draft => {
        // Toggling the channel preserves undispatched work in a paused state.
        // A different model, endpoint, transport or other policy revokes it.
        this.#invalidate(draft, Object.keys(patch).every(key => key === 'enabled'));
        if (patch.providerId !== undefined && patch.providerId !== draft.config.providerId && patch.model === undefined) draft.config.model = null;
        Object.assign(draft.config, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)));
        // A different bot or transport is a different identity space for senderId.
        const before = this.#store.snapshot().config;
        if ((['appId', 'transport', 'onebotUrl'] as const).some(key => patch[key] !== undefined && patch[key] !== before[key])) { draft.binding = null; draft.groups = []; }
        if (patch.enabled === true) draft.stopped = false;
      });
      if (generation === this.#generation) {
        this.#revoked = false; await this.#syncConnection(generation);
      }
      this.#changed(); return this.status();
    });
  }

  /** The owner's own switch from QQ. Unlike configure it keeps the connection and the
   * pairing; a message already queued for the earlier model is declined at its turn. */
  async #selectModel(authority: QqAuthority, providerId: string, model: string | null): Promise<void> {
    await this.#store.update(draft => {
      this.assertAuthorized(authority);
      draft.config.providerId = providerId; draft.config.model = model;
    });
    this.#changed();
  }

  /** Call before mutating credentials, not after writing the secret. */
  async credentialsChanged(write: () => Promise<void>): Promise<void> {
    const generation = this.#revoke();
    const stopping = this.#deps.host.onStopped();
    await this.#manage(async () => {
      await stopping;
      await this.#store.update(draft => { this.#invalidate(draft); draft.stopped = true; });
      await write();
      this.#secretConfigured = (await this.#deps.getSecret()) !== null;
      // Credential changes require an explicit desktop re-enable.
      if (generation === this.#generation) this.#changed();
    });
  }

  async emergencyStop(): Promise<QqChannelStatus> {
    this.#revoke();
    const stopping = this.#deps.host.onStopped();
    return this.#manage(async () => {
      await Promise.all([stopping, this.#store.update(draft => { this.#invalidate(draft, true); draft.stopped = true; })]);
      this.#changed(); return this.status();
    });
  }

  async unbind(): Promise<QqChannelStatus> {
    this.#revoke();
    const stopping = this.#deps.host.onStopped();
    return this.#manage(async () => {
      await Promise.all([stopping, this.#store.update(draft => {
        this.#invalidate(draft); draft.stopped = true; draft.binding = null; draft.groups = [];
      })]);
      this.#changed(); return this.status();
    });
  }

  /** Restore may preserve profileId; it still must never preserve QQ authority. */
  async invalidateForRestore(): Promise<void> {
    await this.unbind();
    await this.#store.update(draft => { draft.config.enabled = false; draft.outbox = []; draft.confirmations = []; });
  }
  dispose(): void { this.#revoke(); }

  setPrivateReminders(bindingId: string, enabled: boolean): Promise<QqChannelStatus> {
    const authority=this.authority();
    if (authority.bindingId!==bindingId) throw new Error('qq.authorityRevoked');
    const epoch=++this.#reminderPolicyEpoch;
    if (!enabled) {
      this.#remindersBlocked=true;
      this.#reminderController.abort();
      this.#reminderController=new AbortController();
    }
    return this.#manage(async () => {
      await this.#store.update(draft=>{
        this.assertAuthorized(authority);
        const binding=draft.binding;
        if (!binding || binding.id!==bindingId) throw new Error('qq.authorityRevoked');
        if (enabled) binding.remindersAuthorityId=authority.authorityId;
        else {
          delete binding.remindersAuthorityId;
          for (const item of draft.outbox) if ((item.reminderDueAt || item.reminderReceipt) && sameAuthority(item.authority,authority)) {
            if (item.status==='sending') {item.status='unknown';item.errorCode='qq.sendUnknown';}
            else if (item.status==='pending' || item.status==='failed') {item.status='discarded';item.errorCode='qq.reminderCancelled';}
          }
        }
      });
      if (epoch===this.#reminderPolicyEpoch) this.#remindersBlocked=!enabled;
      this.#changed();
      return this.status();
    });
  }

  async tickReminders(): Promise<void> {
    if (this.#connection==='online' && !this.#revoked && this.#store.hasDueReminder(this.#now().getTime())) await this.#flush();
  }

  webCallLimit(): number { return this.#store.snapshot().config.webCallLimit; }

  /** Only the live private host run can ask; inbound text never changes a limit. */
  async requestWebBudget(authority: QqAuthority, input: {
    runId: string; usedLimit: number; additionalCalls: number; signal: AbortSignal;
  }): Promise<boolean> {
    const active = this.#activePrivateRun;
    if (!active || !active.executing || active.generation !== this.#generation || this.#webBudgetWaiter
      || !sameAuthority(active.authority, authority) || qqGroupIdFromSender(authority.senderId) !== null
      || input.signal.aborted || (active.runId !== null && active.runId !== input.runId)
      || !Number.isSafeInteger(input.usedLimit) || input.usedLimit < 1
      || !Number.isSafeInteger(input.additionalCalls) || input.additionalCalls < 1
      || !Number.isSafeInteger(input.usedLimit + input.additionalCalls)) return false;
    try { this.assertAuthorized(authority); } catch { return false; }
    active.runId = input.runId;
    let resolve!: (approved: boolean) => void;
    const decision = new Promise<boolean>(done => { resolve = done; });
    const waiter: WebBudgetWaiter = {
      active, runId: input.runId, noticeId: randomUUID(),
      expiresAt: this.#now().getTime() + WEB_BUDGET_REPLY_TIMEOUT_MS,
      signal: input.signal, delivery: new AbortController(), resolve,
      onAbort: () => this.#finishWebBudget(waiter, false),
    };
    this.#webBudgetWaiter = waiter;
    waiter.timer = setTimeout(() => this.#finishWebBudget(waiter, false), WEB_BUDGET_REPLY_TIMEOUT_MS);
    waiter.timer.unref?.();
    input.signal.addEventListener('abort', waiter.onAbort, { once: true });
    if (input.signal.aborted) this.#finishWebBudget(waiter, false);
    if (this.#webBudgetWaiter !== waiter) return decision;
    const content = `本次任务已用完 ${input.usedLimit} 次联网调用（搜索和网页读取合计）。是否再增加 ${input.additionalCalls} 次，继续完成当前任务？\n回复“继续搜索”继续当前任务，或“先给结果”查看已有结果。5 分钟未回复，我会先给出已有结果并说明尚未完成的部分。`;
    try {
      await this.#enqueue(active.authority, { id: waiter.noticeId, kind: 'system', content, replyTo: active.replyTo, webBudgetRunId: input.runId });
      // Do not hold the admission queue or wait for a possibly stalled POST.
      // Cancellation and timeout must release the host run independently.
      void this.#flush().catch(() => this.#finishWebBudget(waiter, false));
    } catch { this.#finishWebBudget(waiter, false); }
    return decision;
  }

  #finishWebBudget(waiter: WebBudgetWaiter, approved: boolean): void {
    if (this.#webBudgetWaiter !== waiter) return;
    this.#webBudgetWaiter = null;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.delivery.abort();
    waiter.resolve(approved);
    // A queued prompt must never reappear after its live decision has ended.
    void this.#store.update(draft => {
      const notice = draft.outbox.find(item => item.id === waiter.noticeId);
      if (notice && ['pending', 'failed'].includes(notice.status)) {
        notice.status = 'discarded'; notice.errorCode = 'qq.webBudgetExpired';
      }
    }).catch(() => undefined);
  }

  #cancelWebBudget(): void {
    if (this.#webBudgetWaiter) this.#finishWebBudget(this.#webBudgetWaiter, false);
  }

  async #answerWebBudget(authority: QqAuthority, message: QqInboundMessage, approved: boolean): Promise<void> {
    const waiter = this.#webBudgetWaiter;
    const valid = waiter && waiter.active === this.#activePrivateRun && waiter.active.executing
      && waiter.active.generation === this.#generation && sameAuthority(waiter.active.authority, authority)
      && !waiter.signal.aborted && this.#now().getTime() < waiter.expiresAt;
    const notice = valid ? this.#store.snapshot().outbox.find(item => item.id === waiter.noticeId) : undefined;
    if (!valid || !notice || notice.webBudgetRunId !== waiter.runId || !sameAuthority(notice.authority, authority)) {
      if (waiter && !valid) this.#finishWebBudget(waiter, false);
      await this.#enqueue(authority, { kind: 'system', content: '当前没有等待确认的联网续搜请求，或请求已失效。请重新提出要查询的任务。', replyTo: message.id });
      return;
    }
    if (notice.attempts < 1 || !['sending', 'sent', 'unknown'].includes(notice.status)) {
      await this.#enqueue(authority, { kind: 'system', content: '联网续搜提示尚未送达，请收到提示后再回复。', replyTo: message.id });
      return;
    }
    this.assertAuthorized(authority);
    // This owner message opens a fresh official-QQ reply window for both the
    // next prompt and the eventual answer, without restarting the model run.
    waiter.active.replyTo = message.id;
    this.#finishWebBudget(waiter, approved);
  }

  bindingSessionId(): string | null { return this.#store.snapshot().binding?.sessionId ?? null; }
  authority(): QqAuthority {
    const state = this.#store.snapshot();
    if (this.#revoked || !state.config.enabled || state.stopped || state.profileId !== this.#deps.profileId() || !state.binding) throw new Error('qq.authorityRevoked');
    return { authorityId: state.authorityId, bindingId: state.binding.id, senderId: state.binding.senderId, sessionId: state.binding.sessionId };
  }
  assertAuthorized(authority: QqAuthority): void {
    if (qqGroupIdFromSender(authority.senderId) !== null) {
      const group = this.#store.snapshot().groups.find(item => item.id === authority.bindingId);
      if (!group || !sameAuthority(authority, this.#groupAuthority(group))) throw new Error('qq.authorityRevoked');
      return;
    }
    if (!sameAuthority(authority, this.authority())) throw new Error('qq.authorityRevoked');
  }
  #groupAuthority(group: QqChannelState['groups'][number]): QqAuthority {
    const state = this.#store.snapshot();
    if (this.#revoked || !state.config.enabled || state.stopped || state.profileId !== this.#deps.profileId()) throw new Error('qq.authorityRevoked');
    return { authorityId: state.authorityId, bindingId: group.id, senderId: qqGroupSender(group.groupId), sessionId: group.sessionId };
  }

  async startGroupPairing(): Promise<{ code: string; expiresAt: string }> {
    return this.#manage(async () => {
      const state = this.#store.snapshot();
      if (this.#revoked || !state.config.enabled || state.stopped || state.groups.length >= QQ_MAX_GROUPS) throw new Error('qq.pairingUnavailable');
      const generation = this.#generation, code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const expiresAt = new Date(this.#now().getTime() + 5 * 60_000).toISOString();
      await this.#store.update(draft => { draft.groupPairing = { code, expiresAt, attempts: 0 }; draft.groupCandidate = null; });
      this.#groupPairingIssue = null;
      // Reconnecting here could drop the command the owner is about to send.
      if (this.#connection !== 'online') await this.#syncConnection(generation);
      this.#changed(); return { code, expiresAt };
    });
  }

  async confirmGroupPairing(candidateId: string): Promise<QqChannelStatus> {
    return this.#manage(async () => {
      const state = this.#store.snapshot(), candidate = state.groupCandidate;
      if (this.#revoked || !state.config.enabled || state.stopped || !candidate || candidate.id !== candidateId || state.groups.length >= QQ_MAX_GROUPS
        || state.groups.some(group => group.groupId === candidate.groupId) || Date.parse(candidate.expiresAt) <= this.#now().getTime()) throw new Error('qq.pairingUnavailable');
      const generation = this.#generation, id = randomUUID();
      await this.#store.update(draft => { draft.groupCandidate = null; });
      const { sessionId } = await this.#deps.host.createBindingSession(id, candidate.groupId);
      if (generation !== this.#generation || this.#revoked) throw new Error('qq.authorityRevoked');
      await this.#store.update(draft => {
        if (generation !== this.#generation) throw new Error('qq.authorityRevoked');
        draft.groups.push({ id, groupId: candidate.groupId, ownerMemberId: candidate.senderId, sessionId, openToMembers: true, titleMigrated: true, boundAt: this.#now().toISOString() });
      });
      this.#changed(); return this.status();
    });
  }

  async setGroupOpen(id: string, openToMembers: boolean): Promise<QqChannelStatus> {
    return this.#manage(async () => {
      await this.#store.update(draft => {
        const group = draft.groups.find(item => item.id === id);
        if (!group) throw new Error('qq.pairingUnavailable');
        group.openToMembers = openToMembers;
      });
      this.#changed(); return this.status();
    });
  }

  async removeGroup(id: string): Promise<QqChannelStatus> {
    return this.#manage(async () => {
      await this.#store.update(draft => {
        draft.groups = draft.groups.filter(item => item.id !== id);
        for (const item of draft.outbox) if (item.authority.bindingId === id && ['pending', 'failed'].includes(item.status)) { item.status = 'discarded'; item.errorCode = 'qq.authorityRevoked'; }
      });
      await this.#syncConnection(this.#generation); this.#changed(); return this.status();
    });
  }

  async startPairing(): Promise<{ code: string; expiresAt: string }> {
    return this.#manage(async () => {
      const state = this.#store.snapshot();
      if (this.#revoked || !state.config.enabled || state.stopped || state.binding) throw new Error('qq.pairingUnavailable');
      const generation = this.#generation;
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const expiresAt = new Date(this.#now().getTime() + 5 * 60_000).toISOString();
      await this.#store.update(draft => {
        draft.config.pairingCode = code; draft.config.pairingExpiresAt = expiresAt;
        draft.pairingCandidate = null; draft.pairingAttempts = 0;
      });
      this.#pairingIssue = null;
      await this.#syncConnection(generation); this.#changed(); return { code, expiresAt };
    });
  }

  /** Desktop-only second factor. Knowing a six-digit code is not ownership. */
  async confirmPairing(candidateId: string): Promise<QqChannelStatus> {
    return this.#manage(async () => {
      const state = this.#store.snapshot(), candidate = state.pairingCandidate;
      if (this.#revoked || !state.config.enabled || state.stopped || state.binding || !candidate
        || candidate.id !== candidateId || Date.parse(candidate.expiresAt) <= this.#now().getTime()) throw new Error('qq.pairingUnavailable');
      const generation = this.#generation, bindingId = randomUUID();
      // Consume before creating the session; a crash can never replay approval.
      await this.#store.update(draft => { draft.pairingCandidate = null; });
      const { sessionId } = await this.#deps.host.createBindingSession(bindingId);
      if (generation !== this.#generation || this.#revoked) throw new Error('qq.authorityRevoked');
      await this.#store.update(draft => {
        if (generation !== this.#generation) throw new Error('qq.authorityRevoked');
        draft.authorityId = randomUUID();
        draft.binding = { id: bindingId, senderId: candidate.senderId, sessionId, displayName: 'QQ', boundAt: this.#now().toISOString() };
      });
      this.#changed(); return this.status();
    });
  }

  canReconnect(): boolean {
    const state = this.#store.snapshot();
    return !this.#revoked && this.#managementPending === 0 && this.#connection === 'offline' &&
      state.config.enabled && !state.stopped && state.profileId === this.#deps.profileId() && this.#secretConfigured &&
      !/^(?:qq\.(?:authFailed|gatewayTargetBlocked|onebotTargetBlocked))$/u.test(this.#adapter.lastError ?? '');
  }

  async reconnect(allowed: () => boolean): Promise<boolean> {
    if (!allowed() || !this.canReconnect()) return false;
    const generation = this.#generation;
    return this.#manage(() => this.#syncConnection(generation, () => allowed() && this.#connection === 'offline'));
  }

  #revokeGate: (() => Promise<void>) | null = null;
  /** After a restore: revoke binding, group grants and outbox before any connection; until saved, nothing connects. */
  async revokeBeforeConnecting(afterRevoked: () => Promise<void>): Promise<boolean> {
    this.#revokeGate = async () => { await this.invalidateForRestore(); await afterRevoked(); };
    return this.#passRevokeGate();
  }
  async #passRevokeGate(): Promise<boolean> {
    const gate = this.#revokeGate;
    if (gate === null) return true;
    this.#revokeGate = null;
    try { await gate(); return true; }
    catch { this.#revokeGate = gate; return false; }
  }

  async #syncConnection(generation: number, allowed = () => true): Promise<boolean> {
    if (!(await this.#passRevokeGate())) return false;
    const secret = await this.#deps.getSecret().catch(() => null);
    if (!allowed() || generation !== this.#generation || this.#revoked) return false;
    this.#secretConfigured = secret !== null && secret.length > 0;
    const state = this.#store.snapshot();
    if (!state.config.enabled || state.stopped || endpoint(state) === '' || !secret
      || (!state.binding && !state.config.pairingCode && !state.pairingCandidate && state.groups.length === 0 && !state.groupPairing && !state.groupCandidate)) {
      this.#adapter.stop(); this.#connection = 'disabled'; return false;
    }
    try {
      this.#connection = 'connecting';
      await this.#adapter.start({ transport: state.config.transport, appId: state.config.appId, onebotUrl: state.config.onebotUrl, secret }, {
        onMessage: message => { if (generation === this.#generation && !this.#revoked) void this.handleInbound(message); },
        onConnectionChange: connection => {
          if (generation === this.#generation && !this.#revoked) {
            this.#connection = connection; this.#changed();
            if (connection === 'online') {
              void this.#flush().catch(() => undefined);
              void this.#drainPrivateQueue().catch(() => undefined);
            }
          }
        },
      });
    } catch {
      if (generation === this.#generation && !this.#revoked) { this.#connection = 'offline'; this.#changed(); }
    }
    return true;
  }

  async handleInbound(message: QqInboundMessage): Promise<void> {
    // /stop bypasses both the admission queue and the model's running promise.
    if (message.group === undefined && message.content === '/stop') {
      try { if (message.senderOpenId === this.authority().senderId) await this.emergencyStop(); } catch { /* fail closed */ }
      return;
    }
    const generation = this.#generation;
    const admission = this.#inbox.then(() => this.#admit(message, generation));
    this.#inbox = admission.catch(() => undefined);
    try { const run = await admission; await run?.(); } catch { /* no raw error or private content on QQ */ }
  }

  async #admit(message: QqInboundMessage, generation: number): Promise<(() => Promise<void>) | undefined> {
    if (generation !== this.#generation || this.#revoked) return;
    const state = this.#store.snapshot();
    if (!state.config.enabled || state.stopped || !message.id || !message.senderOpenId
      || !message.content || message.content.length > QQ_MAX_MESSAGE_CHARACTERS) return;
    if (message.group !== undefined) return this.#admitGroup(message, message.group.groupId, generation);
    if (state.binding && message.senderOpenId !== state.binding.senderId) return;
    if (!state.binding) {
      if (state.pairingCandidate) return;
      if (!state.config.pairingCode || !state.config.pairingExpiresAt || Date.parse(state.config.pairingExpiresAt) <= this.#now().getTime()) {
        this.#pairingIssue = 'no-active-code'; this.#changed(); return;
      }
      const match = QQ_PAIRING_COMMAND.exec(message.content);
      if (!match) { this.#pairingIssue = 'wrong-format'; this.#changed(); return; }
      await this.#store.update(draft => {
        if (generation !== this.#generation || draft.processedMessageIds.includes(message.id) || !draft.config.pairingCode) return;
        this.#remember(draft, message.id); draft.pairingAttempts += 1;
        if (match[1] === draft.config.pairingCode) {
          draft.pairingCandidate = { id: randomUUID(), senderId: message.senderOpenId, expiresAt: draft.config.pairingExpiresAt! };
          draft.config.pairingCode = null; draft.config.pairingExpiresAt = null;
          this.#pairingIssue = null;
        } else if (draft.pairingAttempts >= 5) {
          draft.config.pairingCode = null; draft.config.pairingExpiresAt = null;
          this.#pairingIssue = 'attempts-exhausted';
        } else this.#pairingIssue = 'wrong-code';
      });
      this.#changed(); return;
    }
    const authority = this.authority();
    const reminder = parseQqReminder(message.content, this.#now());
    if (reminder) {
      await this.#store.update(draft => {
        this.assertAuthorized(authority);
        if (draft.processedMessageIds.includes(message.id)) return;
        // Dedup the inbound command, schedule its notice and persist the receipt
        // in the same write. A process crash cannot create a second reminder.
        this.#remember(draft,message.id);
        applyQqReminder(draft,authority,reminder,message.id,this.#now());
      });
      this.#changed();
      return () => this.#flush();
    }
    const webBudgetCommand = /^(?:\/)?(继续搜索|先给结果)$/u.exec(message.content.trim());
    const queueCommand = /^\/(queue|cancel-queue|resume-queue)$/u.exec(message.content.trim())?.[1];
    const chatCommand = this.#deps.host.chatCommand ? parseChatCommand(message.content) : null;
    const checkup = this.#deps.host.checkup !== undefined && /^\/?(?:体检|checkup)$/iu.test(message.content.trim());
    if (!webBudgetCommand && !queueCommand && !chatCommand && !checkup && !message.content.startsWith('/pair')
      && message.content !== '/ping' && message.content !== '/status' && !message.content.startsWith('/confirm')) {
      return this.#admitPrivateMessage(message, authority, generation);
    }
    if (queueCommand) return this.#handleQueueCommand(queueCommand, message, authority);
    const admitted = await this.#store.update(draft => {
      this.assertAuthorized(authority);
      if (draft.processedMessageIds.includes(message.id)) return false;
      this.#remember(draft, message.id); return true;
    });
    if (!admitted) return;
    if (webBudgetCommand) {
      await this.#answerWebBudget(authority, message, webBudgetCommand[1] === '继续搜索');
      return () => this.#flush();
    }
    if (message.content.startsWith('/pair')) return;
    if (checkup) {
      const content = await this.#deps.host.checkup!();
      this.assertAuthorized(authority);
      await this.#enqueue(authority, { kind: 'system', content, replyTo: message.id });
      return () => this.#flush();
    }
    if (chatCommand) {
      const content = await this.#deps.host.chatCommand!(chatCommand, { key: 'qq', locale: 'zh-CN',
        selection: () => { const { providerId, model } = this.#store.snapshot().config; return { providerId, model }; },
        select: (providerId, model) => this.#selectModel(authority, providerId, model) });
      this.assertAuthorized(authority);
      await this.#enqueue(authority, { kind: 'system', content, replyTo: message.id });
      return () => this.#flush();
    }
    if (message.content === '/ping' || message.content === '/status') {
      const content = message.content === '/ping' ? 'pong' : `QQ：${this.status().connection}；今日请求 ${this.status().dailyRequests}/${state.config.dailyRequestLimit}。`;
      await this.#enqueue(authority, { kind: 'system', content, replyTo: message.id });
      return () => this.#flush();
    }
    if (message.content.startsWith('/confirm')) {
      const match = /^\/confirm\s+([a-f0-9]{12})$/iu.exec(message.content);
      const content = match ? await this.#confirmCron(authority, match[1]!.toLowerCase()) : '确认命令格式无效，请使用宿主摘要末尾的完整命令。';
      await this.#enqueue(authority, { kind: 'system', content, replyTo: message.id });
      return () => this.#flush();
    }
    return;
  }

  #finishInbound(item: QqInboundQueueItem, status: 'completed' | 'cancelled' | 'interrupted'): void {
    item.status = status; item.content = ''; item.updatedAt = this.#now().toISOString();
  }

  #cancelInbound(draft: QqChannelState, item: QqInboundQueueItem): void {
    if (['queued', 'paused'].includes(item.status) && item.reservedDate === draft.dailyUsage.date) {
      draft.dailyUsage.requests = Math.max(0, draft.dailyUsage.requests - 1);
    }
    this.#finishInbound(item, 'cancelled');
  }

  #outboxSpace(draft: QqChannelState, needed: number): void {
    while (draft.outbox.length > 200 - needed) {
      const dependencies = new Set(draft.outbox.filter(item => item.attachment && ['pending', 'sending'].includes(item.status)).map(item => item.afterMessageId));
      const index = draft.outbox.findIndex(item => ['sent', 'discarded'].includes(item.status) && !dependencies.has(item.id));
      if (index < 0) throw new Error('qq.outboxFull');
      draft.outbox.splice(index, 1);
    }
  }

  /** Queue decisions and their user-facing receipts commit together. */
  #queueNotice(draft: QqChannelState, authority: QqAuthority, replyTo: string, content: string): void {
    this.#outboxSpace(draft, 1);
    draft.outbox.push({ id: randomUUID(), authority, kind: 'system', content, replyTo,
      runId: null, assistantMessageId: null, status: 'pending', attempts: 0,
      createdAt: this.#now().toISOString(), lastAttemptAt: null, errorCode: null });
  }

  async #admitPrivateMessage(message: QqInboundMessage, authority: QqAuthority, generation: number): Promise<() => Promise<void>> {
    await this.#store.update(draft => {
      this.assertAuthorized(authority);
      if (generation !== this.#generation) throw new Error('qq.authorityRevoked');
      if (draft.processedMessageIds.includes(message.id) || draft.inboundQueue.some(item => item.messageId === message.id)) return;
      this.#remember(draft, message.id);
      const waiting = draft.inboundQueue.filter(item => item.status === 'queued' || item.status === 'paused').length;
      if (waiting >= QQ_MAX_QUEUED_MESSAGES) {
        this.#queueNotice(draft, authority, message.id, `队列已满（最多 ${QQ_MAX_QUEUED_MESSAGES} 条待执行消息），这条没有加入。可用 /queue 查看、/cancel-queue 取消待执行消息后重新发送。`);
        return;
      }
      if (draft.dailyUsage.date !== this.#today()) draft.dailyUsage = { date: this.#today(), requests: 0 };
      if (draft.dailyUsage.requests >= draft.config.dailyRequestLimit) {
        this.#queueNotice(draft, authority, message.id, '今天的 QQ 对话次数已用完，这条没有加入队列。');
        return;
      }
      while (draft.inboundQueue.length >= QQ_MAX_INBOUND_RECORDS) {
        const index = draft.inboundQueue.findIndex(item => ['completed', 'cancelled', 'interrupted'].includes(item.status));
        if (index < 0) throw new Error('qq.queueFull');
        draft.inboundQueue.splice(index, 1);
      }
      draft.dailyUsage.requests += 1;
      const at = this.#now().toISOString();
      draft.inboundQueue.push({ id: randomUUID(), messageId: message.id, authority, content: message.content,
        providerId: draft.config.providerId, model: draft.config.model, reservedDate: this.#today(),
        status: 'queued', createdAt: at, updatedAt: at });
      if (this.#busy || waiting > 0) this.#queueNotice(draft, authority, message.id,
        '已保存到队列，会按顺序作为新任务处理，不会改变正在执行的任务。/queue 查看；/cancel-queue 取消等待；/stop 停用 QQ 并暂停队列，桌面重新启用后可 /resume-queue。');
    });
    this.#changed();
    return async () => { await this.#flush(); await this.#drainPrivateQueue(); };
  }

  async #handleQueueCommand(command: string, message: QqInboundMessage, authority: QqAuthority): Promise<() => Promise<void>> {
    await this.#store.update(draft => {
      this.assertAuthorized(authority);
      if (draft.processedMessageIds.includes(message.id)) return;
      this.#remember(draft, message.id);
      // An explicit owner command may renew paused work for the SAME binding,
      // never carry work into a new recipient, session, provider or model.
      const own = draft.inboundQueue.filter(item => item.authority.bindingId === authority.bindingId
        && item.authority.senderId === authority.senderId && item.authority.sessionId === authority.sessionId);
      let changed = 0;
      for (const item of own) {
        if (command === 'cancel-queue' && ['queued', 'paused'].includes(item.status)) {
          this.#cancelInbound(draft, item); changed += 1;
        } else if (command === 'resume-queue' && item.status === 'paused'
          && item.providerId === draft.config.providerId && item.model === draft.config.model) {
          item.authority = authority; item.status = 'queued'; item.updatedAt = this.#now().toISOString(); changed += 1;
        }
      }
      const counts = (status: QqInboundQueueItem['status']): number => own.filter(item => item.status === status).length;
      const content = command === 'cancel-queue' ? `已取消 ${changed} 条待执行消息。正在执行的任务未停止；/stop 会停用 QQ 通道。`
        : command === 'resume-queue' ? `已按当前 QQ 授权恢复 ${changed} 条待执行消息。中断且结果未知的任务不会自动重试。`
          : `队列：执行中 ${counts('running')} 条，等待 ${counts('queued')} 条，暂停 ${counts('paused')} 条，中断且结果未知 ${counts('interrupted')} 条。/cancel-queue 取消等待；/resume-queue 恢复暂停。/stop 会停用 QQ 通道并暂停等待中的消息。`;
      this.#queueNotice(draft, authority, message.id, content);
    });
    this.#changed();
    return async () => { await this.#flush(); await this.#drainPrivateQueue(); };
  }

  #drainPrivateQueue(): Promise<void> {
    if (this.#busy || this.#revoked || this.#queueWork?.generation === this.#generation) return Promise.resolve();
    const generation = this.#generation;
    this.#busy = true;
    const work = { generation, promise: Promise.resolve() };
    let failed = false;
    this.#queueWork = work;
    work.promise = Promise.resolve().then(async () => {
      while (generation === this.#generation && !this.#revoked) {
        const next = this.#store.snapshot().inboundQueue.find(item => item.status === 'queued');
        if (!next) break;
        // Persist dispatch before entering the host. A crash from this point is
        // an unknown outcome, not permission to generate the task again.
        const accepted = await this.#store.update(draft => {
          if (generation !== this.#generation || this.#revoked) return null;
          const item = draft.inboundQueue.find(row => row.id === next.id && row.status === 'queued');
          if (!item) return null;
          try { this.assertAuthorized(item.authority); }
          catch { this.#cancelInbound(draft, item); return null; }
          if (item.providerId !== draft.config.providerId || item.model !== draft.config.model) {
            this.#cancelInbound(draft, item);
            this.#queueNotice(draft, item.authority, item.messageId, '模型设置已经变化，这条排队任务未执行，请按新设置重新发送。');
            return null;
          }
          if (item.reservedDate !== this.#today()) {
            if (draft.dailyUsage.date !== this.#today()) draft.dailyUsage = { date: this.#today(), requests: 0 };
            if (draft.dailyUsage.requests >= draft.config.dailyRequestLimit) {
              item.status = 'paused'; item.updatedAt = this.#now().toISOString();
              this.#queueNotice(draft, item.authority, item.messageId, '今天的 QQ 次数已用完，这条待执行任务已暂停。之后可用 /resume-queue 明确恢复。');
              return null;
            }
            draft.dailyUsage.requests += 1; item.reservedDate = this.#today();
          }
          item.status = 'running'; item.updatedAt = this.#now().toISOString();
          return structuredClone(item);
        });
        if (accepted) await this.#runQueuedPrivate(accepted, generation);
      }
      await this.#flush();
    }).catch(async () => {
      failed = true;
      if (generation !== this.#generation || this.#revoked) return;
      // In particular, a dispatch write may have committed before its
      // acknowledgement failed. Read it back and never replay that attempt.
      await this.#store.update(draft => {
        for (const item of draft.inboundQueue) if (item.status === 'running') {
          this.assertAuthorized(item.authority);
          this.#finishInbound(item, 'interrupted');
          this.#queueNotice(draft, item.authority, item.messageId,
            '这条任务的执行状态未能确认，未自动重试。请先查看结果；用 /queue 查看其他待执行消息。');
        }
      });
      await this.#flush();
    }).finally(() => {
      if (this.#queueWork === work) this.#queueWork = null;
      if (generation === this.#generation) this.#busy = false;
      this.#changed();
      if (!failed && generation === this.#generation && !this.#revoked
        && this.#store.snapshot().inboundQueue.some(item => item.status === 'queued')) {
        void this.#drainPrivateQueue().catch(() => undefined);
      }
    });
    return work.promise;
  }

  async #runQueuedPrivate(item: QqInboundQueueItem, generation: number): Promise<void> {
    const authority = item.authority;
    const active: ActivePrivateRun = { authority, generation, replyTo: item.messageId, runId: null, executing: true };
    try {
      this.assertAuthorized(authority);
      this.#activePrivateRun = active;
      const result = await this.#deps.host.runMessage({ ...authority, text: item.content, providerId: item.providerId, model: item.model });
      active.executing = false;
      if (this.#webBudgetWaiter?.active === active) this.#cancelWebBudget();
      this.assertAuthorized(authority);
      if (result.ok) await this.#enqueue(authority, { kind: 'reply', content: result.reply, replyTo: active.replyTo,
        runId: result.runId, assistantMessageId: result.assistantMessageId, attachments: result.attachments, stickerOnly: result.stickerOnly }, item.id);
      else await this.#enqueue(authority, { kind: 'system', content: qqRunFailureText(result.code), replyTo: active.replyTo }, item.id);
    } catch (error) {
      if (generation === this.#generation && !this.#revoked) await this.#store.update(draft => {
        this.assertAuthorized(authority);
        const current = draft.inboundQueue.find(row => row.id === item.id);
        if (current?.status !== 'running') return;
        this.#finishInbound(current, 'interrupted');
        // Preserve the existing fail-closed image/disclosure boundary: even a
        // replacement text response must not bypass a blocked reply branch.
        if (!(error instanceof Error && ['qq.imageUnavailable', 'qq.disclosureBlocked', 'qq.emptyMessage'].includes(error.message))) {
          this.#queueNotice(draft, authority, active.replyTo, '这条任务未能确认完成，未自动重试。请先查看聊天中的结果，再决定是否重新发送；其他排队消息会继续处理。');
        }
      });
    } finally {
      active.executing = false;
      if (this.#webBudgetWaiter?.active === active) this.#cancelWebBudget();
      if (this.#activePrivateRun === active) this.#activePrivateRun = null;
    }
    await this.#flush();
  }

  async #admitGroup(message: QqInboundMessage, groupId: string, generation: number): Promise<(() => Promise<void>) | undefined> {
    const state = this.#store.snapshot(), group = state.groups.find(item => item.groupId === groupId);
    if (!group) {
      const match = QQ_PAIRING_COMMAND.exec(message.content), pairing = state.groupPairing;
      const active = pairing !== null && Date.parse(pairing.expiresAt) > this.#now().getTime();
      if (!match || !active) {
        // The desktop says what went wrong; the group hears nothing until it is approved.
        if (pairing !== null) { this.#groupPairingIssue = active ? 'wrong-format' : 'no-active-code'; this.#changed(); }
        return;
      }
      await this.#store.update(draft => {
        if (generation !== this.#generation || draft.processedMessageIds.includes(message.id) || !draft.groupPairing) return;
        this.#remember(draft, message.id); draft.groupPairing.attempts += 1;
        if (match[1] === draft.groupPairing.code) {
          draft.groupCandidate = { id: randomUUID(), groupId, senderId: message.senderOpenId, expiresAt: draft.groupPairing.expiresAt };
          draft.groupPairing = null; this.#groupPairingIssue = null;
        } else if (draft.groupPairing.attempts >= 5) { draft.groupPairing = null; this.#groupPairingIssue = 'attempts-exhausted'; }
        else this.#groupPairingIssue = 'wrong-code';
      });
      this.#changed(); return;
    }
    if (!group.openToMembers && message.senderOpenId !== group.ownerMemberId) return;
    const authority = this.#groupAuthority(group);
    const admitted = await this.#store.update(draft => {
      this.assertAuthorized(authority);
      if (draft.processedMessageIds.includes(message.id)) return false;
      this.#remember(draft, message.id); return true;
    });
    if (!admitted || message.content.startsWith('/pair')) return;
    const answer = async (content: string): Promise<() => Promise<void>> => {
      await this.#enqueue(authority, { kind: 'system', content, replyTo: message.id });
      return () => this.#flush();
    };
    if (/^(?:\/)?(?:继续搜索|先给结果)$/u.test(message.content.trim())) {
      return answer('联网续搜确认只接受已配对主人的私聊回复，群消息不能确认私聊任务。');
    }
    if (message.content === '/ping') return answer('pong');
    if (/^\/(?:queue|cancel-queue|resume-queue)$/u.test(message.content.trim())) return answer('这些队列命令只接受已配对主人的私聊消息。');
    if (this.#busy) return answer('我还在处理上一条，稍后再 @ 我吧。');
    const budget = await this.#store.update(draft => {
      this.assertAuthorized(authority);
      if (draft.groupUsage.date !== this.#today()) draft.groupUsage = { date: this.#today(), requests: 0 };
      if (draft.groupUsage.requests >= QQ_GROUP_DAILY_LIMIT) return false;
      draft.groupUsage.requests += 1; return true;
    });
    if (!budget) return answer('今天群聊的对话次数已用完。');
    this.#busy = true;
    return async () => {
      try {
        this.assertAuthorized(authority);
        // Member ids are opaque; the suffix only lets the model tell speakers apart.
        const result = await this.#deps.host.runMessage({ ...authority, text: `[群成员 ${message.senderOpenId.slice(-4)}] ${message.content}`, providerId: state.config.providerId, model: state.config.model });
        this.assertAuthorized(authority);
        if (result.ok) await this.#enqueue(authority, { kind: 'reply', content: result.reply, replyTo: message.id,
          runId: result.runId, assistantMessageId: result.assistantMessageId, attachments: result.attachments, stickerOnly: result.stickerOnly });
        else await this.#enqueue(authority, { kind: 'system', content: qqRunFailureText(result.code, true), replyTo: message.id });
        await this.#flush();
      } finally {
        if (generation === this.#generation) {
          this.#busy = false;
          await this.#drainPrivateQueue();
        }
      }
    };
  }

  #remember(draft: QqChannelState, id: string): void {
    draft.processedMessageIds.push(id);
    if (draft.processedMessageIds.length > 1_024) draft.processedMessageIds.shift();
  }

  async #enqueue(authority: QqAuthority, input: {
    kind: QqOutboxItem['kind']; content: string; replyTo?: string; runId?: string; assistantMessageId?: string;
    scheduleId?: string; scheduleRevision?: number;
    id?: string; webBudgetRunId?: string;
    attachments?: QqReplyImage[] | undefined;
    stickerOnly?: true | undefined;
  }, completedInboundId?: string): Promise<void> {
    const standaloneImage = input.stickerOnly === true;
    const message = input.kind === 'reply' || input.kind === 'cron' ? qqDeliveryText(input.content, input.kind === 'cron' && qqGroupIdFromSender(authority.senderId) === null) : { content: cleanReplyText(input.content) };
    if (!standaloneImage && !message.content.trim()) throw new Error('qq.emptyMessage');
    const image = input.attachments?.[0] === undefined ? undefined : qqReplyImageSchema.parse(input.attachments[0]);
    const sendImage = qqGroupIdFromSender(authority.senderId) === null ? this.#adapter.sendImageToUser : this.#adapter.sendImageToGroup;
    const attach = image && (input.kind === 'reply' || input.kind === 'cron' && qqGroupIdFromSender(authority.senderId) === null)
      && sendImage && this.#deps.host.resolveReplyImage;
    if (standaloneImage && (!attach || input.content !== '' || input.attachments?.length !== 1 || !input.runId || !input.assistantMessageId)) {
      throw new Error('qq.imageUnavailable');
    }
    await this.#store.update(draft => {
      this.assertAuthorized(authority);
      if (standaloneImage && !hasPrivateOfficialInbound(draft, authority, input.replyTo)) throw new Error('qq.disclosureBlocked');
      const needed = attach && !standaloneImage ? 2 : 1;
      this.#outboxSpace(draft, needed);
      if (completedInboundId) {
        const inbound = draft.inboundQueue.find(item => item.id === completedInboundId && item.status === 'running');
        if (!inbound || !sameAuthority(inbound.authority, authority)) throw new Error('qq.authorityRevoked');
        this.#finishInbound(inbound, 'completed');
      }
      const id = input.id ?? randomUUID();
      if (!standaloneImage) draft.outbox.push({ id, authority, kind: input.kind, ...message,
        ...(input.scheduleId === undefined ? {} : { scheduleId: input.scheduleId, scheduleRevision: input.scheduleRevision }),
        ...(input.webBudgetRunId === undefined ? {} : { webBudgetRunId: input.webBudgetRunId }),
        runId: input.runId ?? null, assistantMessageId: input.assistantMessageId ?? null, replyTo: input.replyTo ?? null,
        status: 'pending', attempts: 0, createdAt: this.#now().toISOString(), lastAttemptAt: null, errorCode: null });
      if (attach) draft.outbox.push({ id: standaloneImage ? id : randomUUID(), authority, kind: input.kind, content: image.alt, attachment: image,
        ...(input.scheduleId === undefined ? {} : { scheduleId: input.scheduleId, scheduleRevision: input.scheduleRevision }),
        ...(standaloneImage ? { standaloneImage: true } : { afterMessageId: id }),
        sourceSHA256: createHash('sha256').update(input.content).digest('hex'), runId: input.runId ?? null,
        assistantMessageId: input.assistantMessageId ?? null, replyTo: input.replyTo ?? null,
        status: 'pending', attempts: 0, createdAt: this.#now().toISOString(), lastAttemptAt: null, errorCode: null });
    });
  }

  async createCronDraft(runId: string, raw: QqCronOperation): Promise<{ pending: true; draftId: string; expiresAt: string }> {
    const operation = qqCronOperationSchema.parse(raw), authority = operation.authority;
    if (!this.#deps.host.assertCronOperation || !this.#deps.host.applyConfirmedCron) throw new Error('qq.cronUnavailable');
    this.assertAuthorized(authority); this.#deps.host.assertCronOperation(operation);
    const code = randomBytes(6).toString('hex');
    const expiresAt = new Date(this.#now().getTime() + 5 * 60_000).toISOString();
    const content = qqCronConfirmationText(operation, code, expiresAt), noticeId = randomUUID();
    const id = operation.approval.confirmationId;
    await this.#store.update(draft => {
      this.assertAuthorized(authority); this.#deps.host.assertCronOperation!(operation);
      if (draft.outbox.length >= 200) {
        const index = draft.outbox.findIndex(item => ['sent', 'discarded'].includes(item.status));
        if (index < 0) throw new Error('qq.outboxFull'); draft.outbox.splice(index, 1);
      }
      for (const item of draft.outbox) if (item.confirmationId && item.status === 'pending') {
        item.status = 'discarded'; item.errorCode = 'qq.confirmationSuperseded';
      }
      // A single current draft prevents ambiguity; the host notice says so.
      draft.confirmations = [{ id, codeHash: createHash('sha256').update(code).digest('hex'), operation,
        operationDigest: qqCronDigest(operation), noticeId, runId, createdAt: this.#now().toISOString(), expiresAt, attempts: 0 }];
      draft.outbox.push({ id: noticeId, confirmationId: id, authority, kind: 'system', runId: null, assistantMessageId: null,
        content, replyTo: null, status: 'pending', attempts: 0, createdAt: this.#now().toISOString(), lastAttemptAt: null, errorCode: null });
    });
    await this.#flush(); this.#changed();
    // The code/summary never enters the tool result or domain conversation.
    return { pending: true, draftId: id, expiresAt };
  }

  async #confirmCron(authority: QqAuthority, code: string): Promise<string> {
    const operation = await this.#store.update(draft => {
      this.assertAuthorized(authority);
      const pending = draft.confirmations[0];
      if (!pending || !sameAuthority(pending.operation.authority, authority)) return null;
      if (Date.parse(pending.expiresAt) <= this.#now().getTime()) { draft.confirmations = []; return null; }
      const candidate = Buffer.from(createHash('sha256').update(code).digest('hex'), 'hex');
      if (!timingSafeEqual(candidate, Buffer.from(pending.codeHash, 'hex'))) {
        pending.attempts += 1; if (pending.attempts >= 5) draft.confirmations = []; return null;
      }
      const notice = draft.outbox.find(item => item.id === pending.noticeId);
      draft.confirmations = []; // Durable single-use consumption BEFORE applying.
      if (!notice || notice.attempts < 1 || !['sending', 'sent', 'unknown'].includes(notice.status)
        || notice.confirmationId !== pending.id || !sameAuthority(notice.authority, authority)
        || notice.content !== qqCronConfirmationText(pending.operation, code, pending.expiresAt)
        || pending.operationDigest !== qqCronDigest(pending.operation)) return null;
      try { this.#deps.host.assertCronOperation?.(pending.operation); } catch { return null; }
      return structuredClone(pending.operation);
    });
    this.#changed();
    if (!operation || !this.#deps.host.applyConfirmedCron) return '确认码无效、已失效或任务参数已变更。请重新生成宿主草案。';
    try {
      this.assertAuthorized(authority);
      const result = await this.#deps.host.applyConfirmedCron(operation);
      this.assertAuthorized(authority);
      return `已按宿主摘要确认任务 ${result.id}。${result.enabled ? '已启用；仅在应用运行时执行。' : '参数已更新，任务仍保持暂停。'}`;
    } catch { return '这次确认未完成。请先查看任务列表；不要假定已启用，重新操作需要新草案。'; }
  }

  async reserveScheduledRequest(authority: QqAuthority, runId: string): Promise<void> {
    await this.#store.update(draft => {
      this.assertAuthorized(authority);
      const key = `cron:${runId}`;
      if (draft.processedMessageIds.includes(key)) throw new Error('qq.duplicateRun');
      if (draft.dailyUsage.date !== this.#today()) draft.dailyUsage = { date: this.#today(), requests: 0 };
      if (draft.dailyUsage.requests >= draft.config.dailyRequestLimit) throw new Error('qq.dailyLimit');
      draft.dailyUsage.requests += 1; this.#remember(draft, key);
    });
  }

  async deliverReply(authority: QqAuthority, reply: { content: string; runId: string; assistantMessageId: string; scheduleId: string; scheduleRevision: number; attachments?: QqReplyImage[] | undefined }): Promise<void> {
    this.assertAuthorized(authority);
    await this.#enqueue(authority, { kind: 'cron', ...reply }); await this.#flush();
  }

  #flush(): Promise<void> {
    this.#flushRequested = true;
    this.#flushPromise ??= Promise.resolve().then(async () => {
      try {
        do {
          this.#flushRequested = false;
          await this.#flushOnce();
        } while (this.#flushRequested);
      } finally {
        this.#flushPromise = null;
      }
    });
    return this.#flushPromise;
  }
  async #flushOnce(): Promise<void> {
    for (;;) {
      // A known offline transport has not attempted any delivery. Keep the
      // encrypted entry pending so the next online event can recheck its grant.
      if (this.#connection !== 'online' || this.#revoked) return;
      const now=this.#now().getTime();
      const item = this.#store.snapshot().outbox.find(entry => entry.status === 'pending' &&
        (!entry.reminderDueAt || Date.parse(entry.reminderDueAt)<=now));
      if (!item) return;
      if (item.attachment && !item.standaloneImage) {
        const parent = this.#store.snapshot().outbox.find(entry => entry.id === item.afterMessageId);
        if (parent && ['pending', 'sending'].includes(parent.status)) return;
        if (!hasConfirmedTextReply(item, parent)) {
          await this.#store.update(draft => { const row = draft.outbox.find(entry => entry.id === item.id);
            if (row?.status === 'pending') { row.status = 'discarded'; row.errorCode = 'qq.imageTextNotDelivered'; } });
          continue;
        }
      }
      const reminder = item.reminderDueAt || item.reminderReceipt;
      const waiter = item.webBudgetRunId ? this.#webBudgetWaiter : null;
      const signal = reminder ? AbortSignal.any([this.#controller.signal,this.#reminderController.signal])
        : waiter ? AbortSignal.any([this.#controller.signal, waiter.delivery.signal]) : this.#controller.signal;
      const assertCurrent = (): void => {
        signal.throwIfAborted(); this.assertAuthorized(item.authority);
        if (item.attachment) {
          const state = this.#store.snapshot();
          if (item.standaloneImage) {
            if (!hasPrivateOfficialInbound(state, item.authority, item.replyTo)) throw new Error('qq.disclosureBlocked');
          } else if (!hasConfirmedTextReply(item, state.outbox.find(row => row.id === item.afterMessageId))) {
            throw new Error('qq.imageTextNotDelivered');
          }
        }
        if (item.webBudgetRunId) {
          const pending = this.#webBudgetWaiter;
          if (!pending || pending !== waiter || pending.noticeId !== item.id || pending.runId !== item.webBudgetRunId
            || pending.active !== this.#activePrivateRun || !pending.active.executing || pending.active.generation !== this.#generation
            || item.kind !== 'system' || !sameAuthority(pending.active.authority, item.authority)
            || this.#now().getTime() >= pending.expiresAt) throw new Error('qq.webBudgetExpired');
        }
        if (reminder) {
          const state=this.#store.snapshot();
          const live=state.outbox.find(row=>row.id===item.id);
          if (this.#remindersBlocked || item.kind!=='system' || (item.reminderDueAt ? item.replyTo!==null : item.replyTo===null) ||
            !sameAuthority(this.authority(),item.authority) || state.binding?.remindersAuthorityId!==item.authority.authorityId ||
            !live || !['pending','sending'].includes(live.status)) throw new Error('qq.reminderCancelled');
          if (item.reminderDueAt && this.#now().getTime()-Date.parse(item.reminderDueAt)>REMINDER_GRACE_MS) throw new Error('qq.reminderExpired');
        }
        if (item.confirmationId) {
          const pending = this.#store.snapshot().confirmations.find(value => value.id === item.confirmationId);
          if (!pending || Date.parse(pending.expiresAt) <= this.#now().getTime()) throw new Error('qq.confirmationExpired');
          this.#deps.host.assertCronOperation?.(pending.operation);
        }
        if (item.kind === 'care') this.#privateCare.assertDelivery(item);
        else if (item.kind !== 'system') this.#deps.host.assertDelivery(item);
      };
      try { assertCurrent(); } catch (error) {
        await this.#store.update(draft => {
          const target = draft.outbox.find(entry => entry.id === item.id);
          if (target?.status === 'pending') {
            target.status = 'discarded';
            target.errorCode = item.reminderDueAt ? (error instanceof Error && error.message==='qq.reminderExpired' ? 'qq.reminderExpired':'qq.reminderCancelled') : 'qq.disclosureBlocked';
          }
        });
        continue;
      }
      await this.#store.update(draft => {
        assertCurrent();
        const target = draft.outbox.find(entry => entry.id === item.id)!;
        target.status = 'sending'; target.attempts += 1; target.lastAttemptAt = this.#now().toISOString();
      });
      let result: QqSendResult;
      let imageDispatched = false;
      try {
        assertCurrent();
        const groupId = item.kind === 'care' || reminder ? null : qqGroupIdFromSender(item.authority.senderId);
        const state = item.kind === 'reply' && !item.attachment ? this.#store.snapshot() : null;
        const reserveImageReply = state?.config.transport === 'official'
          && state.outbox.some(row => row.attachment && row.status === 'pending' && row.afterMessageId === item.id);
        const controls: QqSendControls = { signal, assertCurrent, singleBubble: item.kind !== 'reply',
          ...(reserveImageReply ? { reserveImageReply: true } : {}) };
        if (item.attachment) {
          const send = groupId === null ? this.#adapter.sendImageToUser : this.#adapter.sendImageToGroup;
          if (!send || !this.#deps.host.resolveReplyImage) {
            result = { ok: false, unknown: false, error: 'qq.imageUnsupported' };
          } else {
            const image = await this.#deps.host.resolveReplyImage(item.attachment.assetId, item.authority);
            assertCurrent();
            if (image.sha256 !== item.attachment.assetId) throw new Error('qq.imageUnavailable');
            imageDispatched = true;
            result = await send.call(this.#adapter, groupId ?? item.authority.senderId, image, item.replyTo ?? undefined, controls);
          }
        } else {
          const text = cleanReplyText(groupId !== null ? item.content
            : item.kind === 'cron' ? privateCronText(item.content) : qqReminderDeliveryText(item, this.#now()));
          if (!text.trim()) result = { ok: false, unknown: false, error: 'qq.emptyMessage' };
          else result = await (groupId === null ? this.#adapter.sendToUser(item.authority.senderId, text, item.replyTo ?? undefined, controls)
            : this.#adapter.sendToGroup(groupId, text, item.replyTo ?? undefined, controls));
        }
      } catch { result = item.attachment && !imageDispatched ? { ok: false, unknown: false, error: 'qq.imageUnavailable' }
        : { ok: false, unknown: true, error: 'qq.sendUnknown' }; }
      await this.#store.update(draft => {
        const target = draft.outbox.find(entry => entry.id === item.id);
        if (!target || target.status !== 'sending') return;
        target.status = result.ok ? 'sent' : result.unknown ? 'unknown' : 'failed';
        target.errorCode = result.ok ? null : result.error ?? 'qq.sendFailed';
      });
      if (item.webBudgetRunId && !result.ok && !result.unknown && this.#webBudgetWaiter?.noticeId === item.id) {
        this.#finishWebBudget(this.#webBudgetWaiter, false);
      }
      this.#changed();
    }
  }

  async retryUnknownDeliveries(): Promise<void> {
    const authority = this.authority();
    await this.#store.update(draft => {
      this.assertAuthorized(authority);
      for (const item of draft.outbox) if (item.status === 'failed' && sameAuthority(item.authority, authority) && item.attempts < 5) item.status = 'pending';
    });
    await this.#flush();
  }
}
