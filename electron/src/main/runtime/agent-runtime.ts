import { randomUUID } from 'node:crypto';

import { DesktopToolCatalog, DISCOVER_TOOLS } from './desktop-tool-catalog';
import { FileDelivery } from './file-delivery';
import type { EffectLedger } from './effect-ledger';
import { PermissionDeniedError } from './permissions';
import type { PermissionGate, PermissionLease } from './permissions';
import type { TaskEventStream } from './task-event-stream';
import type { ToolDescriptor, ToolRegistry } from './tool-registry';
import { classifyToolFailure, recoverableToolFailure, refusedCallResult, toolFailureResult, ToolFailure } from './tool-failure';
import type { ProviderResponseItem, ProviderToolThought } from '../providers/types';

export interface ToolCall {
  id: string;
  toolId: string;
  input: unknown;
  effectKey?: string;
}

export type ModelDecision =
  | { type: 'final'; content: string }
  | { type: 'tools'; calls: readonly ToolCall[]; toolThought?: ProviderToolThought; responseItems?: ProviderResponseItem[] };

export interface ModelTurnMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; argumentsJson: string }>;
  toolThought?: ProviderToolThought;
  responseItems?: ProviderResponseItem[];
  /** Runtime-authored result provenance. Never derive this from tool JSON or
   * forward it to the provider wire protocol. Unknown results stay private. */
  hostToolResult?: 'success' | 'safe-error' | 'skipped';
}

export interface ModelDriver {
  next(input: {
    messages: ModelTurnMessage[];
    tools: ReturnType<ToolRegistry['describe']>;
    signal: AbortSignal;
    /** The step budget is spent: declare no tools and report progress as text. */
    wrapUp?: boolean;
  }): Promise<ModelDecision>;
}

export interface AgentRunResult {
  runId: string;
  status: 'succeeded' | 'cancelled' | 'failed';
  content: string;
  iterations: number;
  /** The text is a progress report written at the step limit, not a finished task. */
  limitReached?: boolean;
  /** The limit was repeated tool failures rather than the step count. */
  failuresExhausted?: boolean;
  /** The channel's combined search/read allowance was spent. */
  webBudgetExceeded?: boolean;
  /** An explicit requested path has no successful nonempty write receipt. */
  deliveryIncomplete?: boolean;
  /** A limited research run saved a draft, but did not finish the full task. */
  draftDelivered?: boolean;
}

export type AgentRunProgress =
  | { type: 'model'; iteration: number }
  | { type: 'tool'; toolId: string }
  | { type: 'recovery'; toolId: string };

/** Host-owned controls only. Model messages cannot grant permission or insert
 * follow-ups; the host persists and authenticates user input before draining. */
export interface AgentRunControls {
  /** Keep low-frequency declarations behind run-local metadata discovery. */
  desktopToolCatalog?: boolean;
  desktopMcpToolAvailable?: (id: string) => boolean;
  /** Desktop-only: reserve a bounded, normally approved file delivery phase. */
  fileDelivery?: boolean;
  beforeTool?: (tool: ToolDescriptor, input: unknown) => void;
  /** Durable effect replay is only valid under the same host authority snapshot. */
  effectScope?: (tool: ToolDescriptor) => string | undefined;
  /** Once per actual execution, not on repeatable authorization checks. */
  onToolExecuting?: (tool: ToolDescriptor, input: unknown, signal: AbortSignal) => void | Promise<void>;
  drainFollowups?: () => Promise<ModelTurnMessage[]>;
  /** Called only for a missing grant. Returning undefined keeps the denial. */
  authorizeTool?: (tool: ToolDescriptor, input: unknown, signal: AbortSignal) => Promise<PermissionLease | undefined>;
  /** Atomically close follow-up admission; false means new input is waiting. */
  onFinishing?: () => boolean | void;
  /** Force authorizeTool even with a standing grant: a grant covers host access,
   * not a separate disclosure decision for this specific call. */
  requiresApproval?: (tool: ToolDescriptor, input: unknown) => boolean;
  /** Spend one tool-free model call on a progress report at the step or failure limit. */
  wrapUpOnLimit?: boolean;
  /** Decline one call without running it. With wrapUpOnLimit the model is told and
   * the run continues; without it the failure ends the run. */
  refuseCall?: (call: ToolCall) => { failure: ToolFailure; message: string } | undefined;
  /** True when a failed model call left nothing behind and may be repeated once. */
  retryModelCall?: (error: unknown) => boolean;
}

// Unrelated failures are normal in research work; repeating the same failed call
// is not. Identical calls stop early, and the total still bounds a run.
const MAX_RECOVERABLE_TOOL_FAILURES = 8;
const MAX_IDENTICAL_CALL_FAILURES = 2;

class FollowupSupersededError extends Error {
  constructor(readonly pending: ModelTurnMessage[]) { super('New user instructions superseded the pending tool call.'); }
}

class FollowupReadError extends Error {
  constructor(readonly reason: unknown) { super('Host follow-up could not be read.'); }
}

export class AgentLimitError extends Error {
  constructor() {
    super('The agent reached its bounded tool-loop limit.');
    this.name = 'AgentLimitError';
  }
}

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new DOMException('The agent run was cancelled.', 'AbortError');
  }
};

export class AgentRuntime {
  readonly #controllers = new Map<string, AbortController>();

  constructor(
    private readonly tools: ToolRegistry,
    private readonly permissions: PermissionGate,
    private readonly effects: EffectLedger,
    private readonly events: TaskEventStream,
    private readonly maxIterations = 8,
  ) {}

  cancel(runId: string): boolean {
    const controller = this.#controllers.get(runId);
    controller?.abort();
    return controller !== undefined;
  }

  get activeRuns(): number { return this.#controllers.size; }

  async run(
    userInput: string,
    driver: ModelDriver,
    requestedRunId: string = randomUUID(),
    context: readonly ModelTurnMessage[] = [],
    onToolResult?: (toolId: string, output: unknown, input: unknown) => Promise<void>,
    onProgress?: (progress: AgentRunProgress) => void,
    controls: AgentRunControls = {},
  ): Promise<AgentRunResult> {
    const controller = new AbortController();
    this.#controllers.set(requestedRunId, controller);
    const catalog = controls.desktopToolCatalog ? new DesktopToolCatalog(controls.desktopMcpToolAvailable) : null;
    const messages: ModelTurnMessage[] = [...structuredClone(context), { role: 'user', content: userInput }];
    const delivery = controls.fileDelivery ? new FileDelivery(userInput) : null;
    let closeout: 'failures' | 'steps' | 'missing-file' | null = null;
    let closeoutTurns = 0;
    let deliveryCorrectionUsed = false;
    const closeoutMessage: ModelTurnMessage = { role: 'system', content: '' };
    const beginCloseout = async (reason: NonNullable<typeof closeout>): Promise<void> => {
      closeout = reason;
      closeoutTurns = 0;
      closeoutMessage.content = 'The host is closing this file task. Only workspace.write and task.update are available. '
        + 'Use the existing tool evidence to write the requested file now, with actual sources and clearly marked failed reads or unresolved claims. '
        + 'Do not invent facts, claim full verification, or promise to save it later. Ordinary permission checks and write approval still apply. '
        + 'Requested relative paths: ' + JSON.stringify(delivery?.missing ?? []) + '. Then report the real write result.';
      messages.push(closeoutMessage);
      await this.events.emit(requestedRunId, 'state', 'running', 'Bounded file delivery started.', { reason, missingPaths: delivery?.missing ?? [] });
    };
    const deliveryResult = (): Pick<AgentRunResult, 'limitReached' | 'failuresExhausted' | 'deliveryIncomplete' | 'draftDelivered'> => {
      if (delivery?.required && delivery.missing.length > 0) return { limitReached: true, deliveryIncomplete: true, ...(closeout === 'failures' ? { failuresExhausted: true } : {}) };
      if (closeout === 'failures' || closeout === 'steps') return { limitReached: true, draftDelivered: true, ...(closeout === 'failures' ? { failuresExhausted: true } : {}) };
      return {};
    };
    let recoveredFailures = 0;
    let failuresExhausted = false;
    let webBudgetExceeded = false;
    let iterationsCompleted = 0;
    let modelCallRetried = false;
    const askModel = async (input: Parameters<ModelDriver['next']>[0]): ReturnType<ModelDriver['next']> => {
      try { return await driver.next(input); }
      catch (error) {
        if (modelCallRetried || controller.signal.aborted || controls.retryModelCall?.(error) !== true) throw error;
        modelCallRetried = true;
        await this.events.emit(requestedRunId, 'model', 'running', 'Interrupted model call repeated once.');
        return await driver.next(input);
      }
    };
    const identicalFailures = new Map<string, number>();
    const callKey = (call: ToolCall): string => `${call.toolId}\0${JSON.stringify(call.input) ?? ''}`;
    const followups = async (): Promise<ModelTurnMessage[]> => {
      throwIfAborted(controller.signal);
      const pending = await controls.drainFollowups?.() ?? [];
      throwIfAborted(controller.signal);
      // Keep the provider tool-call protocol host-owned even if a caller makes
      // a mistake while adapting persisted user messages to runtime messages.
      if (pending.some((message) => message.role !== 'user' || !message.content.trim()
        || message.toolCallId !== undefined || message.toolCalls !== undefined || message.responseItems !== undefined || message.toolThought !== undefined || message.hostToolResult !== undefined)) {
        throw new Error('Invalid host follow-up message.');
      }
      return structuredClone(pending);
    };
    const appendFollowups = async (pending: ModelTurnMessage[]): Promise<void> => {
      if (pending.length === 0) return;
      let changedDelivery = false;
      for (const message of pending) changedDelivery = delivery?.followup(message.content) === true || changedDelivery;
      if (changedDelivery) {
        // A changed/cancelled target invalidates the old closing instruction.
        const index = messages.indexOf(closeoutMessage);
        if (index >= 0) messages.splice(index, 1);
        closeout = null; closeoutTurns = 0;
      }
      messages.push(...pending);
      await this.events.emit(requestedRunId, 'state', 'running', 'User follow-up accepted at a step boundary.', { count: pending.length });
    };
    const returnFailure = async (failure: ToolFailure, call: ToolCall, result: unknown): Promise<void> => {
      if (delivery && (call.toolId === 'web.read' || call.toolId === 'web.search')) delivery.webFailures += 1;
      recoveredFailures += 1; identicalFailures.set(callKey(call), (identicalFailures.get(callKey(call)) ?? 0) + 1);
      onProgress?.({ type: 'recovery', toolId: call.toolId });
      messages.push({ role: 'tool', toolCallId: call.id, hostToolResult: 'safe-error', content: JSON.stringify(result) });
      await this.events.emit(requestedRunId, 'tool', 'running', 'Tool failure returned for a bounded correction.', {
        toolId: call.toolId, taskId: call.id, errorCode: failure.code, recovery: recoveredFailures, ...(failure.detail === undefined ? {} : { detail: failure.detail }),
      });
    };
    const recover = async (failure: ToolFailure, call: ToolCall, sideEffect: boolean, phase: 'arguments' | 'execution'): Promise<void> => {
      // A spent resource budget is distinct from lost authority. Retain the
      // hard execution ceiling and complete this batch's tool protocol, then
      // allow only the existing single tool-free progress report. Scheduled
      // work has no extra model-call allowance and keeps its failure path.
      if (failure.code === 'tool.webBudgetExceeded' && !sideEffect && phase === 'execution' && controls.wrapUpOnLimit) {
        webBudgetExceeded = true;
        await returnFailure(failure, call, toolFailureResult(failure));
        return;
      }
      if (!recoverableToolFailure(failure, sideEffect, phase)) throw failure;
      if (recoveredFailures >= MAX_RECOVERABLE_TOOL_FAILURES || (identicalFailures.get(callKey(call)) ?? 0) >= MAX_IDENTICAL_CALL_FAILURES) {
        if (!controls.wrapUpOnLimit) throw failure;
        failuresExhausted = true;
      }
      await returnFailure(failure, call, toolFailureResult(failure));
    };
    /** Answers a call that must not run: a host refusal, or a repeat of a call that
     * already failed. Returns true when the call was answered here. */
    const refuse = async (call: ToolCall): Promise<boolean> => {
      if (!controls.wrapUpOnLimit) {
        const refusal = controls.refuseCall?.(call);
        if (refusal) throw refusal.failure;
        return false;
      }
      const identical = identicalFailures.get(callKey(call)) ?? 0;
      const refusal = controls.refuseCall?.(call) ?? (identical >= MAX_IDENTICAL_CALL_FAILURES
        ? { failure: new ToolFailure('tool.repeatedFailure'), message: 'This exact call has already failed. It was not run again. Move on, and report it as failed in your answer.' }
        : undefined);
      if (!refusal) return false;
      if (recoveredFailures >= MAX_RECOVERABLE_TOOL_FAILURES || identical > MAX_IDENTICAL_CALL_FAILURES) failuresExhausted = true;
      await returnFailure(refusal.failure, call, refusedCallResult(refusal.failure, refusal.message));
      return true;
    };
    try {
      await this.events.emit(requestedRunId, 'state', 'running', 'Agent run started.');
      for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
        iterationsCompleted = iteration;
        throwIfAborted(controller.signal);
        await appendFollowups(await followups());
        if (!closeout && delivery?.missing.length && this.tools.describe().some(tool => tool.id === 'workspace.write')) {
          if (delivery.webFailures >= 4 && delivery.sourcesRead > 0) await beginCloseout('failures');
          else if (iteration >= Math.max(1, this.maxIterations - 2)) await beginCloseout('steps');
        }
        if (closeout && closeoutTurns >= 3) break;
        onProgress?.({ type: 'model', iteration });
        const registered = this.tools.describe();
        const descriptors = closeout ? registered.filter(tool => tool.id === 'workspace.write' || tool.id === 'task.update') : catalog?.describe(registered) ?? registered;
        if (closeout) closeoutTurns += 1;
        const decision = await askModel({ messages: structuredClone(messages), tools: descriptors, signal: controller.signal });
        throwIfAborted(controller.signal);
        if (decision.type === 'final') {
          const pending = await followups();
          if (pending.length > 0) {
            if (decision.content) messages.push({ role: 'assistant', content: decision.content });
            await appendFollowups(pending);
            continue;
          }
          if (delivery?.missing.length && !closeout && !deliveryCorrectionUsed) {
            deliveryCorrectionUsed = true;
            if (decision.content) messages.push({ role: 'assistant', content: decision.content });
            await beginCloseout('missing-file');
            continue;
          }
          if (controls.onFinishing?.() === false) {
            if (decision.content) messages.push({ role: 'assistant', content: decision.content });
            continue;
          }
          await this.events.emit(requestedRunId, 'model', 'succeeded', 'Agent produced a final response.');
          return { runId: requestedRunId, status: 'succeeded', content: decision.content, iterations: iteration, ...deliveryResult() };
        }

        const callIds = new Set(decision.calls.map((call) => call.id));
        if (callIds.size !== decision.calls.length || decision.calls.some((call) => !call.id)) throw new ToolFailure('tool.invalidArguments');
        const preparedCalls = decision.calls.map((call) => {
          if ((catalog || closeout) && !descriptors.some(item => item.id === call.toolId)) throw new ToolFailure('tool.notDeclared');
          if (closeout && call.toolId === 'workspace.write' && (!call.input || typeof call.input !== 'object'
            || !('path' in call.input) || typeof call.input.path !== 'string' || !delivery?.paths.includes(call.input.path.replace(/^\.\//u, '')))) throw new ToolFailure('tool.notRequested');
          const tool = catalog && call.toolId === DISCOVER_TOOLS ? catalog.discovery : this.tools.get(call.toolId);
          const parsed = tool.inputSchema.safeParse(call.input);
          return { call, tool, parsed, input: parsed.success ? parsed.data : call.input };
        });
        if (preparedCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: '',
            ...(decision.toolThought === undefined ? {} : { toolThought: decision.toolThought }),
            ...(decision.responseItems === undefined ? {} : { responseItems: structuredClone(decision.responseItems) }),
            toolCalls: preparedCalls.map(({ call, input }) => ({
              id: call.id,
              name: call.toolId,
              argumentsJson: JSON.stringify(input) ?? 'null',
            })),
          });
        }
        const skipCall = (call: ToolCall, code: 'tool.superseded' | 'tool.batchReplan', message: string): void => {
          messages.push({ role: 'tool', toolCallId: call.id, hostToolResult: 'skipped', content: JSON.stringify({
            ok: false, skipped: true, error: { code, retryable: false, message },
          }) });
        };
        const supersede = async (index: number, pending: ModelTurnMessage[]): Promise<void> => {
          for (const { call } of preparedCalls.slice(index)) skipCall(call, 'tool.superseded',
            'Not executed because the user supplied new instructions. Reconsider the task before choosing any further actions.');
          await appendFollowups(pending);
        };
        const beforeBatch = await followups();
        if (beforeBatch.length > 0) { await supersede(0, beforeBatch); continue; }
        // Validate the complete batch before consuming any permission or
        // executing any call. A later malformed call must not leave earlier
        // side effects behind while the model corrects its plan.
        if (preparedCalls.some(({ parsed }) => !parsed.success)) {
          for (const { call, tool, parsed } of preparedCalls) {
            throwIfAborted(controller.signal);
            if (!parsed.success) await recover(new ToolFailure('tool.invalidArguments'), call, tool.sideEffect, 'arguments');
            else skipCall(call, 'tool.batchReplan',
              'Not executed because another call in this batch had invalid arguments. Reconsider the entire batch before choosing further actions.');
          }
          continue;
        }
        for (let index = 0; index < preparedCalls.length; index += 1) {
          const { call, tool, input } = preparedCalls[index]!;
          throwIfAborted(controller.signal);
          const pending = await followups();
          if (pending.length > 0) { await supersede(index, pending); break; }
          if (await refuse(call)) {
            for (const { call: remaining } of preparedCalls.slice(index + 1)) skipCall(remaining, 'tool.batchReplan',
              'Not executed because an earlier call in this batch was declined. Reconsider the task using that result before choosing further actions.');
            break;
          }
          controls.beforeTool?.(descriptors.find((item) => item.id === tool.id)!, input);
          // Metadata discovery changes only this run's declarations. It never
          // reads task data, grants a capability, or executes a discovered tool.
          if (catalog && tool === catalog.discovery) {
            const result = await tool.execute(input, { runId: requestedRunId, taskId: call.id, signal: controller.signal });
            const discovery = result && typeof result === 'object' && 'loaded' in result && result.loaded === 'mcp'
              ? { ...result, availableTools: catalog.mcpWireNames(registered,
                messages.flatMap(message => message.toolCalls?.map(item => item.name) ?? [])) }
              : result;
            messages.push({ role: 'tool', toolCallId: call.id, hostToolResult: 'success', content: JSON.stringify(discovery) });
            await this.events.emit(requestedRunId, 'tool', 'running', 'Tool group discovered.', { toolId: tool.id, taskId: call.id });
            continue;
          }
          const started = Date.now();
          let output: unknown;
          let lease: PermissionLease;
          try {
            try {
              if (controls.requiresApproval?.(descriptors.find((item) => item.id === tool.id)!, input)) throw new PermissionDeniedError(tool.capabilityId);
              lease = await this.permissions.consume(tool.capabilityId);
            } catch (error) {
              if (!(error instanceof PermissionDeniedError) || !controls.authorizeTool) throw error;
              const descriptor = descriptors.find((item) => item.id === tool.id)!;
              const granted = await controls.authorizeTool(descriptor, structuredClone(input), controller.signal);
              let adopted = false;
              try {
                // The host may dismiss an approval to wake this run after
                // durably queueing a follow-up. That is not an approval grant.
                const afterApproval = await followups();
                if (afterApproval.length > 0) { await supersede(index, afterApproval); break; }
                if (granted === undefined) throw error;
                lease = granted; adopted = true;
              } finally { if (!adopted) granted?.release(); }
            }
          } catch (error) {
            throwIfAborted(controller.signal);
            // Approval/storage failures are not failures of a tool execution
            // and must never be treated as a transient model retry.
            if (error instanceof PermissionDeniedError) throw classifyToolFailure(error, tool.id);
            throw error;
          }
          try {
            const signal = AbortSignal.any([controller.signal, lease.signal]);
            throwIfAborted(controller.signal);
            const afterAuthorization = await followups();
            if (afterAuthorization.length > 0) { await supersede(index, afterAuthorization); break; }
            onProgress?.({ type: 'tool', toolId: tool.id });
            try {
              const execute = async () => {
                throwIfAborted(controller.signal);
                // EffectLedger may wait for another use of the same effect
                // key; check again at the actual operation start boundary.
                const atExecution = await followups().catch((error: unknown) => { throw new FollowupReadError(error); });
                if (atExecution.length > 0) throw new FollowupSupersededError(atExecution);
                lease.assertCurrent(); signal.throwIfAborted();
                controls.beforeTool?.(descriptors.find(item=>item.id===tool.id)!, input);
                await controls.onToolExecuting?.(descriptors.find(item=>item.id===tool.id)!, input, signal);
                // A channel may wait for its owner to extend a resource budget.
                // That wait must not keep an obsolete grant or policy alive.
                lease.assertCurrent(); signal.throwIfAborted();
                const afterExecutionWait = await followups().catch((error: unknown) => { throw new FollowupReadError(error); });
                if (afterExecutionWait.length > 0) throw new FollowupSupersededError(afterExecutionWait);
                controls.beforeTool?.(descriptors.find(item=>item.id===tool.id)!, input);
                return tool.execute(input, { runId: requestedRunId, taskId: call.id, signal, assertAuthorized: () => {lease.assertCurrent();controls.beforeTool?.(descriptors.find(item=>item.id===tool.id)!, input);} });
              };
              if (tool.sideEffect) {
                if (!call.effectKey) throw new ToolFailure('tool.invalidArguments');
                const scope = controls.effectScope?.(descriptors.find(item => item.id === tool.id)!);
                output = await this.effects.execute(call.effectKey, requestedRunId, tool.id, input, execute, scope);
                if (scope !== undefined) {
                  lease.assertCurrent();
                  signal.throwIfAborted();
                  controls.beforeTool?.(descriptors.find(item => item.id === tool.id)!, input);
                }
              } else {
                output = await execute();
              }
            } catch (error) {
              throwIfAborted(controller.signal);
              if (error instanceof FollowupSupersededError) { await supersede(index, error.pending); break; }
              if (error instanceof FollowupReadError) throw error.reason;
              // A lease cancellation is authority loss, even when the tool
              // reports only a generic network/abort error from its transport.
              if (lease.signal.aborted) throw classifyToolFailure(new PermissionDeniedError(tool.capabilityId), tool.id);
              if (error instanceof DOMException && error.name === 'AbortError') throw error;
              await recover(classifyToolFailure(error, tool.id), call, tool.sideEffect, 'execution');
              // Remaining calls may depend on the missing read result. Return
              // a complete tool protocol to the model for a fresh plan before
              // permitting any of those old calls to execute.
              for (const { call: remaining } of preparedCalls.slice(index + 1)) skipCall(remaining, 'tool.batchReplan',
                'Not executed because an earlier call in this batch failed. Reconsider the task using that failure before choosing further actions.');
              break;
            }
          } finally { lease.release(); }
          await onToolResult?.(tool.id, output, input);
          delivery?.record(tool.id, output);
          messages.push({ role: 'tool', toolCallId: call.id, hostToolResult: 'success', content: JSON.stringify(output) });
          await this.events.emit(requestedRunId, tool.sideEffect ? 'effect' : 'tool', 'running', `Tool ${tool.id} completed.`, {
            toolId: tool.id,
            taskId: call.id,
            elapsedMs: Date.now() - started,
          });
        }
        if (failuresExhausted || webBudgetExceeded) break;
      }
      if (!controls.wrapUpOnLimit) throw new AgentLimitError();
      throwIfAborted(controller.signal);
      await appendFollowups(await followups());
      if (webBudgetExceeded) messages.push({ role: 'system', content: 'The host stopped this task because its combined web search and page-read allowance is exhausted. No tools are available. Return a partial progress report in the user\'s language using only the tool results already received. Distinguish successfully read pages from search snippets and failed reads, and explicitly list unverified claims. Do not describe this as a channel permission failure or as completed research.' });
      onProgress?.({ type: 'model', iteration: iterationsCompleted + 1 });
      const report = await askModel({ messages: structuredClone(messages), tools: [], signal: controller.signal, wrapUp: true });
      throwIfAborted(controller.signal);
      // Input arriving during this last call has no step left to be honoured in.
      if (report.type !== 'final' || !report.content.trim() || (await followups()).length > 0 || controls.onFinishing?.() === false) throw new AgentLimitError();
      await this.events.emit(requestedRunId, 'model', 'succeeded', webBudgetExceeded ? 'Agent reported progress at its web-call limit.' : failuresExhausted ? 'Agent reported progress after repeated failures.' : 'Agent reported progress at its step limit.');
      return { runId: requestedRunId, status: 'succeeded', content: report.content, iterations: iterationsCompleted, limitReached: true, ...(webBudgetExceeded ? { webBudgetExceeded } : {}), ...(failuresExhausted ? { failuresExhausted } : {}), ...deliveryResult() };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        await this.events.emit(requestedRunId, 'state', 'cancelled', 'Agent run cancelled.');
        return { runId: requestedRunId, status: 'cancelled', content: '', iterations: 0 };
      }
      await this.events.emit(requestedRunId, 'error', 'failed', error instanceof Error ? error.message : 'Unknown agent error.');
      throw error;
    } finally {
      this.#controllers.delete(requestedRunId);
    }
  }
}
