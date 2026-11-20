package dev.deskpet.minecraft.mixin;

import dev.deskpet.minecraft.plan.PlayerBlocks;
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
        var protectedBlocks = PlayerBlocks.get(((ExplosionImpl) (Object) this).getWorld());
        // Chain explosions and beds can lose the player that triggered them.
        blocks.removeIf(protectedBlocks::contains);
        return blocks;
    }
}
