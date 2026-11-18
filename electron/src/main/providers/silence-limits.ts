import type { ProviderConfig } from '../../shared';

// Ollama can hold back a whole tool call until it is complete, so a local model
// writing a long file stays silent for minutes. The user can stop it at any time.
export const providerSilenceLimitMs = (kind: ProviderConfig['kind']): number =>
  kind === 'ollama' || kind === 'lm-studio' ? 15 * 60_000 : 60_000;
