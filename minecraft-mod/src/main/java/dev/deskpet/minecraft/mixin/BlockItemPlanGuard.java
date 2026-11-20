package dev.deskpet.minecraft.mixin;

import com.llamalad7.mixinextras.injector.wrapmethod.WrapMethod;
import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import dev.deskpet.minecraft.plan.PlanInteraction;
import net.minecraft.block.BlockState;
import dev.deskpet.minecraft.plan.PlanService;
import dev.deskpet.minecraft.plan.PlayerBlocks;
import net.minecraft.item.BlockItem;
import net.minecraft.item.ItemPlacementContext;
import net.minecraft.item.TallBlockItem;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.util.ActionResult;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

@Mixin(BlockItem.class)
abstract class BlockItemPlanGuard {
    @WrapMethod(method = "place(Lnet/minecraft/item/ItemPlacementContext;)Lnet/minecraft/util/ActionResult;")
    private ActionResult deskpet$rememberPlayerPlacement(ItemPlacementContext context, Operation<ActionResult> original) {
        if (!(context.getWorld() instanceof ServerWorld world)
            || !(context.getPlayer() instanceof ServerPlayerEntity player) || PlanService.isBot(player)) {
            return original.call(context);
        }
        var pos = ((BlockItem) (Object) this).getPlacementContext(context);
        var target = pos == null ? null : pos.getBlockPos();
        var before = target == null ? null : world.getBlockState(target);
        var result = original.call(context);
        if (target != null && result.isAccepted()) {
            var placed = world.getBlockState(target);
            if (placed != before && !placed.isAir()) {
                PlanInteraction.footprint(target, placed, null).forEach((cell, state) -> {
                    if (world.getBlockState(cell).isOf(state.getBlock())) PlayerBlocks.get(world).add(cell);
                });
            }
        }
        return result;
    }

    @WrapOperation(method = "place(Lnet/minecraft/item/ItemPlacementContext;)Lnet/minecraft/util/ActionResult;",
        at = @At(value = "INVOKE", target = "Lnet/minecraft/item/BlockItem;place(Lnet/minecraft/item/ItemPlacementContext;Lnet/minecraft/block/BlockState;)Z"))
    private boolean deskpet$checkFootprint(BlockItem item, ItemPlacementContext context, BlockState target,
                                           Operation<Boolean> original) {
        PlanInteraction.preflightPlacement(context.getWorld(), context.getBlockPos(), target, item instanceof TallBlockItem);
        return original.call(item, context, target);
    }
}
