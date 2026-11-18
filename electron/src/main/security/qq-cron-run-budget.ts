import type { QqCronApproval } from '../../shared/qq-channel';

/** Process-local limits; never use model-supplied counters or deadlines. */
export class QqCronRunBudget {
  readonly signal: AbortSignal;
  readonly #timer: ReturnType<typeof setTimeout>;
  #modelCalls = 0;
  constructor(private readonly approval: QqCronApproval, parent: AbortSignal) {
    const deadline = new AbortController();
    this.signal = AbortSignal.any([parent, deadline.signal]);
    this.#timer = setTimeout(() => deadline.abort(new Error('qq.runtimeLimit')), approval.runtimeLimitMs);
    this.#timer.unref?.();
  }
  modelOutputLimit(requested: number): number {
    this.signal.throwIfAborted();
    if (++this.#modelCalls > this.approval.modelCallLimit) throw new Error('qq.modelCallLimit');
    return Math.min(requested, this.approval.outputTokenLimit);
  }
  dispose(): void { clearTimeout(this.#timer); }
}
