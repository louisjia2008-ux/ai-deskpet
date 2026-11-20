package dev.deskpet.minecraft.plan;

import dev.deskpet.minecraft.wand.PlanCompiler;
import net.minecraft.block.BedBlock;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.DoorBlock;
import net.minecraft.block.TallPlantBlock;
import net.minecraft.block.enums.BedPart;
import net.minecraft.block.enums.DoubleBlockHalf;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.entity.Entity;
import net.minecraft.item.BlockItem;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NbtCompound;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.storage.NbtReadView;
import net.minecraft.util.ActionResult;
import net.minecraft.util.ErrorReporter;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.World;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * Attributes immediate block writes to the robot whose interaction is on the server stack.
 * Vanilla can ignore a failed setBlockState, so denial aborts the interaction itself.
 */
public final class PlanInteraction {
    private static final ThreadLocal<PlanInteraction> CURRENT = new ThreadLocal<>();

    private final ServerWorld world;
    private final ServerPlayerEntity player;
    private final String action;
    private final boolean custom;
    private final ItemStack[] inventory;
    private final LinkedHashMap<BlockPos, Original> writes = new LinkedHashMap<>();
    private final Map<BlockPos, Replacement> replacements = new LinkedHashMap<>();
    private final List<Entity> spawned = new ArrayList<>();
    private boolean denied;

    private record Original(BlockState state, NbtCompound blockEntity) {}
    private record Replacement(BlockState temporary, BlockState target) {}

    private static final class Denied extends RuntimeException {
        private Denied() {
            // Vanilla's nested neighbor updater may wrap this in a CrashException
            // before the interaction manager handles it, and needs a real stack trace.
            super("Survey plan denied the interaction");
        }
    }

    private PlanInteraction(ServerWorld world, ServerPlayerEntity player, ItemStack stack, String action) {
        this.world = world;
        this.player = player;
        this.action = stack.getItem() instanceof BlockItem ? "place" : action;
        this.custom = stack.contains(DataComponentTypes.BLOCK_STATE)
            || stack.contains(DataComponentTypes.BLOCK_ENTITY_DATA)
            || stack.contains(DataComponentTypes.CUSTOM_DATA);
        var slots = player.getInventory();
        inventory = new ItemStack[slots.size()];
        for (int slot = 0; slot < inventory.length; slot++) {
            inventory[slot] = slots.getStack(slot).copy();
        }
    }

    public static ActionResult run(World world, ServerPlayerEntity player, ItemStack stack, String action,
                                   Supplier<ActionResult> interaction) {
        if (!(world instanceof ServerWorld serverWorld) || !PlanService.guardsInteractions(player)) {
            return interaction.get();
        }
        var parent = CURRENT.get();
        if (parent != null && parent.world == world && parent.player == player) return interaction.get();

        var scope = new PlanInteraction(serverWorld, player, stack, action);
        CURRENT.set(scope);
        try {
            ActionResult result;
            try {
                result = interaction.get();
            } catch (RuntimeException error) {
                if (!causedByDenial(error)) throw error;
                result = ActionResult.FAIL;
            }
            // Undo and verification are outside the interaction that produced the writes.
            CURRENT.remove();
            if (scope.denied || scope.incompleteReplacement()) {
                scope.rollback();
                return ActionResult.FAIL;
            }
            scope.observe();
            return result;
        } finally {
            if (parent == null) CURRENT.remove();
            else CURRENT.set(parent);
        }
    }

    private static boolean causedByDenial(Throwable error) {
        for (Throwable cause = error; cause != null && cause != cause.getCause(); cause = cause.getCause()) {
            if (cause instanceof Denied) return true;
        }
        return false;
    }

    private static PlanInteraction current(World world) {
        var scope = CURRENT.get();
        return scope != null && scope.world == world ? scope : null;
    }

    public static Map<BlockPos, BlockState> footprint(BlockPos pos, BlockState state, BlockState replacement) {
        var targets = new LinkedHashMap<BlockPos, BlockState>();
        targets.put(pos, replacement == null ? state : replacement);
        if (state.getBlock() instanceof DoorBlock || state.getBlock() instanceof TallPlantBlock) {
            var half = state.get(DoorBlock.HALF);
            var other = half == DoubleBlockHalf.LOWER ? DoubleBlockHalf.UPPER : DoubleBlockHalf.LOWER;
            targets.put(half == DoubleBlockHalf.LOWER ? pos.up() : pos.down(),
                replacement == null ? state.with(DoorBlock.HALF, other) : replacement);
        } else if (state.getBlock() instanceof BedBlock) {
            var part = state.get(BedBlock.PART);
            var other = part == BedPart.FOOT ? BedPart.HEAD : BedPart.FOOT;
            var facing = state.get(BedBlock.FACING);
            targets.put(pos.offset(part == BedPart.FOOT ? facing : facing.getOpposite()),
                replacement == null ? state.with(BedBlock.PART, other) : replacement);
        }
        return targets;
    }

    public static void preflightPlacement(World world, BlockPos pos, BlockState target, boolean tall) {
        var scope = current(world);
        if (scope == null) return;
        var targets = footprint(pos, target, null);
        scope.check(pos, targets);
        var upper = pos.up();
        var upperTarget = targets.get(upper);
        if (tall && upperTarget != null) {
            // TallBlockItem temporarily clears the upper cell before placing either half.
            var temporary = (world.isWater(upper) ? Blocks.WATER : Blocks.AIR).getDefaultState();
            scope.replacements.put(upper, new Replacement(temporary, upperTarget));
        }
    }

    public static void prepareReplacement(World world, BlockPos pos, BlockState temporary, BlockState target) {
        var scope = current(world);
        if (scope == null) return;
        scope.check(pos, Map.of(pos, target));
        scope.replacements.put(pos.toImmutable(), new Replacement(temporary, target));
    }

    public static void beforeBreak(World world, BlockPos pos) {
        var scope = current(world);
        if (scope == null) return;
        var before = world.getBlockState(pos);
        if (!before.isAir()) scope.permit(pos, before, world.getFluidState(pos).getBlockState());
    }

    public static void beforeWrite(World world, BlockPos pos, BlockState target) {
        var scope = current(world);
        if (scope == null) return;
        var before = world.getBlockState(pos);
        if (before == target) return;
        scope.permit(pos, before, target);
        if (!scope.writes.containsKey(pos)) {
            var blockEntity = before.hasBlockEntity() ? world.getBlockEntity(pos) : null;
            var nbt = blockEntity == null ? null : blockEntity.createNbt(scope.world.getRegistryManager());
            scope.writes.put(pos.toImmutable(), new Original(before, nbt));
        }
    }

    public static void afterSpawn(ServerWorld world, Entity entity) {
        var scope = current(world);
        if (scope != null) scope.spawned.add(entity);
    }

    private void check(BlockPos origin, Map<BlockPos, BlockState> targets) {
        if (denied || !PlanService.allowInteraction(world, player, action, origin, targets, custom)) {
            denied = true;
            throw new Denied();
        }
    }

    private void permit(BlockPos pos, BlockState before, BlockState target) {
        if (PlanCompiler.isOpenToggle(before, target)) return;
        var replacement = replacements.get(pos);
        if (replacement != null && (target == replacement.temporary() || target == replacement.target())) return;
        check(pos, Map.of(pos, target));
    }

    private boolean incompleteReplacement() {
        return replacements.entrySet().stream().anyMatch(entry -> writes.containsKey(entry.getKey())
            && world.getBlockState(entry.getKey()) != entry.getValue().target());
    }

    private void observe() {
        var previous = new LinkedHashMap<BlockPos, BlockState>();
        writes.forEach((pos, original) -> {
            BlockState actual = world.getBlockState(pos);
            if (actual != original.state() && !PlanCompiler.isOpenToggle(original.state(), actual)) {
                previous.put(pos, original.state());
            }
        });
        if (!previous.isEmpty()) PlanService.observeInteraction(world, player, previous);
    }

    private void rollback() {
        // Restore prior writes without cascading new neighbor updates or dropping replaced blocks.
        int flags = Block.FORCE_STATE_AND_SKIP_CALLBACKS_AND_DROPS | Block.NOTIFY_LISTENERS;
        writes.reversed().forEach((pos, original) -> {
            if (world.getBlockState(pos) != original.state()) world.setBlockState(pos, original.state(), flags);
        });
        writes.forEach((pos, original) -> {
            if (original.blockEntity() == null) return;
            var entity = world.getBlockEntity(pos);
            if (entity != null) {
                entity.read(NbtReadView.create(ErrorReporter.EMPTY, world.getRegistryManager(), original.blockEntity()));
                world.markDirty(pos);
            }
        });
        spawned.forEach(Entity::discard);
        var slots = player.getInventory();
        for (int slot = 0; slot < inventory.length; slot++) {
            if (!ItemStack.areEqual(slots.getStack(slot), inventory[slot])) slots.setStack(slot, inventory[slot]);
        }
        player.currentScreenHandler.syncState();
    }
}
