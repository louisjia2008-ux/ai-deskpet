package dev.deskpet.minecraft.mixin;

import com.llamalad7.mixinextras.injector.wrapmethod.WrapMethod;
import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import dev.deskpet.minecraft.plan.PlanInteraction;
import net.minecraft.item.ItemStack;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.network.ServerPlayerInteractionManager;
import net.minecraft.util.ActionResult;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.world.World;
import org.spongepowered.asm.mixin.Mixin;

@Mixin(ServerPlayerInteractionManager.class)
abstract class ServerInteractionPlanGuard {
    @WrapMethod(method = "interactBlock")
    private ActionResult deskpet$interactBlock(ServerPlayerEntity player, World world, ItemStack stack, Hand hand,
                                               BlockHitResult hit, Operation<ActionResult> original) {
        return PlanInteraction.run(world, player, stack, "interact_block", () -> original.call(player, world, stack, hand, hit));
    }

    @WrapMethod(method = "interactItem")
    private ActionResult deskpet$interactItem(ServerPlayerEntity player, World world, ItemStack stack, Hand hand,
                                              Operation<ActionResult> original) {
        return PlanInteraction.run(world, player, stack, "interact_item", () -> original.call(player, world, stack, hand));
    }
}
