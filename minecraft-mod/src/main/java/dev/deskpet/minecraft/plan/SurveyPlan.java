package dev.deskpet.minecraft.plan;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.util.math.BlockPos;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

final class SurveyPlan {
    enum Status {
        DRAFT, PREVIEWED, CONFIRMED, RUNNING, PAUSED, COMPLETED, FAILED, CANCELLED, EXPIRED;

        boolean holdsSelection() {
            return this == CONFIRMED || this == RUNNING || this == PAUSED;
        }

        boolean finished() {
            return this == COMPLETED || this == FAILED || this == CANCELLED || this == EXPIRED;
        }
    }

    record Operation(BlockPos pos, String kind, String expect, String target) {
        static Operation read(JsonObject object) {
            return new Operation(readPosition(object.getAsJsonObject("pos")), object.get("kind").getAsString(),
                object.get("expect").getAsString(), object.get("target").getAsString());
        }
    }

    final JsonObject document;
    final UUID id;
    final UUID ownerUuid;
    final UUID botUuid;
    final String dimension;
    private final BlockPos min;
    private final BlockPos max;
    final Map<BlockPos, List<Operation>> operations = new LinkedHashMap<>();
    final Map<BlockPos, String> finalTargets = new LinkedHashMap<>();
    final Map<BlockPos, String> protectedBaseline = new LinkedHashMap<>();
    final Map<BlockPos, Integer> consumed = new LinkedHashMap<>();
    Status status = Status.DRAFT;
    String reason = "";
    String lastDenial = "";
    UUID grantId;
    long heartbeatDeadline;
    int violations;
    int siteChanges;
    int lateAttempts;
    int reportedProgress;
    long finishOrder;

    SurveyPlan(JsonObject document) {
        this.document = document.deepCopy();
        id = UUID.fromString(document.get("planId").getAsString());
        ownerUuid = UUID.fromString(document.get("ownerUuid").getAsString());
        botUuid = document.get("botUuid").isJsonNull() ? null : UUID.fromString(document.get("botUuid").getAsString());
        dimension = document.get("dimension").getAsString();
        var selection = document.getAsJsonObject("selection");
        min = new BlockPos(selection.get("minX").getAsInt(), selection.get("minY").getAsInt(), selection.get("minZ").getAsInt());
        max = new BlockPos(selection.get("maxX").getAsInt(), selection.get("maxY").getAsInt(), selection.get("maxZ").getAsInt());
        for (var op : document.getAsJsonArray("ops")) {
            Operation operation = Operation.read(op.getAsJsonObject());
            operations.computeIfAbsent(operation.pos(), ignored -> new ArrayList<>()).add(operation);
            finalTargets.put(operation.pos(), operation.target());
        }
    }

    static BlockPos readPosition(JsonObject pos) {
        return new BlockPos(pos.get("x").getAsInt(), pos.get("y").getAsInt(), pos.get("z").getAsInt());
    }

    boolean contains(BlockPos pos) {
        return pos.getX() >= min.getX() && pos.getX() <= max.getX()
            && pos.getY() >= min.getY() && pos.getY() <= max.getY()
            && pos.getZ() >= min.getZ() && pos.getZ() <= max.getZ();
    }

    Operation next(BlockPos pos) {
        var atPos = operations.get(pos);
        int index = consumed.getOrDefault(pos, 0);
        return atPos != null && index < atPos.size() ? atPos.get(index) : null;
    }

    JsonArray remaining() {
        var skipped = new LinkedHashMap<>(consumed);
        var remaining = new JsonArray();
        for (var element : document.getAsJsonArray("ops")) {
            var op = element.getAsJsonObject();
            BlockPos pos = readPosition(op.getAsJsonObject("pos"));
            if (skipped.getOrDefault(pos, 0) > 0) {
                skipped.computeIfPresent(pos, (key, count) -> count - 1);
            } else {
                remaining.add(op.deepCopy());
            }
        }
        return remaining;
    }

    JsonObject export() {
        var json = new JsonObject();
        json.addProperty("id", id.toString());
        json.addProperty("status", status.name().toLowerCase(Locale.ROOT));
        json.addProperty("reason", reason);
        json.addProperty("lastDenial", lastDenial);
        if (grantId != null) json.addProperty("grantId", grantId.toString());
        json.add("plan", document);
        json.addProperty("violations", violations);
        json.addProperty("siteChanges", siteChanges);
        json.addProperty("lateAttempts", lateAttempts);
        json.addProperty("reportedProgress", reportedProgress);
        if (finishOrder > 0) json.addProperty("finishOrder", finishOrder);
        var counts = new JsonObject();
        consumed.forEach((pos, count) -> counts.addProperty(Long.toString(pos.asLong()), count));
        json.add("consumed", counts);
        json.add("targets", encodeStates(finalTargets));
        json.add("protectedBaseline", encodeStates(protectedBaseline));
        return json;
    }

    private static JsonObject encodeStates(Map<BlockPos, String> states) {
        var encoded = new JsonObject();
        states.forEach((block, state) -> encoded.addProperty(Long.toString(block.asLong()), state));
        return encoded;
    }

    private static void restoreStates(JsonObject encoded, Map<BlockPos, String> states) {
        if (encoded == null) return;
        states.clear();
        encoded.entrySet().forEach(entry ->
            states.put(BlockPos.fromLong(Long.parseLong(entry.getKey())), entry.getValue().getAsString()));
    }

    static SurveyPlan restore(JsonObject json) {
        var plan = new SurveyPlan(json.getAsJsonObject("plan"));
        plan.status = Status.valueOf(json.get("status").getAsString().toUpperCase(Locale.ROOT));
        plan.reason = json.get("reason").getAsString();
        plan.lastDenial = json.get("lastDenial").getAsString();
        plan.grantId = json.has("grantId") ? UUID.fromString(json.get("grantId").getAsString()) : null;
        // Legacy totals conflated violations, environmental changes and late packets.
        // Keep the legacy audit log, but do not treat its unclassified total as a violation.
        if (json.has("violations")) plan.violations = json.get("violations").getAsInt();
        if (json.has("siteChanges")) plan.siteChanges = json.get("siteChanges").getAsInt();
        if (json.has("lateAttempts")) plan.lateAttempts = json.get("lateAttempts").getAsInt();
        plan.reportedProgress = json.get("reportedProgress").getAsInt();
        if (json.has("finishOrder")) plan.finishOrder = json.get("finishOrder").getAsLong();
        json.getAsJsonObject("consumed").entrySet().forEach(entry ->
            plan.consumed.put(BlockPos.fromLong(Long.parseLong(entry.getKey())), entry.getValue().getAsInt()));
        restoreStates(json.getAsJsonObject("targets"), plan.finalTargets);
        restoreStates(json.getAsJsonObject("protectedBaseline"), plan.protectedBaseline);
        if (plan.status == Status.RUNNING || plan.status == Status.CONFIRMED) {
            plan.status = Status.PAUSED;
            plan.reason = "server_restart";
            plan.grantId = null;
        }
        return plan;
    }
}
