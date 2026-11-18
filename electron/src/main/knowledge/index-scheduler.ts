import type { VaultKnowledgeService } from './vault-index';

const INDEX_INTERVAL_MS = 2 * 60 * 60 * 1000;

export class KnowledgeIndexScheduler {
  #timer: NodeJS.Timeout | undefined;

  constructor(private readonly service: Pick<VaultKnowledgeService, 'status' | 'reindex'>) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.refresh(), INDEX_INTERVAL_MS);
    this.#timer.unref();
    this.refresh();
  }

  refresh(): void {
    const status = this.service.status();
    if (!this.#timer || status.vaultName === null || !status.autoIndex) return;
    void this.service.reindex().catch(() => undefined);
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
