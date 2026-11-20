package dev.deskpet.minecraft.plan;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.serialization.Codec;
import dev.deskpet.minecraft.wand.PlanCompiler;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.PersistentState;
import net.minecraft.world.PersistentStateType;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

final class PlanStore extends PersistentState {
    private static final int FINISHED_LIMIT = 20;
    private static final Codec<PlanStore> CODEC = Codec.BYTE_BUFFER.fieldOf("plans").codec().xmap(
        PlanStore::decode, value -> ByteBuffer.wrap(value.export().toString().getBytes(StandardCharsets.UTF_8)));
    private static final PersistentStateType<PlanStore> TYPE = new PersistentStateType<>(
        "deskpet_survey_plans", PlanStore::new, CODEC, null);

    final Map<UUID, SurveyPlan> plans = new LinkedHashMap<>();
    record Revocation(SurveyPlan plan, UUID grantId, long deadline) {}

    final Map<UUID, Revocation> revocations = new LinkedHashMap<>();
    record Recomparison(UUID previewId, SurveyPlan base, PlanCompiler.Recomparison compiled, JsonObject diff) {
        JsonObject export() {
            var value = new JsonObject();
            value.addProperty("previewId", previewId.toString());
            value.add("plan", compiled.document().deepCopy());
            value.add("diff", diff.deepCopy());
            return value;
        }
    }

    // Unconfirmed revisions are session-local. A restart requires a fresh comparison.
    final Map<UUID, Recomparison> recomparisons = new LinkedHashMap<>();
    final LinkedHashMap<UUID, String> retiredPreviews = new LinkedHashMap<>();
    final JsonArray rejections = new JsonArray();
    final JsonArray protocolRejections = new JsonArray();
    private long lastFinishOrder;
    private boolean historyNeedsTrim;
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

    void recordFinish(SurveyPlan plan) {
        plan.finishOrder = ++lastFinishOrder;
        plan.finishedAt = System.currentTimeMillis();
        historyNeedsTrim = true;
        markDirty();
    }

    void trimHistory() {
        if (!historyNeedsTrim) return;
        historyNeedsTrim = false;
        var finished = new ArrayList<SurveyPlan>();
        for (var plan : plans.values()) {
            if (plan.status.finished()) finished.add(plan);
        }
        if (finished.size() <= FINISHED_LIMIT) return;
        // Fall back to most recently inserted first for old plans saved without a finish order.
        Collections.reverse(finished);
        finished.sort(Comparator.comparingLong((SurveyPlan plan) -> plan.finishOrder).reversed());
        for (int index = FINISHED_LIMIT; index < finished.size(); index++) {
            plans.remove(finished.get(index).id);
        }
        markDirty();
    }

    JsonObject export() {
        trimHistory();
        var result = new JsonObject();
        var entities = new JsonArray();
        plans.values().forEach(plan -> entities.add(plan.export()));
        result.add("plans", entities);
        result.add("rejections", rejections);
        result.add("protocolRejections", protocolRejections);
        return result;
    }

    JsonObject debugExport() {
        var result = export();
        var pending = new JsonArray();
        recomparisons.values().forEach(draft -> pending.add(draft.export()));
        result.add("recomparisons", pending);
        return result;
    }

    void retireComparison(UUID planId, String reason) {
        var draft = recomparisons.remove(planId);
        if (draft == null) return;
        if (retiredPreviews.size() == 32) retiredPreviews.pollFirstEntry();
        retiredPreviews.put(draft.previewId(), reason);
    }

    private static PlanStore decode(ByteBuffer data) {
        // NbtOps writes a byte buffer's entire backing array. Earlier saves may
        // therefore contain zero padding from the UTF-8 encoder's spare capacity.
        var bytes = data.slice();
        int size = bytes.limit();
        while (size > 0 && bytes.get(size - 1) == 0) size--;
        bytes.limit(size);
        var source = JsonParser.parseString(StandardCharsets.UTF_8.decode(bytes).toString()).getAsJsonObject();
        var store = new PlanStore();
        for (var entry : source.getAsJsonArray("plans")) {
            var plan = SurveyPlan.restore(entry.getAsJsonObject());
            store.plans.put(plan.id, plan);
            store.lastFinishOrder = Math.max(store.lastFinishOrder, plan.finishOrder);
        }
        store.rejections.addAll(source.getAsJsonArray("rejections"));
        store.protocolRejections.addAll(source.getAsJsonArray("protocolRejections"));
        store.historyNeedsTrim = true;
        store.trimHistory();
        store.markDirty();
        return store;
    }
}
