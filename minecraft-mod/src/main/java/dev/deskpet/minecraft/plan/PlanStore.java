package dev.deskpet.minecraft.plan;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.serialization.Codec;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.PersistentState;
import net.minecraft.world.PersistentStateType;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

final class PlanStore extends PersistentState {
    private static final Codec<PlanStore> CODEC = Codec.BYTE_BUFFER.fieldOf("plans").codec().xmap(
        PlanStore::decode, value -> StandardCharsets.UTF_8.encode(value.export().toString()));
    private static final PersistentStateType<PlanStore> TYPE = new PersistentStateType<>(
        "deskpet_survey_plans", PlanStore::new, CODEC, null);

    final Map<UUID, SurveyPlan> plans = new LinkedHashMap<>();
    final Map<UUID, UUID> revokedBots = new LinkedHashMap<>();
    final JsonArray rejections = new JsonArray();
    final JsonArray protocolRejections = new JsonArray();
    private long lastProtocolWarning = System.nanoTime() - Duration.ofSeconds(1).toNanos();

    static PlanStore get(MinecraftServer server) {
        return server.getOverworld().getPersistentStateManager().getOrCreate(TYPE);
    }

    void audit(JsonArray log, JsonObject event) {
        if (log.size() >= 256) log.remove(0);
        log.add(event);
        markDirty();
    }

    boolean allowProtocolWarning() {
        long now = System.nanoTime();
        if (now - lastProtocolWarning < Duration.ofSeconds(1).toNanos()) return false;
        lastProtocolWarning = now;
        return true;
    }

    JsonObject export() {
        var result = new JsonObject();
        var entities = new JsonArray();
        plans.values().forEach(plan -> entities.add(plan.export()));
        result.add("plans", entities);
        var revoked = new JsonObject();
        revokedBots.forEach((bot, plan) -> revoked.addProperty(bot.toString(), plan.toString()));
        result.add("revokedBots", revoked);
        result.add("rejections", rejections);
        result.add("protocolRejections", protocolRejections);
        return result;
    }

    private static PlanStore decode(ByteBuffer data) {
        var source = JsonParser.parseString(StandardCharsets.UTF_8.decode(data).toString()).getAsJsonObject();
        var store = new PlanStore();
        for (var entry : source.getAsJsonArray("plans")) {
            var plan = SurveyPlan.restore(entry.getAsJsonObject());
            store.plans.put(plan.id, plan);
        }
        source.getAsJsonObject("revokedBots").entrySet().forEach(entry ->
            store.revokedBots.put(UUID.fromString(entry.getKey()), UUID.fromString(entry.getValue().getAsString())));
        store.rejections.addAll(source.getAsJsonArray("rejections"));
        store.protocolRejections.addAll(source.getAsJsonArray("protocolRejections"));
        store.markDirty();
        return store;
    }
}
