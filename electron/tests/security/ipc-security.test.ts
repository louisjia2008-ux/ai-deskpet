import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { authorizeIpcRequest, isKnownInvokeChannel } from '../../src/main/ipc-policy';

const valid = {
  channel: 'app:set-theme' as const,
  envelope: { version: 1, payload: { theme: 'dark' } },
  senderUrl: 'deskpet://app/main_window/index.html',
  senderRole: 'console' as const,
  allowedRoles: ['console'] as const,
  development: false,
};

describe('IPC security policy', () => {
  it('exposes usage as read-only and rejects removed budget and price mutation channels', () => {
    expect(isKnownInvokeChannel('usage:snapshot')).toBe(true);
    expect(isKnownInvokeChannel('usage:set-budget')).toBe(false);
    expect(isKnownInvokeChannel('usage:set-rate')).toBe(false);
  });

  it('bounds automation and REA IPC to console host-selected identities without raw tool arguments',()=>{
    const id='01234567-89ab-4def-8123-456789abcdef';
    for(const [channel,payload] of [
      ['automation:explicit-check-in',{operationId:id}],
      ['rea:choose-target',{sessionId:id}],
      ['rea:analyze',{sessionId:id,targetId:id}],
      ['rea:inspect',{sessionId:id,targetId:id,resultId:id,view:'boundaries'}],
    ] as const){
      const request={...valid,channel,envelope:{version:1,payload}};
      expect(authorizeIpcRequest(request)).toEqual(payload);
      expect(()=>authorizeIpcRequest({...request,senderRole:'overlay'})).toThrow('role');
      expect(()=>authorizeIpcRequest({...request,envelope:{version:1,payload:{...payload,input_path:'/arbitrary',tool:'spawn'}}})).toThrow();
    }
  });

  it('limits model changes to an enabled console operation with only a model identifier', () => {
    const id = '01234567-89ab-4def-8123-456789abcdef';
    const request = { ...valid, channel: 'providers:set-model' as const, envelope: { version: 1, payload: { id, model: 'local-model:latest' } } };
    expect(authorizeIpcRequest(request)).toEqual(request.envelope.payload);
    expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { ...request.envelope.payload, apiKey: 'not-accepted' } } })).toThrow();
    for (const model of ['', 'x'.repeat(241), 'bad\nmodel']) expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { id, model } } })).toThrow();
    const send = { ...valid, channel: 'chat:send' as const, envelope: { version: 1, payload: { sessionId: id, providerId: id, content: 'hello', model: 'chosen-at-send' } } };
    expect(authorizeIpcRequest(send)).toEqual(send.envelope.payload);
  });
  it('accepts a console-selected top-level diary destination and rejects renderer-supplied copy records', () => {
    const payload = { enabled: true, folder: '日记' };
    const request = { ...valid, channel: 'knowledge:set-diary-sync' as const, envelope: { version: 1, payload } };
    expect(authorizeIpcRequest(request)).toEqual(payload);
    expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...request, senderUrl: 'https://untrusted.example/' })).toThrow('origin');
    expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { ...payload, retainedInvalidDiaries: 42 } } })).toThrow();
    for (const folder of ['', '.cache', '..', '../outside', '/outside', 'nested/diary', 'nested\\diary', 'C:outside', 'bad\nname', 'x'.repeat(256)]) {
      expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { ...payload, folder } } })).toThrow();
    }
  });

  it('accepts only known channels and exact versioned payloads', () => {
    expect(isKnownInvokeChannel('app:get-state')).toBe(true);
    expect(isKnownInvokeChannel('electron:execute-anything')).toBe(false);
    expect(authorizeIpcRequest(valid)).toEqual({ theme: 'dark' });
    expect(() => authorizeIpcRequest({ ...valid, envelope: { version: 1, payload: { theme: 'dark', extra: true } } })).toThrow();
  });

  it('rejects the wrong origin and window role', () => {
    expect(() => authorizeIpcRequest({ ...valid, senderUrl: 'https://attacker.example/' })).toThrow('origin');
    expect(() => authorizeIpcRequest({ ...valid, senderRole: 'overlay' })).toThrow('role');
  });

  it('limits companion preview to console requests without arbitrary capture targets', () => {
    const request = { ...valid, channel: 'character:get-preview' as const, envelope: { version: 1, payload: {} } };
    expect(authorizeIpcRequest(request)).toEqual({});
    expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { windowId: 42, screen: true } } })).toThrow();
  });

  it('restricts Minecraft controls to the console with strict schemas', () => {
    const request = { ...valid, channel: 'minecraft:control' as const, envelope: { version: 1, payload: { action: 'stop' } } };
    expect(authorizeIpcRequest(request)).toEqual({ action: 'stop' });
    expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...request, senderUrl: 'https://server.example/' })).toThrow('origin');
    expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { action: 'stop', shell: true } } })).toThrow();
  });

  it('rejects an oversized payload before schema dispatch', () => {
    expect(() => authorizeIpcRequest({ ...valid, envelope: { version: 1, payload: { theme: 'dark', padding: 'x'.repeat(300_000) } } })).toThrow('size');
  });

  it('limits chat memory choices to a console request with exact message and memory IDs', () => {
    const id = '01234567-89ab-4def-8123-456789abcdef';
    const request = { ...valid, channel: 'chat:forget-memory' as const, envelope: { version: 1, payload: { messageId: id, memoryId: id } } };
    expect(authorizeIpcRequest(request)).toEqual(request.envelope.payload);
    expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { messageId: id, memoryId: id, all: true, query: '*' } } })).toThrow();
    expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { messageId: id, memoryId: '*' } } })).toThrow();
  });

  it('limits conversation management to validated console requests and rejects arbitrary deletion modes', () => {
    const id = '01234567-89ab-4def-8123-456789abcdef';
    const remove = { ...valid, channel: 'chat:remove-session' as const, envelope: { version: 1, payload: { id } } };
    expect(authorizeIpcRequest(remove)).toEqual({ id });
    expect(() => authorizeIpcRequest({ ...remove, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...remove, envelope: { version: 1, payload: { id, permanent: true, all: true } } })).toThrow();
    const rename = { ...valid, channel: 'chat:rename-session' as const, envelope: { version: 1, payload: { id, title: '  Saved title  ' } } };
    expect(authorizeIpcRequest(rename)).toEqual({ id, title: 'Saved title' });
    expect(() => authorizeIpcRequest({ ...rename, envelope: { version: 1, payload: { id, title: '  ' } } })).toThrow();
    const list = { ...valid, channel: 'chat:list-sessions' as const, envelope: { version: 1, payload: { scope: 'deleted', query: 'test' } } };
    expect(authorizeIpcRequest(list)).toEqual({ scope: 'deleted', query: 'test' });
    expect(() => authorizeIpcRequest({ ...list, envelope: { version: 1, payload: { scope: 'filesystem', path: '/' } } })).toThrow();
  });

  it('restricts memory editing to a stored choice and imports to selected files and exact review inputs', () => {
    const id = '01234567-89ab-4def-8123-456789abcdef';
    const edit = { ...valid, channel: 'chat:edit-memory' as const, envelope: { version: 1, payload: { messageId: id, memoryId: id } } };
    expect(authorizeIpcRequest(edit)).toEqual(edit.envelope.payload);
    expect(() => authorizeIpcRequest({ ...edit, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...edit, envelope: { version: 1, payload: { ...edit.envelope.payload, replacement: 'renderer override' } } })).toThrow();
    const picker = { ...valid, channel: 'imports:pick-file' as const, envelope: { version: 1, payload: {} } };
    expect(authorizeIpcRequest(picker)).toEqual({});
    expect(() => authorizeIpcRequest({ ...picker, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...picker, envelope: { version: 1, payload: { path: '/etc/hosts' } } })).toThrow();
    const apply = { ...valid, channel: 'imports:apply' as const, envelope: { version: 1, payload: { id, draftId: id, memories: [{ id, text: 'Reviewed fact' }], applyStyle: false } } };
    expect(authorizeIpcRequest(apply)).toEqual(apply.envelope.payload);
    expect(() => authorizeIpcRequest({ ...apply, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...apply, envelope: { version: 1, payload: { ...apply.envelope.payload, autoApprove: true } } })).toThrow();
  });

  it('limits model failure reports to the overlay and timer cancellation to the console', () => {
    const importId = '01234567-89ab-4def-8123-456789abcdef';
    const failed = { ...valid, channel: 'character:model-load-failed' as const, senderRole: 'overlay' as const, allowedRoles: ['overlay'] as const, senderUrl: 'deskpet://app/overlay_window/index.html', envelope: { version: 1, payload: { importId } } };
    expect(authorizeIpcRequest(failed)).toEqual({ importId });
    expect(() => authorizeIpcRequest({ ...failed, senderRole: 'console' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...failed, envelope: { version: 1, payload: { importId, path: '/etc/hosts' } } })).toThrow();
    const timer = { ...valid, channel: 'timers:cancel' as const, envelope: { version: 1, payload: { id: importId } } };
    expect(authorizeIpcRequest(timer)).toEqual({ id: importId });
    expect(() => authorizeIpcRequest({ ...timer, senderRole: 'overlay' })).toThrow('role');
  });

  it('requires the console and a password, with no renderer-selected backup filesystem paths', () => {
    const request = { ...valid, channel: 'backup:create' as const, envelope: { version: 1, payload: { password: 'fixture-password' } } };
    expect(authorizeIpcRequest(request)).toEqual({ password: 'fixture-password' });
    expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { password: 'fixture-password', path: '/etc/hosts' } } })).toThrow();
  });

  it('keeps the preload bridge narrow and excludes generic Electron send/invoke exposure', async () => {
    const preload = await readFile(join(process.cwd(), 'src/preload/index.ts'), 'utf8');
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer/s);
    expect(preload).not.toContain('ipcRenderer.send(');
    expect(preload).not.toContain('shell.openExternal');
  });

  it('restricts recovery to fixed snapshot IDs and backup passwords rather than renderer paths', () => {
    const request = { ...valid, channel: 'recovery:restore-snapshot' as const, envelope: { version: 1, payload: { id: '01234567-89ab-4def-8123-456789abcdef' } } };
    expect(authorizeIpcRequest(request)).toEqual(request.envelope.payload);
    expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { id: '../outside' } } })).toThrow();
    expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { id: request.envelope.payload.id, path: '/etc/hosts' } } })).toThrow();
  });

  it('ships a restrictive CSP in both renderer documents', async () => {
    for (const role of ['console', 'overlay']) {
      const html = await readFile(join(process.cwd(), `src/renderer/${role}/index.html`), 'utf8');
      expect(html).toContain("default-src 'self'");
      expect(html).toContain("object-src 'none'");
      expect(html).toContain("form-action 'none'");
      expect(html).not.toContain("script-src 'unsafe-inline'");
    }
  });
});

it('accepts only bounded proactive preferences from the console and no timing overrides', () => {
  const request = { channel: 'proactive:configure' as const, envelope: { version: 1, payload: { enabled: true, frequency: 'occasional' } }, senderUrl: 'deskpet://app/main_window/index.html', senderRole: 'console' as const, allowedRoles: ['console'] as const, development: false };
  expect(authorizeIpcRequest(request)).toEqual(request.envelope.payload);
  expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
  expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { enabled: true, frequency: 'occasional', nextAt: 0 } } })).toThrow();
});
