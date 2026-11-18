import { describe, expect, it } from 'vitest';
import { minecraftCompanionConfigSchema, minecraftCompanionTaskSchema } from './minecraft-companion';

const config = { host: '127.0.0.1', port: 25565, username: 'DeskPet', auth: 'offline', version: '1.21.8' };

describe('Minecraft Companion basic input contract', () => {
  it('accepts explicit connection settings and Microsoft account names', () => {
    expect(minecraftCompanionConfigSchema.parse(config)).toEqual(config);
    expect(minecraftCompanionConfigSchema.safeParse({ ...config, auth: 'microsoft', username: 'player@example.invalid', version: 'auto' }).success).toBe(true);
  });
  it('rejects provider credentials, malformed endpoints and offline names', () => {
    for (const patch of [{ host: 'http://localhost' }, { port: 0 }, { username: 'two words' }, { version: false }, { apiKey: 'secret' }]) {
      expect(minecraftCompanionConfigSchema.safeParse({ ...config, ...patch }).success).toBe(false);
    }
  });
  it('supports logs, low tier chest delivery, a home and a small farm with strict parameters', () => {
    for (const task of [
      { name: 'gatherLogs', parameters: { count: 3 } },
      { name: 'gatherMaterials', parameters: { chest: { x: 2, y: 64, z: -3 }, requirements: [{ key: 'cobblestone', count: 16 }] } },
      { name: 'homestead', parameters: {} }, { name: 'farm', parameters: { plots: 4, bread: 1 } },
    ]) expect(minecraftCompanionTaskSchema.safeParse(task).success).toBe(true);
  });
  it('does not expose arbitrary goals, code, unbounded work or delivery without a destination', () => {
    for (const task of [
      { name: 'netherQuartz', parameters: {} }, { name: 'outfit', parameters: {} },
      { name: 'gatherLogs', parameters: { count: 65 } }, { name: 'gatherLogs', parameters: { count: 2, code: 'run()' } },
      { name: 'gatherMaterials', parameters: { requirements: [{ key: 'cobblestone', count: 1 }] } },
      { name: 'gatherMaterials', parameters: { chest: { x: 1.2, y: 64, z: 1 }, requirements: [{ key: 'diamond', count: 1 }] } },
      { name: 'farm', parameters: { plots: 17 } },
    ]) expect(minecraftCompanionTaskSchema.safeParse(task).success).toBe(false);
  });
});
