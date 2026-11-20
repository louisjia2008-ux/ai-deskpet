package dev.deskpet.minecraft.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import dev.deskpet.minecraft.plan.PlanInteraction;
import net.minecraft.block.BlockState;
import net.minecraft.item.BlockItem;
import net.minecraft.item.ItemPlacementContext;
import net.minecraft.item.TallBlockItem;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

@Mixin(BlockItem.class)
abstract class BlockItemPlanGuard {
    @WrapOperation(method = "place(Lnet/minecraft/item/ItemPlacementContext;)Lnet/minecraft/util/ActionResult;",
        at = @At(value = "INVOKE", target = "Lnet/minecraft/item/BlockItem;place(Lnet/minecraft/item/ItemPlacementContext;Lnet/minecraft/block/BlockState;)Z"))
    private boolean deskpet$checkFootprint(BlockItem item, ItemPlacementContext context, BlockState target,
                                           Operation<Boolean> original) {
        PlanInteraction.preflightPlacement(context.getWorld(), context.getBlockPos(), target, item instanceof TallBlockItem);
        return original.call(item, context, target);
    }
}
