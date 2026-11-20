package dev.deskpet.minecraft.mixin;

import dev.deskpet.minecraft.plan.PlanService;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.dedicated.MinecraftDedicatedServer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

@Mixin(MinecraftDedicatedServer.class)
abstract class DedicatedConsolePlanReload {
    // Vanilla's stdin queue is separate from player, command block, function and RCON dispatch.
    @Redirect(method = "executeQueuedCommands", at = @At(value = "INVOKE",
        target = "Lnet/minecraft/server/command/CommandManager;executeWithPrefix(Lnet/minecraft/server/command/ServerCommandSource;Ljava/lang/String;)V"))
    private void deskpet$dispatchConsoleCommand(CommandManager manager, ServerCommandSource source, String command) {
        String normalized = command.strip();
        if (normalized.equals("deskpet planreload") || normalized.equals("/deskpet planreload")) {
            PlanService.reloadFromConsole(source.getServer());
            return;
        }
        manager.executeWithPrefix(source, command);
    }
}
