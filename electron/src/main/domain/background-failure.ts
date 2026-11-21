import { providerFailureCode } from '../../shared/provider-errors';

/** Keep only known codes. Upstream error messages may contain conversation or account data. */
export const backgroundFailureCode = (error: unknown, fallback: string, knownCodes: readonly string[] = []): string => {
  if (error instanceof Error && knownCodes.includes(error.message)) return error.message;
  return providerFailureCode(error, fallback);
};
