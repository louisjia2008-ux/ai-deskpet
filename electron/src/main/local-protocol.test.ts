import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ register: vi.fn(), handle: vi.fn(), fetch: vi.fn() }));
vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: fixture.register, handle: fixture.handle }, net: { fetch: fixture.fetch } }));
import { installLocalProtocol, registerDeskPetScheme } from './local-protocol';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); vi.clearAllMocks(); });
describe('managed Live2D protocol', () => {
  it('supports CORS but permits asset reads only from the app origin', async () => {
    registerDeskPetScheme();
    expect(fixture.register).toHaveBeenCalledWith([expect.objectContaining({ scheme: 'deskpet', privileges: expect.objectContaining({ corsEnabled: true, secure: true }) })]);
    const root = await mkdtemp(join(tmpdir(), 'deskpet-protocol-')); roots.push(root);
    await mkdir(join(root, 'models'), { recursive: true });
    await writeFile(join(root, 'models', 'avatar.model3.json'), '{}');
    await writeFile(join(root, 'models', 'unexpected.js'), 'bad');
    fixture.fetch.mockImplementation(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
    await installLocalProtocol(root);
    const handler = fixture.handle.mock.calls[0]?.[1] as (request: { url: string }) => Promise<Response>;
    const allowed = await handler({ url: 'deskpet://managed/models/avatar.model3.json' });
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('deskpet://app');
    expect(allowed.headers.get('Content-Type')).toBe('application/json');
    expect(await allowed.text()).toBe('{}');
    expect((await handler({ url: 'deskpet://managed/models/unexpected.js' })).status).toBe(403);
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });
});
