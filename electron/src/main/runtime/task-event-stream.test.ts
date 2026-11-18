// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TaskEventStream } from './task-event-stream';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it('pages from stable event IDs across new appends, and preserves corruption recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-events-page-')); roots.push(root);
  const path = join(root, 'events.jsonl'); const stream = new TaskEventStream(path); await stream.initialize();
  const run = randomUUID();
  for (let i = 0; i < 5; i++) await stream.emit(run, 'state', 'running', String(i));
  const first = await stream.readPage({ limit: 2 });
  expect(first.map(event => event.summary)).toEqual(['3', '4']);
  await stream.emit(run, 'state', 'succeeded', '5');
  expect((await stream.readPage({ limit: 2, beforeId: first[0]!.id })).map(event => event.summary)).toEqual(['1', '2']);
  expect(await stream.readPage({ beforeId: randomUUID() })).toEqual([]);
  await expect(stream.readPage({ limit: 201 })).rejects.toThrow('events.invalidPage');
  await appendFile(path, '{broken\n');
  expect((await stream.readPage()).map(event => event.summary)).toEqual(['0', '1', '2', '3', '4', '5']);
  expect(await stream.readAll()).toHaveLength(6);
});
