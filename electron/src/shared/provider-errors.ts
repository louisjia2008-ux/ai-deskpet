const PROVIDER_FAILURE_CODES = new Set([
  'provider.authentication', 'provider.quota', 'provider.rateLimit', 'provider.timeout',
  'provider.unavailable', 'provider.request', 'provider.failed', 'provider.cancelled',
  'provider.streamInterrupted', 'provider.truncated',
  'provider.contextBudgetExceeded', 'provider.invalidRequestBudget', 'provider.bindingMismatch',
  'provider.contextPrivacyBlocked',
  'provider.budgetExceeded',
  'provider.requestRecordFailed',
  'provider.discoveryBusy', 'provider.discoveryFailed', 'provider.credentialsRequired', 'provider.credentialEndpointChanged', 'provider.configurationBusy',
  'provider.permissionDenied', 'provider.network', 'provider.catalogInvalid', 'provider.limitUnknown',
  'provider.unsupportedParameter', 'provider.modelUnavailable', 'provider.regionRestricted',
]);

// Only expose known codes across the renderer boundary, never upstream bodies.
export const providerFailureCode = (error: unknown, fallback = 'provider.failed'): string => {
  if (error !== null && typeof error === 'object') {
    if ('code' in error && typeof error.code === 'string' && PROVIDER_FAILURE_CODES.has(error.code)) return error.code;
    if ('name' in error && error.name === 'TimeoutError') return 'provider.timeout';
  }
  if (error instanceof Error && PROVIDER_FAILURE_CODES.has(error.message)) return error.message;
  return fallback;
};
