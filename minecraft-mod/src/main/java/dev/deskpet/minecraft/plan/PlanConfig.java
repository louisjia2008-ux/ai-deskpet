package dev.deskpet.minecraft.plan;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;

record PlanConfig(boolean enabled, UUID ownerUuid, UUID botUuid, String botName) {
    static PlanConfig read() throws IOException {
        var file = FabricLoader.getInstance().getConfigDir().resolve("deskpet-plan.json");
        if (!Files.exists(file)) {
            Files.createDirectories(file.getParent());
            var example = new JsonObject();
            example.addProperty("enabled", false);
            example.addProperty("ownerUuid", "");
            example.addProperty("botUuid", "");
            example.addProperty("botName", "DeskPetBot");
            Files.writeString(file, new GsonBuilder().setPrettyPrinting().create().toJson(example) + "\n");
        }
        var config = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
        return parse(config);
    }

    static PlanConfig parse(JsonObject config) {
        var switchValue = config.get("enabled");
        if (switchValue != null && (!switchValue.isJsonPrimitive() || !switchValue.getAsJsonPrimitive().isBoolean())) {
            throw new IllegalArgumentException("Plan authorization switch must be a boolean");
        }
        boolean enabled = switchValue != null && switchValue.getAsBoolean();
        UUID owner = uuid(config, "ownerUuid");
        UUID bot = uuid(config, "botUuid");
        String name = string(config, "botName");
        if (enabled && (owner == null || (bot == null && !name.matches("[A-Za-z0-9_]{1,16}")))) {
            throw new IllegalArgumentException("Plan authorization needs an owner UUID and a bot UUID or player name");
        }
        if (owner != null && owner.equals(bot)) throw new IllegalArgumentException("Owner and bot must be different");
        return new PlanConfig(enabled, owner, bot, name);
    }

    boolean isBot(ServerPlayerEntity player) {
        if (player.getUuid().equals(ownerUuid)) return false;
        return botUuid != null ? botUuid.equals(player.getUuid()) : botName.equals(player.getGameProfile().getName());
    }

    ServerPlayerEntity findBot(MinecraftServer server) {
        var manager = server.getPlayerManager();
        var player = botUuid != null ? manager.getPlayer(botUuid) : manager.getPlayer(botName);
        return player != null && isBot(player) ? player : null;
    }

    UUID resolveBotUuid(MinecraftServer server) {
        var player = findBot(server);
        if (player != null) return player.getUuid();
        if (botUuid != null || botName.isEmpty()) return botUuid;
        return UUID.nameUUIDFromBytes(("OfflinePlayer:" + botName).getBytes(StandardCharsets.UTF_8));
    }

    private static UUID uuid(JsonObject object, String field) {
        String value = string(object, field);
        return value.isEmpty() ? null : UUID.fromString(value);
    }

    private static String string(JsonObject object, String field) {
        var value = object.get(field);
        if (value == null || value.isJsonNull()) return "";
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new IllegalArgumentException("Plan authorization " + field + " must be text");
        }
        return value.getAsString().trim();
    }
}
