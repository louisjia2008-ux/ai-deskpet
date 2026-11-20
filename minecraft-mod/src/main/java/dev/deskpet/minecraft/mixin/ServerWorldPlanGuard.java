package dev.deskpet.minecraft.mixin;

import dev.deskpet.minecraft.plan.PlanInteraction;
import net.minecraft.entity.Entity;
import net.minecraft.server.world.ServerWorld;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(ServerWorld.class)
abstract class ServerWorldPlanGuard {
    @Inject(method = "spawnEntity", at = @At("RETURN"))
    private void deskpet$trackSpawn(Entity entity, CallbackInfoReturnable<Boolean> callback) {
        if (callback.getReturnValueZ()) PlanInteraction.afterSpawn((ServerWorld) (Object) this, entity);
    }
}
