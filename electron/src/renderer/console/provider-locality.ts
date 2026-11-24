import type { ProviderConfig } from '../../shared';

/** Only a provider confirmed to run on this computer may receive local-only input without asking. */
export const providerIsLocal = (provider: Pick<ProviderConfig, 'localExecutionConfirmed'>): boolean => provider.localExecutionConfirmed === true;
