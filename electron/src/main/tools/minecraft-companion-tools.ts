import { z } from 'zod';
import {
  minecraftCompanionConfigSchema,
  minecraftCompanionPolicySchema,
  minecraftCompanionTaskSchema,
} from '../../shared/minecraft-companion';
import type {
  MinecraftCompanionConfig,
  MinecraftCompanionPolicy,
  MinecraftCompanionSnapshot,
  MinecraftCompanionTaskInput,
} from '../../shared/minecraft-companion';
import { ToolFailure } from '../runtime/tool-failure';
import type { ToolContext, ToolRegistry } from '../runtime/tool-registry';

export interface MinecraftCompanionToolService {
  getState(): MinecraftCompanionSnapshot;
  connect(config: MinecraftCompanionConfig, assertCurrent?: () => void): Promise<MinecraftCompanionSnapshot>;
  start(input: MinecraftCompanionTaskInput, assertCurrent?: () => void): Promise<MinecraftCompanionSnapshot>;
  cancel(): Promise<MinecraftCompanionSnapshot>;
  disconnect(): Promise<MinecraftCompanionSnapshot>;
  setPolicy(policy: MinecraftCompanionPolicy): Promise<Required<MinecraftCompanionPolicy>>;
}

export interface MinecraftCompanionToolDependencies {
  service: MinecraftCompanionToolService;
  /** True only for an interactive desktop run, never a scheduled or channel run. */
  isDesktop(runId: string): boolean;
}

/** Fixed basic-task surface; the shared schemas are also enforced by the host service. */
export function registerMinecraftCompanionTools(registry: ToolRegistry, dependencies: MinecraftCompanionToolDependencies): void {
  const empty = z.object({}).strict();
  const current = (context: ToolContext): void => {
    context.signal.throwIfAborted();
    context.assertAuthorized?.();
    if (!dependencies.isDesktop(context.runId)) throw new ToolFailure('tool.channelBlocked');
  };
  const execute = <T>(schema: z.ZodType<T>, work: (input: T, assertCurrent: () => void) => unknown | Promise<unknown>) =>
    async (input: unknown, context: ToolContext): Promise<unknown> => {
      const assertCurrent = () => current(context);
      assertCurrent();
      const parsed = schema.safeParse(input);
      if (!parsed.success) throw new ToolFailure('tool.invalidArguments');
      const result = await work(parsed.data, assertCurrent);
      assertCurrent();
      return result;
    };

  registry.register({
    id: 'minecraft.connect', title: 'Connect Minecraft Companion', capabilityId: 'minecraft.connect', risk: 'medium', sideEffect: true,
    description: 'Connect the basic Minecraft executor to the explicitly selected server and account. Interactive desktop only. The returned snapshot is authoritative; a request receipt does not prove the bot entered the world.',
    inputSchema: minecraftCompanionConfigSchema,
    execute: execute(minecraftCompanionConfigSchema, (input, assertCurrent) => dependencies.service.connect(input, assertCurrent)),
  });
  registry.register({
    id: 'minecraft.start', title: 'Start a basic Minecraft task', capabilityId: 'minecraft.control', risk: 'medium', sideEffect: true,
    description: 'Submit exactly one basic task: gatherLogs (at most 64; explores on foot if it cannot find nearby logs), gatherMaterials (explicit chest and only log/planks/stick/cobblestone), homestead (a starter house; with no parameters it finishes or repairs the house in observation.home when there is one; nearOwner=true builds it near where the owner player stands, which is what "here" or "near me" from the owner means; anchor is an exact corner; neither lets the bot pick near itself), farm, or followOwner (walk to the configured owner player, who must be within sight; stay=true keeps following and guards the owner, fighting hostile mobs near them and whatever hurts them, but never creepers, until minecraft.cancel, so cancel it before starting another task). Interactive desktop only. This returns dispatch acceptance, never proof of task completion, delivery or a completed building. Use minecraft.status for the actual task status; do not retry an uncertain submission automatically. No arbitrary commands, Nether or End tasks.',
    inputSchema: minecraftCompanionTaskSchema,
    execute: execute(minecraftCompanionTaskSchema, async (input, assertCurrent) => {
      try {
        return {
          dispatchOnly: true,
          message: 'The task request was submitted. This receipt alone does not prove completion; inspect snapshot.task.status and use minecraft.status for current progress.',
          snapshot: await dependencies.service.start(input, assertCurrent),
        };
      } catch (error) {
        // Refused before anything began (the owner out of sight for "build it
        // here"): an answer the model can pass on, rather than a failed run
        // that left the owner with only "tool.executionFailed" in game.
        const message = error instanceof Error ? error.message : '';
        if (!/^(The owner is not in sight|No owner player name is configured)$/.test(message)) throw error;
        return { started: false, reason: message, snapshot: dependencies.service.getState() };
      }
    }),
  });
  registry.register({
    id: 'minecraft.status', title: 'Read Minecraft task status', capabilityId: 'minecraft.read', risk: 'low', sideEffect: false,
    description: 'Read the current host snapshot with connection, task ID, actual task status, engine progress and observed world state. Interactive desktop only. Engine counters are not proof of delivery or a guessed completion percentage. An unknown state is not success. observation.home is the bot\'s house in this world (its corner; finished once built and furnished), remembered across connections.',
    inputSchema: empty,
    execute: execute(empty, () => dependencies.service.getState()),
  });
  registry.register({
    id: 'minecraft.policy', title: 'Set how the Minecraft bot weighs danger', capabilityId: 'minecraft.control', risk: 'low', sideEffect: true,
    description: 'Tune the bot\'s survival reflexes for the current situation; the bot reacts on its own within milliseconds, this only moves its lines. risk: cautious (backs off early, for gathering or building with poor gear), normal (default), bold (stays in fights it might lose, e.g. a well-armed bot or a dangerous escort). guard: self_first (default; a following bot stops guarding the owner below 8 health) or owner_first (while following, keeps guarding the owner down to 3 health and holds its ground against several mobs instead of backing off; pair with bold when the owner is in real danger). Kept until changed or disconnect. Use it when the owner asks for it, after the bot died, or when starting followOwner for an owner who asks to be protected or is under attack. Interactive desktop only.',
    inputSchema: minecraftCompanionPolicySchema,
    execute: execute(minecraftCompanionPolicySchema, async (input) => ({ policy: await dependencies.service.setPolicy(input) })),
  });
  registry.register({
    id: 'minecraft.cancel', title: 'Cancel the current Minecraft task', capabilityId: 'minecraft.control', risk: 'medium', sideEffect: true,
    description: 'Request cancellation of the current Minecraft task and return the actual host snapshot after retirement. Interactive desktop only. Do not announce cancelled until the returned task state confirms it. Timeout, failed or unknown retirement is not cancellation success.',
    inputSchema: empty,
    execute: execute(empty, () => dependencies.service.cancel()),
  });
  registry.register({
    id: 'minecraft.disconnect', title: 'Disconnect Minecraft Companion', capabilityId: 'minecraft.connect', risk: 'medium', sideEffect: true,
    description: 'Request that the Minecraft host retire activity and disconnect. Interactive desktop only. Report the returned snapshot; a failed or unknown cleanup is not a clean disconnection.',
    inputSchema: empty,
    execute: execute(empty, () => dependencies.service.disconnect()),
  });
}
