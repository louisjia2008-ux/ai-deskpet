import { routingDestination } from '../../shared/model-routing';
import type { ProviderConfig } from '../../shared';
import type { CapturedProviderBinding } from './provider-service';
import type { ProviderModelInspection } from './types';

export const selectedLocalOllama = (provider: ProviderConfig | undefined, model: string): provider is ProviderConfig =>
  !!provider && provider.kind === 'ollama' && provider.model === model && routingDestination(provider) === 'local';

export const verifiedLocalOllama = (binding: CapturedProviderBinding, inspection: ProviderModelInspection | undefined = binding.inspection): boolean =>
  selectedLocalOllama(binding.provider, binding.model) && inspection?.localGguf === true && inspection.executionDestination !== 'remote';
