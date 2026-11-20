package dev.deskpet.minecraft.plan;

import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.exceptions.SimpleCommandExceptionType;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.server.command.CommandManager;
import net.minecraft.text.Text;
import net.minecraft.util.WorldSavePath;

import java.io.IOException;
import java.nio.file.Files;
import java.util.UUID;

final class PlanDebugCommands {
    private static final SimpleCommandExceptionType UNKNOWN_PLAN = new SimpleCommandExceptionType(Text.literal("Unknown survey plan"));
    private static final SimpleCommandExceptionType EXPORT_ERROR = new SimpleCommandExceptionType(Text.literal("Failed to export survey plan state"));

    private PlanDebugCommands() {}

    static void register() {
        CommandRegistrationCallback.EVENT.register((dispatcher, access, environment) -> {
            var debug = CommandManager.literal("debug").requires(source -> source.hasPermissionLevel(4));
            debug.then(CommandManager.literal("plans").executes(context -> {
                var source = context.getSource();
                var server = source.getServer();
                try {
                    var directory = server.getSavePath(WorldSavePath.ROOT).resolve("deskpet-debug");
                    Files.createDirectories(directory);
                    Files.writeString(directory.resolve("plans.json"), PlanStore.get(server).export().toString());
                    source.sendFeedback(() -> Text.literal("survey plan state exported"), false);
                    return 1;
                } catch (IOException error) {
                    throw EXPORT_ERROR.create();
                }
            }));

            // Expiry and cross-dimension fixtures are available only in an explicitly
            // marked test process. The confirm fixture uses exactly the menu handler.
            if ("1".equals(System.getenv("DESKPET_TEST_FIXTURES"))) {
                debug.then(CommandManager.literal("expire").then(CommandManager.argument("plan", StringArgumentType.word())
                    .executes(context -> {
                        var store = PlanStore.get(context.getSource().getServer());
                        var plan = store.plans.get(id(StringArgumentType.getString(context, "plan")));
                        if (plan == null || plan.status != SurveyPlan.Status.PREVIEWED) throw UNKNOWN_PLAN.create();
                        plan.status = SurveyPlan.Status.EXPIRED;
                        plan.reason = "preview_expired";
                        store.markDirty();
                        context.getSource().sendFeedback(() -> Text.literal("survey plan preview expired"), false);
                        return 1;
                    })));
                debug.then(CommandManager.literal("confirm").then(CommandManager.argument("plan", StringArgumentType.word())
                    .executes(context -> {
                        var source = context.getSource();
                        var result = PlanService.confirm(source.getPlayerOrThrow(), id(StringArgumentType.getString(context, "plan")));
                        source.sendFeedback(() -> Text.literal(result), false);
                        return 1;
                    })));
            }
            dispatcher.register(CommandManager.literal("deskpet").then(debug));
        });
    }

    private static UUID id(String raw) throws com.mojang.brigadier.exceptions.CommandSyntaxException {
        try {
            return UUID.fromString(raw);
        } catch (IllegalArgumentException invalid) {
            throw UNKNOWN_PLAN.create();
        }
    }
}
