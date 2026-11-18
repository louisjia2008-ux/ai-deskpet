import { describe, expect, it } from 'vitest';
import { authorizeIpcRequest } from '../../src/main/ipc-policy';

const base = { senderUrl: 'deskpet://app/main_window/index.html', senderRole: 'console' as const, allowedRoles: ['console'] as const, development: false };

describe('voice IPC', () => {
  it('takes only an on/off switch from the console; the folder comes from the host dialog, never the renderer', () => {
    const request = { ...base, channel: 'character:voice-update' as const, envelope: { version: 1, payload: { enabled: true } } };
    expect(authorizeIpcRequest(request)).toEqual({ enabled: true });
    for (const forged of [{ enabled: true, runtimeDir: '/tmp/evil' }, { runtimeDir: '/tmp/evil' }, { enabled: 'yes' }]) {
      expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: forged } })).toThrow();
    }
    expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...request, senderUrl: 'https://untrusted.example' })).toThrow('origin');
  });

  it('tests her voice with nothing to choose, so a renderer cannot make her say arbitrary text', () => {
    for (const channel of ['character:voice-test', 'character:voice-choose-folder', 'character:voice-get', 'character:voice-stop'] as const) {
      const request = { ...base, channel, envelope: { version: 1, payload: {} } };
      expect(authorizeIpcRequest(request)).toEqual({});
      expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { text: 'say this', runtimeDir: '/tmp' } } })).toThrow();
    }
  });
});
