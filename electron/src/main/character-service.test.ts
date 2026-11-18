import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type * as AtomicFile from './persistence/atomic-file';
vi.mock('electron', () => ({ dialog: {} }));
const positionFault = vi.hoisted(() => ({ wait: null as Promise<void> | null, entered: null as (() => void) | null }));
vi.mock('./persistence/atomic-file', async (importOriginal) => {
  const actual = await importOriginal<typeof AtomicFile>();
  return { ...actual, atomicWriteFile: async (...args: Parameters<typeof actual.atomicWriteFile>) => {
    if (args[0].endsWith('character-preferences.json') && positionFault.wait !== null) {
      const wait = positionFault.wait; positionFault.wait = null; positionFault.entered?.(); await wait;
    }
    return actual.atomicWriteFile(...args);
  } };
});
import { CharacterService } from './character-service';

describe('character commands', () => {
  it('gives each speech a new deadline and rejects a late close for an older bubble', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deskpet-bubble-'));
    try {
      const service = new CharacterService(root); await service.initialize();
      const now = new Date('2026-10-22T12:00:00Z');
      service.setBubble('Same words', now);
      const first = await service.getState();
      expect(first.bubbleExpiresAt).toBe('2026-10-22T12:01:00.000Z');
      service.setBubble('Same words', new Date(now.getTime() + 30_000));
      const second = await service.getState();
      expect(second.bubbleRevision).not.toBe(first.bubbleRevision);
      expect(second.bubbleExpiresAt).toBe('2026-10-22T12:01:30.000Z');
      expect(service.dismissBubble(first.bubbleRevision!)).toBe(false);
      expect((await service.getState()).bubble).toBe('Same words');
      expect(service.dismissBubble(second.bubbleRevision!)).toBe(true);
      expect(await service.getState()).toMatchObject({ bubble: null, bubbleExpiresAt: null });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rolls back a failed import to the prior model and preferences and ignores obsolete callbacks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deskpet-character-rollback-'));
    try {
      const zip = new JSZip();
      zip.file('kitty.model3.json', JSON.stringify({ Version: 3, FileReferences: { Moc: 'kitty.moc3', Textures: ['kitty.png'] } }));
      zip.file('kitty.moc3', 'moc'); zip.file('kitty.png', 'png'); zip.file('Watermark.exp3.json', '{}');
      const archive = join(root, 'kitty.zip'); await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
      const service = new CharacterService(join(root, 'managed')); await service.initialize();
      const first = await service.stageModelArchive(archive);
      await service.acknowledgeModelLoaded(first.pendingImportId!);
      await service.setExpression('Watermark'); await service.setScale(0.7);
      const prior = await service.getState();
      const failed = await service.stageModelArchive(archive);
      const restored = await service.modelLoadFailed(failed.pendingImportId!);
      expect(restored).toMatchObject({ modelUrl: prior.modelUrl, scale: 0.7, expression: 'Watermark', pendingImportId: null, importError: 'setup.restoredModel' });
      expect(await readdir(join(root, 'managed/models/.staging'))).toEqual([]);
      const newer = await service.stageModelArchive(archive);
      await service.modelLoadFailed(failed.pendingImportId!);
      await service.acknowledgeModelLoaded(failed.pendingImportId!);
      expect((await service.getState()).pendingImportId).toBe(newer.pendingImportId);
      await service.cancelImport(); await service.acknowledgeModelLoaded(newer.pendingImportId!);
      expect(await service.getState()).toMatchObject({ modelUrl: prior.modelUrl, expression: 'Watermark', pendingImportId: null });
      const reopened = new CharacterService(join(root, 'managed')); await reopened.initialize();
      expect(await reopened.getState()).toMatchObject({ modelUrl: prior.modelUrl, expression: 'Watermark', scale: 0.7 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('persists a model expression across restart and can restore its default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deskpet-character-expression-'));
    try {
      const zip = new JSZip();
      zip.file('kitty.model3.json', JSON.stringify({ Version: 3, FileReferences: { Moc: 'kitty.moc3', Textures: ['kitty.png'] } }));
      zip.file('kitty.moc3', 'moc'); zip.file('kitty.png', 'png'); zip.file('Watermark.exp3.json', '{}');
      const archive = join(root, 'kitty.zip'); await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
      const service = new CharacterService(join(root, 'managed')); await service.initialize();
      const pending = await service.stageModelArchive(archive);
      if (pending.pendingImportId === null) throw new Error('No pending model');
      await service.acknowledgeModelLoaded(pending.pendingImportId);
      await service.setExpression('Watermark');
      const restarted = new CharacterService(join(root, 'managed')); await restarted.initialize();
      expect(await restarted.getState()).toMatchObject({ expression: 'Watermark', expressions: ['Watermark'] });
      await expect(restarted.setExpression('Unknown')).rejects.toThrow('not available');
      await restarted.setExpression(null);
      expect(await restarted.getState()).toMatchObject({ expression: null });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('gives every repeated action its own revision and snapshots it before async reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deskpet-character-'));
    try {
      const service = new CharacterService(root); await service.initialize();
      service.setAction('greet'); const first = service.getState();
      service.setAction('greet'); const second = service.getState();
      expect(await first).toMatchObject({ action: 'greet', actionRevision: 1 });
      expect(await second).toMatchObject({ action: 'greet', actionRevision: 2 });
      await service.setScale(0.5);
      expect(await service.getState()).toMatchObject({ actionRevision: 2, scale: 0.5 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});


it('waits for delayed position and preference writes before the final snapshot and retains them across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-character-position-flush-'));
  let release!: () => void, entered!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const pending: Promise<unknown>[] = [];
  try {
    const service = new CharacterService(root); await service.initialize();
    positionFault.wait = delayed; positionFault.entered = entered;
    const position = { displayId: '7', x: 240, y: 160 }; pending.push(service.savePosition(position)); await started;
    expect(service.getPosition()).toEqual(position);
    pending.push(service.setScale(0.7)); let flushed = false;
    pending.push(service.flushPreferences().then(() => { flushed = true; }));
    await new Promise<void>(resolve => setTimeout(resolve, 15)); expect(flushed).toBe(false);
    release(); await Promise.all(pending);
    const restarted = new CharacterService(root); await restarted.initialize();
    expect(await restarted.getState()).toMatchObject({ position, scale: 0.7 });
    const clone = service.getPosition(); if (clone) clone.x = -999;
    expect(service.getPosition()).toEqual(position);
  } finally { positionFault.wait = null; positionFault.entered = null; release(); await Promise.allSettled(pending); await rm(root, { recursive: true, force: true }); }
});
