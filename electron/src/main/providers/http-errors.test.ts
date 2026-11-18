// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { safeProviderHttpErrorCode } from './http-errors';

describe('safe provider errors', () => {
  it('classifies null-code unsupported Responses parameters without exposing messages or values', () => {
    const error = { code: null, type: 'invalid_request_error', param: 'temperature', message: 'Unsupported parameter: temperature is not supported with this model. PRIVATE_SERVER_TEXT' };
    expect(safeProviderHttpErrorCode(400, { error })).toBe('provider.unsupportedParameter');
    expect(safeProviderHttpErrorCode(400, { error: { ...error, param: 'PRIVATE_PARAMETER' } })).toBe('provider.request');
    expect(safeProviderHttpErrorCode(400, { error: { ...error, message: 'Value out of range.' } })).toBe('provider.request');
    expect(safeProviderHttpErrorCode(401, { error })).toBe('provider.authentication');
    expect(safeProviderHttpErrorCode(429, { error: { code: 'insufficient_quota' } })).toBe('provider.quota');
  });
});
