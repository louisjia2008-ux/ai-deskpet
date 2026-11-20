package dev.deskpet.minecraft.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import com.llamalad7.mixinextras.sugar.Share;
import com.llamalad7.mixinextras.sugar.ref.LocalRef;
import dev.deskpet.minecraft.plan.PlanService;
import net.minecraft.block.BlockState;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.item.BlockItem;
import net.minecraft.item.ItemPlacementContext;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.util.ActionResult;
import net.minecraft.util.math.BlockPos;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import java.util.Map;

@Mixin(BlockItem.class)
public abstract class BlockItemPlanGuard {
    @WrapOperation(method = "place(Lnet/minecraft/item/ItemPlacementContext;)Lnet/minecraft/util/ActionResult;",
        at = @At(value = "INVOKE", target = "Lnet/minecraft/item/BlockItem;place(Lnet/minecraft/item/ItemPlacementContext;Lnet/minecraft/block/BlockState;)Z"))
    private boolean deskpet$checkPlacement(BlockItem item, ItemPlacementContext context, BlockState target,
                                            Operation<Boolean> place, @Share("deskpetChanges") LocalRef<Map<BlockPos, String>> previous) {
        if (context.getWorld() instanceof ServerWorld world && context.getPlayer() instanceof ServerPlayerEntity player) {
            boolean custom = context.getStack().contains(DataComponentTypes.BLOCK_STATE)
                || context.getStack().contains(DataComponentTypes.BLOCK_ENTITY_DATA);
            var changes = PlanService.checkPlacement(world, player, context.getBlockPos(), target, custom);
            if (changes == null) return false;
            previous.set(changes);
        }
        return place.call(item, context, target);
    }

    @Inject(method = "place(Lnet/minecraft/item/ItemPlacementContext;)Lnet/minecraft/util/ActionResult;",
        at = @At("RETURN"))
    private void deskpet$observePlacement(ItemPlacementContext context, CallbackInfoReturnable<ActionResult> result,
                                          @Share("deskpetChanges") LocalRef<Map<BlockPos, String>> previous) {
        var changes = previous.get();
        if (changes != null && !changes.isEmpty() && result.getReturnValue().isAccepted()
            && context.getWorld() instanceof ServerWorld world && context.getPlayer() instanceof ServerPlayerEntity player) {
            PlanService.observePlacement(world, player, changes);
        }
    }
}
