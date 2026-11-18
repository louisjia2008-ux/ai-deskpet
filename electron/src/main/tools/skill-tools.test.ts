import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { SkillToolAccess, registerSkillTools } from './skill-tools';
import { DesktopToolCatalog } from '../runtime/desktop-tool-catalog';
import { ToolRegistry } from '../runtime/tool-registry';
import type { SkillCatalogEntry } from '../../shared/desktop-extensions';

const fixture = () => {
  const item = { id: randomUUID(), name: 'Fixture skill', description: 'A synthetic procedure.', digest: 'a'.repeat(64), revision: 1 };
  const assert = vi.fn(), read = vi.fn(() => ({ ...item, text: 'FIXTURE_SKILL_BODY' }));
  const localDesktop = vi.fn(() => true);
  const access = new SkillToolAccess({ localDesktop, catalog: () => [item], assert, read });
  return { item, assert, read, localDesktop, access };
};

it('loads only selected enabled text after a run-local catalog read and keeps it local', () => {
  const f = fixture();
  expect(() => f.access.read('run', f.item.id)).toThrow('tool.notRequested');
  const listed = f.access.list('run');
  expect(listed).toEqual({ skills: [f.item], privacy: 'local-only' });
  expect(JSON.stringify(listed)).not.toContain('FIXTURE_SKILL_BODY'); expect(f.read).not.toHaveBeenCalled();
  expect(f.access.read('run', f.item.id)).toEqual({ ...f.item, text: 'FIXTURE_SKILL_BODY', privacy: 'local-only', trust: 'reference-only' });
  expect(f.read).toHaveBeenCalledWith(f.item.id, f.item.digest, 1);
  f.access.assertCurrent('run'); expect(f.assert).toHaveBeenCalledWith(f.item.id, f.item.digest, 1);
  expect(() => f.access.read('different-run', f.item.id)).toThrow('tool.notRequested');
  f.access.release('run'); expect(() => f.access.read('run', f.item.id)).toThrow('tool.notRequested');
});

it('blocks cloud/phone access and invalidates used text when the owner changes or disables the skill', () => {
  const f = fixture(); f.localDesktop.mockReturnValue(false);
  expect(() => f.access.list('run')).toThrow('tool.contextPrivacyBlocked');
  expect(() => f.access.read('run', f.item.id)).toThrow('tool.contextPrivacyBlocked');
  expect(f.read).not.toHaveBeenCalled();
  f.localDesktop.mockReturnValue(true); f.access.list('run'); f.access.read('run', f.item.id);
  f.assert.mockImplementation(() => { throw new Error('extensions.changed'); });
  expect(f.access.invalidatedRuns()).toEqual(['run']);
  expect(() => f.access.assertCurrent('run')).toThrow('extensions.changed');
  expect(() => f.access.list('run')).toThrow('extensions.changed');
  expect(() => f.access.read('run', f.item.id)).toThrow('extensions.changed');
});

it('hides skill schemas behind discovery without loading any metadata or text', async () => {
  const f = fixture(), registry = new ToolRegistry(), catalog = new DesktopToolCatalog();
  registerSkillTools(registry, f.access);
  expect(catalog.describe(registry.describe()).map(tool => tool.id)).toEqual(['tools.discover']);
  await catalog.discovery.execute({ group: 'skills' }, { runId: 'run', taskId: 'call', signal: new AbortController().signal });
  expect(catalog.describe(registry.describe()).map(tool => tool.id)).toEqual(['skills.list', 'skills.read', 'tools.discover']);
  expect(f.read).not.toHaveBeenCalled(); expect(f.localDesktop).not.toHaveBeenCalled();
});

it('public discovery reveals only reviewed revisions and keeps web research available', async () => {
  const publicItem: SkillCatalogEntry = { id: randomUUID(), name: 'Public method', description: 'Check sources', digest: 'b'.repeat(64), revision: 3, exposure: 'public' };
  const privateItem: SkillCatalogEntry = { id: randomUUID(), name: 'PRIVATE_METHOD_NAME', description: 'PRIVATE_DESCRIPTION', digest: 'c'.repeat(64), revision: 1 };
  const assert = vi.fn(), read = vi.fn(() => ({ ...publicItem, text: 'Read the primary source.' }));
  const access = new SkillToolAccess({ desktop: () => true, localDesktop: () => false, catalog: () => [publicItem, privateItem], assert, read });
  const registry = new ToolRegistry(); registerSkillTools(registry, access);
  const listed = await registry.get('skills.list').execute({}, { runId: 'cloud', taskId: 'list', signal: new AbortController().signal });
  expect(listed).toEqual({ skills: [publicItem], privacy: 'cloud-allowed' });
  expect(JSON.stringify(listed)).not.toContain('PRIVATE');
  expect(access.read('cloud', publicItem.id)).toMatchObject({ privacy: 'cloud-allowed', trust: 'reference-only' });
  expect(access.isPrivateCall('cloud', 'skills.read', { id: publicItem.id })).toBe(false);
  expect(access.isPrivateCall('cloud', 'skills.read', { id: privateItem.id })).toBe(true);
  expect(() => access.list('cloud', 'local')).toThrow('tool.contextPrivacyBlocked');
  expect(() => access.read('cloud', privateItem.id)).toThrow('tool.notRequested');
  assert.mockImplementation(() => { throw new Error('extensions.changed'); });
  expect(access.invalidatedRuns()).toEqual(['cloud']);
  expect(() => access.read('cloud', publicItem.id)).toThrow('extensions.changed');
});

it('revoking a public catalog invalidates the run even before a body was read', () => {
  const item: SkillCatalogEntry = { id: randomUUID(), name: 'Public method', description: '', digest: 'd'.repeat(64), revision: 1, exposure: 'public' };
  let current = true;
  const access = new SkillToolAccess({ desktop: () => true, localDesktop: () => true, catalog: () => [item], assert: () => { if (!current) throw new Error('extensions.changed'); }, read: () => ({ ...item, text: 'method' }) });
  access.list('run', 'public'); current = false;
  expect(access.invalidatedRuns()).toEqual(['run']);
});
