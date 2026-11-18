import { describe, expect, it } from 'vitest';
import { providerSetupFailureText } from './provider-setup-failure';

describe('safe provider setup diagnostics', () => {
  it.each(['provider.authentication', 'provider.permissionDenied', 'provider.network', 'provider.timeout', 'provider.quota', 'provider.rateLimit', 'provider.limitUnknown', 'provider.catalogInvalid'])('preserves only allowlisted exact code %s across the expected Electron envelope', (code) => {
    const bare = providerSetupFailureText(new Error(code), 'providers:discover-models', 'zh-CN');
    expect(bare).toContain(code);
    expect(providerSetupFailureText(new Error(`Error invoking remote method 'providers:discover-models': Error: ${code}`), 'providers:discover-models', 'zh-CN')).toBe(bare);
    expect(providerSetupFailureText({ code, message: 'PRIVATE_SERVER_BODY' }, 'providers:discover-models', 'en')).not.toContain('PRIVATE_SERVER_BODY');
  });
  it.each([
    "Error invoking remote method 'providers:upsert': Error: provider.authentication",
    "Error invoking remote method 'providers:discover-models': Error: provider.authentication PRIVATE_SERVER_BODY",
    "Error invoking remote method 'providers:discover-models': Error: provider.authentication\nPRIVATE_SERVER_BODY",
    "PRIVATE_SERVER_BODY provider.authentication",
    'provider.unknown_PRIVATE_SERVER_BODY',
  ])('never reflects an arbitrary body or accepts the wrong channel: %s', (message) => {
    const text = providerSetupFailureText(new Error(message), 'providers:discover-models', 'zh-CN');
    expect(text).not.toContain('PRIVATE_SERVER_BODY');
    expect(text).not.toContain('provider.authentication');
    expect(text).toContain('无法读取模型列表');
  });
  it('distinguishes an unconfirmed local save from an upstream catalog failure', () => {
    expect(providerSetupFailureText(new Error('PRIVATE_STORAGE_DIAGNOSTIC'), 'providers:upsert', 'zh-CN')).toContain('本机加密存储');
    expect(providerSetupFailureText(new Error('PRIVATE_STORAGE_DIAGNOSTIC'), 'providers:upsert', 'zh-CN')).not.toContain('PRIVATE_STORAGE_DIAGNOSTIC');
  });
});
