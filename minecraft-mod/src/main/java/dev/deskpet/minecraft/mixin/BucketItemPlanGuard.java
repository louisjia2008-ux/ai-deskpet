package dev.deskpet.minecraft.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import dev.deskpet.minecraft.plan.PlanInteraction;
import net.minecraft.fluid.Fluid;
import net.minecraft.item.BucketItem;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.World;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;

@Mixin(BucketItem.class)
abstract class BucketItemPlanGuard {
    @Shadow @Final private Fluid fluid;

    @WrapOperation(method = "placeFluid",
        at = @At(value = "INVOKE", target = "Lnet/minecraft/world/World;breakBlock(Lnet/minecraft/util/math/BlockPos;Z)Z"))
    private boolean deskpet$prepareFluidReplacement(World world, BlockPos pos, boolean drop, Operation<Boolean> original) {
        // A fluid bucket can remove a replaceable plant before writing the source block.
        PlanInteraction.prepareReplacement(world, pos, world.getFluidState(pos).getBlockState(),
            fluid.getDefaultState().getBlockState());
        return original.call(world, pos, drop);
    }
}
