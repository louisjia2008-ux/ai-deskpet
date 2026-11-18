import { describe, expect, it } from 'vitest';

import { providerFailureCode } from './provider-errors';

describe('provider failure codes across process boundaries', () => {
  it('preserves known HTTP and utility error codes and identifies timeouts', () => {
    expect(providerFailureCode({ code: 'provider.quota', message: 'upstream private body' })).toBe('provider.quota');
    expect(providerFailureCode(new Error('provider.authentication'))).toBe('provider.authentication');
    expect(providerFailureCode(new Error('provider.budgetExceeded'))).toBe('provider.budgetExceeded');
    expect(providerFailureCode(new DOMException('private timeout details', 'TimeoutError'))).toBe('provider.timeout');
  });

  it('uses a safe fallback for unknown errors without forwarding upstream details', () => {
    expect(providerFailureCode(new Error('secret upstream response'), 'chat.runFailed')).toBe('chat.runFailed');
    expect(providerFailureCode({ code: 'secret upstream response' })).toBe('provider.failed');
    expect(providerFailureCode(null, 'provider.cancelled')).toBe('provider.cancelled');
  });

  it.each(['provider.permissionDenied', 'provider.network', 'provider.catalogInvalid', 'provider.limitUnknown'])('keeps safe catalog category %s across utility IPC', (code) => {
    expect(providerFailureCode(new Error(code))).toBe(code);
    expect(providerFailureCode({ code, message: 'PRIVATE_BODY' })).toBe(code);
  });
});
