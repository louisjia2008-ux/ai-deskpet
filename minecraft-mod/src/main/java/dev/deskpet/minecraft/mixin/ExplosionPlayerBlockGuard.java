package dev.deskpet.minecraft.mixin;

import dev.deskpet.minecraft.plan.PlanService;
import dev.deskpet.minecraft.plan.PlayerBlocks;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.explosion.ExplosionImpl;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;

import java.util.List;

@Mixin(ExplosionImpl.class)
abstract class ExplosionPlayerBlockGuard {
    @ModifyVariable(method = "destroyBlocks", at = @At("HEAD"), argsOnly = true)
    private List<BlockPos> deskpet$keepPlayerBlocks(List<BlockPos> blocks) {
        var explosion = (ExplosionImpl) (Object) this;
        var causing = explosion.getCausingEntity();
        var attacker = explosion.getDamageSource().getAttacker();
        if (causing instanceof ServerPlayerEntity player && !PlanService.isBot(player)
            || causing == null && attacker instanceof ServerPlayerEntity direct && !PlanService.isBot(direct)) {
            return blocks;
        }
        // Delayed, chained and bed explosions can lose their originating player.
        var protectedBlocks = PlayerBlocks.get(explosion.getWorld());
        blocks.removeIf(pos -> protectedBlocks.deny(pos, "explosion"));
        return blocks;
    }
}
