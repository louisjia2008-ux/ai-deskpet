import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { MinecraftOfflineModelBudget } from './offline-model-budget';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('enforces a persistent daily allowance across concurrent provider attempts and a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deskpet-model-budget-'));
  paths.push(directory);
  const path = join(directory, 'usage.json');
  let day = new Date(2026, 10, 20, 12);
  const offline = () => ({ presence: 'offline' as const, reason: 'task_failure' as const, limit: 20 });
  const budget = new MinecraftOfflineModelBudget(path, () => day);
  await budget.initialize();
  const attempts = await Promise.allSettled(Array.from({ length: 25 }, () => budget.reserve(offline)));
  expect(attempts.map(attempt => attempt.status)).toEqual([...Array(20).fill('fulfilled'), ...Array(5).fill('rejected')]);
  const reopened = new MinecraftOfflineModelBudget(path, () => day);
  await reopened.initialize();
  expect(reopened.used()).toBe(20);
  await expect(reopened.reserve(offline)).rejects.toThrow('minecraft.model.daily_limit');
  const online = await reopened.reserve(() => ({ ...offline(), presence: 'online' }));
  expect(online).toBeNull();
  expect(() => reopened.assertReserved(online, offline())).toThrow('minecraft.model.presence_changed');
  expect(reopened.used()).toBe(20);
  day = new Date(2026, 10, 21, 12);
  expect(reopened.used()).toBe(0);
  await expect(reopened.reserve(() => ({ ...offline(), reason: 'task_completed' }))).rejects.toThrow('minecraft.model.owner_offline');
  await expect(reopened.reserve(() => ({ ...offline(), reason: 'player_chat' }))).rejects.toThrow('minecraft.model.owner_offline');
  const death = await reopened.reserve(() => ({ ...offline(), reason: 'death' }));
  expect(() => reopened.assertReserved(death, offline())).not.toThrow();
  expect(() => reopened.assertReserved(death, { ...offline(), limit: 0 })).toThrow('minecraft.model.daily_limit');
  expect(reopened.used()).toBe(1);
});
