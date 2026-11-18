import { pluginConfigurationSchema } from '../../shared/plugins';
import type { PluginConfiguration, PluginSettings, PluginState } from '../../shared/plugins';
import type { SafeStorageVault } from '../security';
import { CRAWL4AI_SECRET_ID } from './credentials';

interface Dependencies {
  settings: { get(): { plugins: PluginSettings }; update(patch: { plugins: PluginSettings }): Promise<unknown> };
  vault: Pick<SafeStorageVault, 'isAvailable' | 'hasSecret' | 'getSecret' | 'setSecret' | 'deleteSecret'>;
  cancelRea(): Promise<void>;
  invalidateWeb(): void;
}

/** Coordinates encrypted credentials with settings without exposing secrets to
 * the renderer. A failed settings write restores the previously saved token. */
export class PluginConfigurationService {
  #queue: Promise<void> = Promise.resolve();
  #cleanupUnconfirmed = false;
  constructor(private readonly dependencies: Dependencies) {}

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  getState(): Promise<PluginState> { return this.#enqueue(() => this.#state()); }

  async #state(): Promise<PluginState> {
    const configured = this.dependencies.vault.isAvailable() && await this.dependencies.vault.hasSecret(CRAWL4AI_SECRET_ID);
    return { settings: structuredClone(this.dependencies.settings.get().plugins), crawl4aiTokenConfigured: configured,
      ...(this.#cleanupUnconfirmed ? { warningCode: 'plugin.reaCleanupUnconfirmed' as const } : {}) };
  }

  async configure(input: PluginConfiguration): Promise<PluginState> {
    const frozen = pluginConfigurationSchema.parse(structuredClone(input));
    return this.#enqueue(() => this.#configure(frozen));
  }

  async #configure(input: PluginConfiguration): Promise<PluginState> {
    const previous = await this.#state();
    // A previously failed close must be confirmed before REA can be re-enabled.
    if (this.#cleanupUnconfirmed && input.settings.rea.enabled) {
      try { await this.dependencies.cancelRea(); this.#cleanupUnconfirmed = false; }
      catch { throw new Error('plugin.reaCleanupUnconfirmed'); }
    }
    const changesSecret = input.clearCrawl4aiToken === true || !!input.crawl4aiToken;
    const priorToken = changesSecret ? await this.dependencies.vault.getSecret(CRAWL4AI_SECRET_ID) : null;
    if (changesSecret) this.dependencies.invalidateWeb();
    try {
      if (input.clearCrawl4aiToken) await this.dependencies.vault.deleteSecret(CRAWL4AI_SECRET_ID);
      else if (input.crawl4aiToken) await this.dependencies.vault.setSecret(CRAWL4AI_SECRET_ID, input.crawl4aiToken);
      await this.dependencies.settings.update({ plugins: input.settings });
    } catch {
      if (changesSecret) {
        try {
          if (priorToken === null) await this.dependencies.vault.deleteSecret(CRAWL4AI_SECRET_ID);
          else await this.dependencies.vault.setSecret(CRAWL4AI_SECRET_ID, priorToken);
        } catch {
          this.dependencies.invalidateWeb();
          throw new Error('plugin.configurationRollbackFailed');
        }
      }
      this.dependencies.invalidateWeb();
      throw new Error('plugin.saveFailed');
    }
    this.dependencies.invalidateWeb();
    // Persist the disabled state first. Cleanup failure must never re-enable a
    // plugin or claim that an unconfirmed process has stopped.
    if (!input.settings.rea.enabled) {
      try { await this.dependencies.cancelRea(); this.#cleanupUnconfirmed = false; }
      catch { this.#cleanupUnconfirmed = true; }
    }
    return { settings: structuredClone(input.settings),
      crawl4aiTokenConfigured: input.clearCrawl4aiToken ? false : !!input.crawl4aiToken || previous.crawl4aiTokenConfigured,
      ...(this.#cleanupUnconfirmed ? { warningCode: 'plugin.reaCleanupUnconfirmed' as const } : {}) };
  }
}
