/* global process */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shareMinecraftDependencies } from './minecraft-shared-dependencies.mjs';

const result = await shareMinecraftDependencies(dirname(dirname(fileURLToPath(import.meta.url))));
process.stdout.write(`Minecraft dependencies shared after exact lock/byte validation: ${JSON.stringify(result)}\n`);
