package dev.deskpet.minecraft.mixin;

import dev.deskpet.minecraft.plan.PlanInteraction;
import net.minecraft.block.BlockState;
import net.minecraft.entity.Entity;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.World;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(World.class)
abstract class WorldPlanGuard {
    @Inject(method = "setBlockState(Lnet/minecraft/util/math/BlockPos;Lnet/minecraft/block/BlockState;II)Z",
        at = @At(value = "INVOKE", target = "Lnet/minecraft/world/chunk/WorldChunk;setBlockState(Lnet/minecraft/util/math/BlockPos;Lnet/minecraft/block/BlockState;I)Lnet/minecraft/block/BlockState;"))
    private void deskpet$beforeWrite(BlockPos pos, BlockState target, int flags, int updateDepth,
                                     CallbackInfoReturnable<Boolean> callback) {
        PlanInteraction.beforeWrite((World) (Object) this, pos, target);
    }

    @Inject(method = "breakBlock(Lnet/minecraft/util/math/BlockPos;ZLnet/minecraft/entity/Entity;I)Z", at = @At("HEAD"))
    private void deskpet$beforeBreak(BlockPos pos, boolean drop, Entity breaker, int updateDepth,
                                     CallbackInfoReturnable<Boolean> callback) {
        PlanInteraction.beforeBreak((World) (Object) this, pos);
    }
}
