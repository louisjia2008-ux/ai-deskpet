import { randomUUID } from 'node:crypto';

import type { ChatApprovalDecision, ChatApprovalRequest, ChatEvent, ChatInteractionState, ChatMessage, ChatProgress, PermissionDescriptor } from '../../shared';
import type { ModelTurnMessage } from '../runtime/agent-runtime';
import type { PermissionGate, PermissionLease } from '../runtime/permissions';
import type { ToolDescriptor } from '../runtime/tool-registry';
import type { ChatService } from './chat-service';

interface PendingApproval {
  request: ChatApprovalRequest;
  revision: number;
  settle(lease: PermissionLease | undefined, failure?: 'chat.approvalDenied' | 'chat.approvalExpired'): void;
}
interface Addition { content: string; promise: Promise<ChatMessage> }
interface InteractiveRun {
  state: ChatInteractionState;
  controller: AbortController;
  additions: Map<string, Addition>;
  queue: Array<Promise<ChatMessage>>;
  consumedFollowupIds: string[];
  approval: PendingApproval | null;
  /** Task-long approvals, bound to the permission revision they reviewed. Never persisted. */
  runGrants: Map<string, number>;
}

/** Repeatable data access only. Recurring schedules, static analysis, timers and
 * notifications always need a decision per operation. */
const RUN_APPROVABLE_CAPABILITIES: ReadonlySet<string> = new Set([
  'math.calculate', 'time.read', 'system.read', 'web.search', 'web.read', 'workspace.read', 'workspace.write', 'task.records', 'history.read', 'notes.read', 'notes.write',
  // The machine is the boundary; asking for every command of one task adds nothing.
  'vm.shell',
]);

/** Host-only transient interaction state. User additions themselves are persisted. */
export class ChatInteractionService {
  readonly #runs = new Map<string, InteractiveRun>();

  constructor(
    private readonly chat: ChatService,
    private readonly permissions: PermissionGate,
    private readonly descriptors: ReadonlyArray<Omit<PermissionDescriptor, 'state' | 'expiresAt'>>,
    private readonly emit: (event: ChatEvent) => void,
    private readonly approvalTimeoutMs = 5 * 60_000,
  ) {}

  start(runId: string, sessionId: string, messageId: string, canFollowup: boolean): void {
    if (this.#runs.has(runId)) throw new Error('chat.sessionBusy');
    const run: InteractiveRun = {
      state: { runId, sessionId, messageId, canFollowup, acceptingFollowups: canFollowup, queuedFollowups: 0, approval: null, progress: { phase: 'preparing' } },
      controller: new AbortController(), additions: new Map(), queue: [], consumedFollowupIds: [], approval: null, runGrants: new Map(),
    };
    this.#runs.set(runId, run); this.#emit(run);
  }

  get(sessionId: string): ChatInteractionState | null {
    const run = [...this.#runs.values()].find((item) => item.state.sessionId === sessionId);
    return run ? structuredClone(run.state) : null;
  }

  #notify(event: ChatEvent): void {
    // A closed/reloading renderer must never invalidate committed input or hold
    // an authorization promise open. It recovers state via getInteraction.
    try { this.emit(event); } catch { /* Notification is not the source of truth. */ }
  }

  #emit(run: InteractiveRun): void { this.#notify({ type: 'interaction', state: structuredClone(run.state) }); }

  progress(runId: string, progress: ChatProgress): void {
    const run = this.#runs.get(runId);
    if (!run || run.controller.signal.aborted) return;
    run.state.progress = progress; this.#emit(run);
  }

  signal(runId: string): AbortSignal {
    const run = this.#runs.get(runId);
    if (!run) throw new Error('chat.interrupted');
    return run.controller.signal;
  }

  /** Cancel setup promptly even if an adapter metadata query does not support AbortSignal. */
  wait<T>(runId: string, operation: Promise<T>): Promise<T> {
    const signal = this.signal(runId);
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => reject(new DOMException('Chat cancelled.', 'AbortError'));
      if (signal.aborted) { void operation.catch(() => undefined); abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  followup(input: { runId: string; sessionId: string; operationId: string; content: string }): Promise<ChatMessage> {
    const run = this.#runs.get(input.runId);
    const content = input.content.trim();
    if (!run || run.state.sessionId !== input.sessionId) return Promise.reject(new Error('chat.followupUnavailable'));
    const prior = run.additions.get(input.operationId);
    if (prior) return prior.content === content ? prior.promise : Promise.reject(new Error('chat.followupConflict'));
    const assertAccepting = (): void => {
      if (!run.state.acceptingFollowups || !run.state.canFollowup || run.controller.signal.aborted || this.#runs.get(input.runId) !== run) throw new Error('chat.followupUnavailable');
    };
    try { assertAccepting(); } catch (error) { return Promise.reject(error); }
    if (!content || content.length > 8_000 || run.additions.size >= 8 || [...run.additions.values()].reduce((n, item) => n + item.content.length, 0) + content.length > 32_000) return Promise.reject(new Error('chat.followupLimit'));
    const promise = this.chat.addFollowup(run.state.messageId, input.operationId, content, assertAccepting).then((message) => {
      this.#notify({ type: 'followup', runId: input.runId, sessionId: input.sessionId, messageId: run.state.messageId, message });
      // A changed instruction invalidates old approvals. Runtime drains this
      // already-persisted queue before deciding whether undefined means denial.
      run.runGrants.clear(); run.approval?.settle(undefined);
      return message;
    });
    run.additions.set(input.operationId, { content, promise });
    run.queue.push(promise); run.state.queuedFollowups = run.queue.length; this.#emit(run);
    void promise.catch(() => {
      // Preserve the operation ID on an uncertain commit for a safe same-ID retry.
      const index = run.queue.indexOf(promise); if (index >= 0) run.queue.splice(index, 1);
      run.state.queuedFollowups = run.queue.length;
      run.additions.delete(input.operationId);
      if (this.#runs.get(input.runId) === run) this.#emit(run);
    });
    return promise;
  }

  async drainFollowups(runId: string): Promise<ModelTurnMessage[]> {
    const run = this.#runs.get(runId);
    if (!run || run.controller.signal.aborted) return [];
    const pending = run.queue.splice(0);
    const additions = await Promise.all(pending);
    run.state.queuedFollowups = run.queue.length;
    if (run.controller.signal.aborted || this.#runs.get(runId) !== run) return [];
    run.consumedFollowupIds.push(...additions.map((message) => message.id));
    if (additions.length > 0) this.#emit(run);
    return additions.map((message) => ({ role: 'user', content: message.content }));
  }

  /** Persisted additions still in the queue are not part of the model input. */
  consumedFollowupIds(runId: string): string[] { return [...(this.#runs.get(runId)?.consumedFollowupIds ?? [])]; }

  finishing(runId: string): boolean {
    const run = this.#runs.get(runId);
    if (!run) return true;
    if (run.queue.length > 0) return false;
    run.state.acceptingFollowups = false; this.#emit(run); return true;
  }

  requestApproval(runId: string, tool: ToolDescriptor, input: unknown, signal: AbortSignal, disclosure?: ChatApprovalRequest['disclosure']): Promise<PermissionLease | undefined> {
    const run = this.#runs.get(runId);
    const descriptor = this.descriptors.find((item) => item.capabilityId === tool.capabilityId);
    if (!run || run.controller.signal.aborted || signal.aborted || !descriptor || run.approval) return Promise.resolve(undefined);
    const granted = run.runGrants.get(tool.capabilityId);
    if (granted !== undefined) {
      if (granted === this.permissions.revision(tool.capabilityId)) return Promise.resolve(this.permissions.authorizeOperation(tool.capabilityId, granted));
      run.runGrants.delete(tool.capabilityId);
    }
    const serialized = JSON.stringify(input, null, 2);
    const request: ChatApprovalRequest = {
      id: randomUUID(), runId, sessionId: run.state.sessionId, messageId: run.state.messageId,
      toolId: tool.id, capabilityId: tool.capabilityId, titleCode: descriptor.titleCode, detailCode: descriptor.detailCode, risk: tool.risk,
      inputPreview: serialized.slice(0, 12_000), inputTruncated: serialized.length > 12_000,
      expiresAt: new Date(Date.now() + this.approvalTimeoutMs).toISOString(),
      allowRun: RUN_APPROVABLE_CAPABILITIES.has(tool.capabilityId),
      ...(disclosure === undefined ? {} : { disclosure }),
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle: PendingApproval['settle'] = (lease, failure) => {
        if (settled) { lease?.release(); return; } settled = true;
        clearTimeout(timeout); signal.removeEventListener('abort', abort); run.controller.signal.removeEventListener('abort', abort);
        if (run.approval?.request.id === request.id) { run.approval = null; run.state.approval = null; this.#emit(run); }
        if (failure) reject(new Error(failure)); else resolve(lease);
      };
      const abort = (): void => settle(undefined);
      const timeout = setTimeout(() => settle(undefined, 'chat.approvalExpired'), this.approvalTimeoutMs); timeout.unref?.();
      run.approval = { request, revision: this.permissions.revision(tool.capabilityId), settle };
      run.state.approval = request; run.state.progress = { phase: 'awaiting-approval' };
      signal.addEventListener('abort', abort, { once: true }); run.controller.signal.addEventListener('abort', abort, { once: true });
      this.#emit(run);
    });
  }

  resolveApproval(input: { runId: string; sessionId: string; approvalId: string; decision: ChatApprovalDecision }): void {
    const run = this.#runs.get(input.runId), pending = run?.approval;
    if (!run || !pending || run.state.sessionId !== input.sessionId || pending.request.id !== input.approvalId) throw new Error('chat.approvalExpired');
    if (run.controller.signal.aborted || Date.now() >= Date.parse(pending.request.expiresAt) || this.permissions.revision(pending.request.capabilityId) !== pending.revision
      || (input.decision === 'allow-run' && !pending.request.allowRun)) {
      pending.settle(undefined, 'chat.approvalExpired'); throw new Error('chat.approvalExpired');
    }
    if (input.decision === 'deny') { pending.settle(undefined, 'chat.approvalDenied'); return; }
    const lease = this.permissions.authorizeOperation(pending.request.capabilityId, pending.revision);
    if (input.decision === 'allow-run') run.runGrants.set(pending.request.capabilityId, pending.revision);
    pending.settle(lease);
  }

  cancel(runId: string): void {
    const run = this.#runs.get(runId); if (!run) return;
    run.state.acceptingFollowups = false; run.controller.abort(); run.approval?.settle(undefined); this.#emit(run);
  }

  finish(runId: string): void {
    const run = this.#runs.get(runId); if (!run) return;
    run.state.acceptingFollowups = false; run.approval?.settle(undefined); this.#emit(run); this.#runs.delete(runId);
  }

  cancelAll(): void { for (const runId of this.#runs.keys()) this.cancel(runId); }
}
