package dev.deskpet.minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.exceptions.SimpleCommandExceptionType;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.command.argument.BlockPosArgumentType;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.text.Text;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.WorldSavePath;

public final class SnapshotCommand {
    private static final long MAX_VOLUME = 1_048_576L;

    private SnapshotCommand() {}

    static void register() {
        var name = CommandManager.argument("name", StringArgumentType.word()).executes(context ->
            write(context.getSource(), BlockPosArgumentType.getBlockPos(context, "from"),
                BlockPosArgumentType.getBlockPos(context, "to"), StringArgumentType.getString(context, "name")));
        var bounds = CommandManager.argument("from", BlockPosArgumentType.blockPos())
            .then(CommandManager.argument("to", BlockPosArgumentType.blockPos()).then(name));
        CommandRegistrationCallback.EVENT.register((dispatcher, access, environment) ->
            dispatcher.register(CommandManager.literal("deskpet").then(
                CommandManager.literal("debug").requires(source -> source.hasPermissionLevel(4))
                    .then(CommandManager.literal("snapshot").then(bounds)))));
    }

    private static int write(ServerCommandSource source, BlockPos from, BlockPos to, String name)
        throws com.mojang.brigadier.exceptions.CommandSyntaxException {
        var world = source.getWorld();
        long dx = Math.abs((long) from.getX() - to.getX()) + 1;
        long dy = Math.abs((long) from.getY() - to.getY()) + 1;
        long dz = Math.abs((long) from.getZ() - to.getZ()) + 1;
        if (!name.matches("[A-Za-z0-9_-]{1,64}")) throw error("Invalid snapshot name").create();
        if (dx > MAX_VOLUME || dy > MAX_VOLUME || dz > MAX_VOLUME
            || dx * dy > MAX_VOLUME || dx * dy * dz > MAX_VOLUME
            || world.isOutOfHeightLimit(from) || world.isOutOfHeightLimit(to)
            || !world.getWorldBorder().contains(from) || !world.getWorldBorder().contains(to)) {
            throw error("Invalid or excessive snapshot bounds").create();
        }

        var states = new JsonArray();
        for (var pos : BlockPos.iterate(from, to)) {
            var row = new JsonArray();
            row.add(pos.getX());
            row.add(pos.getY());
            row.add(pos.getZ());
            row.add(net.minecraft.command.argument.BlockArgumentParser.stringifyBlockState(world.getBlockState(pos)));
            states.add(row);
        }
        var snapshot = new JsonObject();
        snapshot.addProperty("dimension", world.getRegistryKey().getValue().toString());
        snapshot.add("blocks", states);
        byte[] bytes = snapshot.toString().getBytes(StandardCharsets.UTF_8);
        try {
            String sha256 = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
            var dir = source.getServer().getSavePath(WorldSavePath.ROOT).resolve("deskpet-snapshots");
            Files.createDirectories(dir);
            Files.write(dir.resolve(name + ".json"), bytes);
            Files.writeString(dir.resolve(name + ".sha256"), sha256 + "\n");
            source.sendFeedback(() -> Text.literal("snapshot " + name + " sha256=" + sha256), false);
        } catch (IOException | NoSuchAlgorithmException failure) {
            DeskPetMod.LOGGER.warn("Snapshot export failed", failure);
            throw error("Could not export snapshot").create();
        }
        return 1;
    }

    private static SimpleCommandExceptionType error(String message) {
        return new SimpleCommandExceptionType(Text.literal(message));
    }
}
