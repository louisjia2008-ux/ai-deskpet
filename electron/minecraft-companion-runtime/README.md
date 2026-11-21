# DeskPet Minecraft Companion Core

Core is the Java Edition game helper used by DeskPet Electron. It manages the Mineflayer connection, world observation, physical actions and structured task lifecycle. The Electron main process calls it through a JSONL transport and retains control of permissions and provider access.

Run the Core fixture tests with `npm test`. The helper entry is `node index.js --data-dir /absolute/path`. DeskPet supplies the data directory and manages the helper lifecycle. It reports world readiness separately from process readiness. The application exposes supported tasks, task cancellation and observed world status. See [Core implementation notes](core/README.md) and the [DeskPet Minecraft guide](../docs/MINECRAFT_COMPANION.md).

See `COMPANION_SOURCE.json` for upstream provenance and file digests. Core is licensed under **AGPL-3.0-only**.
