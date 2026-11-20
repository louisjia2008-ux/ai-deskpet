package dev.deskpet.minecraft.plan;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.deskpet.minecraft.PlanChannel;
import dev.deskpet.minecraft.WorldIdentity;
import dev.deskpet.minecraft.wand.PlanCompiler;
import dev.deskpet.minecraft.wand.WandInteractions;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.player.PlayerBlockBreakEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.block.BedBlock;
import net.minecraft.block.BlockState;
import net.minecraft.block.DoorBlock;
import net.minecraft.block.TallPlantBlock;
import net.minecraft.block.enums.BedPart;
import net.minecraft.block.enums.DoubleBlockHalf;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.util.math.BlockPos;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static dev.deskpet.minecraft.plan.SurveyPlan.Status.*;

public final class PlanService {
    private static final Logger LOGGER = LoggerFactory.getLogger("deskpet.plan");
    private static final long HEARTBEAT_NANOS = Duration.ofSeconds(10).toNanos();
    private static final long PREVIEW_MILLIS = Duration.ofMinutes(10).toMillis();
    private static final int CHUNK_BYTES = 23 * 1024;
    private static final int MAX_CHUNKS = 512;
    private static boolean stopping;
    private static PlanConfig config = new PlanConfig(false, null, null, "");

    private PlanService() {}

    public static void init() {
        config = PlanConfig.load();
        PlanDebugCommands.register();
        PlanChannel.onMessage(PlanService::receive);
        ServerTickEvents.END_SERVER_TICK.register(PlanService::tick);
        ServerLifecycleEvents.SERVER_STARTING.register(server -> stopping = false);
        ServerLifecycleEvents.SERVER_STOPPING.register(server -> stopping = true);
        ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> {
            if (!stopping && config.enabled() && config.isBot(handler.player)) {
                var store = PlanStore.get(server);
                for (var plan : store.plans.values()) {
                    if (hasGrant(plan) && handler.player.getUuid().equals(plan.botUuid)) {
                        revoke(server, store, plan, PAUSED, "disconnected", false);
                    }
                }
            }
        });
        PlayerBlockBreakEvents.BEFORE.register((world, player, pos, state, blockEntity) ->
            !(world instanceof ServerWorld serverWorld && player instanceof ServerPlayerEntity serverPlayer)
                || allowBreak(serverWorld, serverPlayer, pos, state));
        PlayerBlockBreakEvents.AFTER.register((world, player, pos, state, blockEntity) -> {
            if (world instanceof ServerWorld serverWorld && player instanceof ServerPlayerEntity serverPlayer
                && config.enabled() && config.isBot(serverPlayer)) {
                footprint(pos, state, null).forEach((block, before) -> observeChange(serverWorld, serverPlayer, block, before));
            }
        });
        WandInteractions.authorization(new WandInteractions.Authorization() {
            @Override public UUID botUuid(ServerPlayerEntity p) { return PlanService.botUuid(p); }
            @Override public void preview(ServerPlayerEntity p, JsonObject plan) { PlanService.preview(p, plan); }
            @Override public UUID active(ServerPlayerEntity p) { return PlanService.active(p); }
            @Override public String confirm(ServerPlayerEntity p, UUID id) { return PlanService.confirm(p, id); }
            @Override public String pause(ServerPlayerEntity p, UUID id) { return PlanService.pause(p, id); }
            @Override public String resume(ServerPlayerEntity p, UUID id) { return PlanService.resume(p, id); }
            @Override public String cancel(ServerPlayerEntity p, UUID id) { return PlanService.cancel(p, id); }
            @Override public String status(ServerPlayerEntity p, UUID id) { return PlanService.status(p, id); }
            @Override public boolean enabled() { return config.enabled(); }
        });
    }

    private static UUID botUuid(ServerPlayerEntity player) {
        var bot = config.findBot(player.getWorld().getServer());
        if (bot != null) return bot.getUuid();
        if (config.botUuid() != null) return config.botUuid();
        if (config.botName().isEmpty()) return null;
        return UUID.nameUUIDFromBytes(("OfflinePlayer:" + config.botName()).getBytes(StandardCharsets.UTF_8));
    }

    private static UUID active(ServerPlayerEntity player) {
        if (!config.enabled() || !player.getUuid().equals(config.ownerUuid())) return null;
        var store = PlanStore.get(player.getWorld().getServer());
        UUID id = null;
        for (var plan : store.plans.values()) {
            if (plan.status.holdsSelection() && plan.ownerUuid.equals(player.getUuid())) id = plan.id;
        }
        return id;
    }

    private static void preview(ServerPlayerEntity player, JsonObject planJson) {
        if (!config.enabled()) return;
        var store = PlanStore.get(player.getWorld().getServer());
        var plan = new SurveyPlan(planJson);
        if (!plan.ownerUuid.equals(player.getUuid()) || store.plans.containsKey(plan.id)) return;
        // Active plans are retained. Retire obsolete drafts and previous menu previews.
        store.plans.values().removeIf(old -> !old.status.holdsSelection()
            && old.ownerUuid.equals(plan.ownerUuid) && (old.status == DRAFT || old.status == PREVIEWED));
        for (var protectedPos : plan.document.getAsJsonArray("protected")) {
            BlockPos pos = SurveyPlan.readPosition(protectedPos.getAsJsonObject());
            plan.protectedBaseline.put(pos, PlanCompiler.stateName(player.getWorld().getBlockState(pos)));
        }
        plan.status = PREVIEWED;
        store.plans.put(plan.id, plan);
        store.markDirty();
    }

    static String confirm(ServerPlayerEntity player, UUID id) {
        var world = player.getWorld();
        var server = world.getServer();
        var store = PlanStore.get(server);
        var plan = store.plans.get(id);
        String error = ownerCheck(player, plan);
        if (error == null) error = contextCheck(world, plan);
        if (error != null) return deny(store, plan, id, "confirm", error);
        if (plan.status == EXPIRED || (plan.status == PREVIEWED && expired(plan))) {
            plan.status = EXPIRED;
            plan.reason = "preview_expired";
            return deny(store, plan, id, "confirm", "preview_expired");
        }
        if (plan.status != PREVIEWED) return deny(store, plan, id, "confirm", "not_previewed");
        if (plan.document.getAsJsonArray("conflicts").size() > 0) {
            return deny(store, plan, id, "confirm", "preview_conflicts");
        }
        String hash = PlanCompiler.snapshotHash(world, plan.document.getAsJsonObject("selection"));
        if (!hash.equals(plan.document.get("snapshotHash").getAsString())) {
            return deny(store, plan, id, "confirm", "snapshot_changed");
        }
        return issue(server, store, plan, "confirm");
    }

    private static String pause(ServerPlayerEntity player, UUID id) {
        var world = player.getWorld();
        var store = PlanStore.get(world.getServer());
        var plan = store.plans.get(id);
        String error = ownerCheck(player, plan);
        if (error != null) return deny(store, plan, id, "pause", error);
        if (!hasGrant(plan)) return deny(store, plan, id, "pause", "not_running");
        revoke(world.getServer(), store, plan, PAUSED, "owner_paused", true);
        return describe(plan);
    }

    private static String resume(ServerPlayerEntity player, UUID id) {
        var world = player.getWorld();
        var server = world.getServer();
        var store = PlanStore.get(server);
        var plan = store.plans.get(id);
        String error = ownerCheck(player, plan);
        if (error == null) error = contextCheck(world, plan);
        if (error != null) return deny(store, plan, id, "resume", error);
        if (plan.status != PAUSED) return deny(store, plan, id, "resume", "not_paused");
        for (var target : plan.finalTargets.entrySet()) {
            var pos = target.getKey();
            var next = plan.next(pos);
            String expected = next == null ? target.getValue() : next.expect();
            String actual = PlanCompiler.stateName(world.getBlockState(pos));
            if (!actual.equals(expected)) {
                return deny(store, plan, id, "resume", mismatch(pos, expected, actual));
            }
        }
        if (!matches(world, plan.protectedBaseline)) {
            return deny(store, plan, id, "resume", "protected_block_changed");
        }

        var revised = plan.document.deepCopy();
        revised.addProperty("revision", revised.get("revision").getAsInt() + 1);
        revised.add("ops", plan.remaining());
        revised.addProperty("snapshotHash", PlanCompiler.snapshotHash(world, revised.getAsJsonObject("selection")));
        revised.addProperty("expiresAt", System.currentTimeMillis() + PREVIEW_MILLIS);
        revised.remove("planHash");
        revised.addProperty("planHash", PlanCompiler.sha256(revised));
        var renewed = new SurveyPlan(revised);
        renewed.finalTargets.putAll(plan.finalTargets);
        renewed.protectedBaseline.putAll(plan.protectedBaseline);
        renewed.rejectedChanges = plan.rejectedChanges;
        renewed.status = PAUSED;
        return issue(server, store, renewed, "resume");
    }

    private static String cancel(ServerPlayerEntity player, UUID id) {
        var world = player.getWorld();
        var store = PlanStore.get(world.getServer());
        var plan = store.plans.get(id);
        String error = ownerCheck(player, plan);
        if (error != null) return deny(store, plan, id, "cancel", error);
        if (!plan.status.holdsSelection() && plan.status != PREVIEWED) {
            return deny(store, plan, id, "cancel", "not_cancellable");
        }
        if (plan.status.holdsSelection()) {
            // A revoked lease is an explicit deny state. A fresh owner grant is the only
            // way to clear it, even if a delayed break packet arrives after a reconnect.
            store.revokedBots.put(plan.botUuid, plan.id);
        }
        revoke(world.getServer(), store, plan, CANCELLED, "owner_cancelled", true);
        return describe(plan);
    }

    private static String status(ServerPlayerEntity player, UUID id) {
        var plan = PlanStore.get(player.getWorld().getServer()).plans.get(id);
        return ownerCheck(player, plan) == null ? describe(plan) : "";
    }

    private static String describe(SurveyPlan plan) {
        var label = switch (plan.status) {
            case DRAFT -> "草稿";
            case PREVIEWED -> "已预览";
            case CONFIRMED -> "已确认，等待机器人接单";
            case RUNNING -> "运行中";
            case PAUSED -> "已暂停";
            case COMPLETED -> "已完成";
            case FAILED -> "失败";
            case CANCELLED -> "已取消";
            case EXPIRED -> "已过期";
        };
        return label + (plan.reason.isEmpty() ? "" : " · " + reasonLabel(plan.reason))
            + (plan.status == RUNNING ? " · " + plan.reportedProgress + "/" + plan.document.getAsJsonArray("ops").size() : "");
    }

    private static String reasonLabel(String reason) {
        return switch (reason) {
            case "disabled" -> "游戏内授权未启用";
            case "wrong_owner" -> "只有配置的主人可以操作";
            case "missing_plan" -> "找不到计划";
            case "wrong_world" -> "计划属于另一个世界";
            case "wrong_dimension" -> "请回到计划所在维度";
            case "preview_expired" -> "预览已过期，请重新预览";
            case "snapshot_changed" -> "现场已变化，请重新预览";
            case "overlapping_plan" -> "已有进行中的计划和此选区重叠";
            case "bot_busy" -> "机器人正在处理另一份计划";
            case "bot_unavailable" -> "机器人尚未连接计划频道";
            case "bot_wrong_dimension" -> "机器人不在计划所在维度";
            case "disconnected" -> "断线";
            case "server_restart" -> "服务器重启";
            case "owner_paused" -> "主人暂停";
            case "owner_cancelled" -> "主人取消";
            default -> reason;
        };
    }

    private static String ownerCheck(ServerPlayerEntity player, SurveyPlan plan) {
        if (!config.enabled()) return "disabled";
        if (!player.getUuid().equals(config.ownerUuid())) return "wrong_owner";
        if (plan == null) return "missing_plan";
        return plan.ownerUuid.equals(player.getUuid()) ? null : "wrong_owner";
    }

    private static String contextCheck(ServerWorld world, SurveyPlan plan) {
        if (!WorldIdentity.get(world).toString().equals(plan.document.get("worldId").getAsString())) return "wrong_world";
        return dimension(world).equals(plan.dimension) ? null : "wrong_dimension";
    }

    private static String dimension(ServerWorld world) {
        return world.getRegistryKey().getValue().toString();
    }

    private static String issue(MinecraftServer server, PlanStore store, SurveyPlan plan, String method) {
        if (store.plans.values().stream().anyMatch(other -> !other.id.equals(plan.id)
            && other.status.holdsSelection() && overlaps(other, plan))) {
            return deny(store, store.plans.get(plan.id), plan.id, method, "overlapping_plan");
        }
        var bot = config.findBot(server);
        if (bot == null || !bot.getUuid().equals(plan.botUuid) || !PlanChannel.isReady(bot)) {
            return deny(store, store.plans.get(plan.id), plan.id, method, "bot_unavailable");
        }
        if (store.plans.values().stream().anyMatch(other -> !other.id.equals(plan.id)
            && other.status.holdsSelection() && bot.getUuid().equals(other.botUuid))) {
            return deny(store, store.plans.get(plan.id), plan.id, method, "bot_busy");
        }
        if (!dimension(bot.getWorld()).equals(plan.dimension)) {
            return deny(store, store.plans.get(plan.id), plan.id, method, "bot_wrong_dimension");
        }
        plan.grantId = UUID.randomUUID();
        byte[] bytes = encodeGrant(plan);
        int chunks = (bytes.length + CHUNK_BYTES - 1) / CHUNK_BYTES;
        if (chunks > MAX_CHUNKS) {
            plan.grantId = null;
            return deny(store, store.plans.get(plan.id), plan.id, method, "grant_too_large");
        }
        plan.status = CONFIRMED;
        plan.reason = "";
        plan.lastDenial = "";
        plan.heartbeatDeadline = System.nanoTime() + HEARTBEAT_NANOS;
        store.plans.put(plan.id, plan);
        store.markDirty();

        for (int index = 0; index < chunks; index++) {
            int offset = index * CHUNK_BYTES;
            var chunk = new JsonObject();
            chunk.addProperty("type", "grant_chunk");
            chunk.addProperty("grantId", plan.grantId.toString());
            chunk.addProperty("index", index);
            chunk.addProperty("count", chunks);
            chunk.addProperty("data", Base64.getEncoder().encodeToString(
                java.util.Arrays.copyOfRange(bytes, offset, Math.min(offset + CHUNK_BYTES, bytes.length))));
            PlanChannel.send(bot, chunk);
        }
        return describe(plan);
    }

    private static boolean overlaps(SurveyPlan left, SurveyPlan right) {
        if (!left.dimension.equals(right.dimension)) return false;
        var a = left.document.getAsJsonObject("selection");
        var b = right.document.getAsJsonObject("selection");
        return a.get("minX").getAsInt() <= b.get("maxX").getAsInt()
            && b.get("minX").getAsInt() <= a.get("maxX").getAsInt()
            && a.get("minZ").getAsInt() <= b.get("maxZ").getAsInt()
            && b.get("minZ").getAsInt() <= a.get("maxZ").getAsInt();
    }

    private static byte[] encodeGrant(SurveyPlan plan) {
        var grant = identity(plan);
        var encoded = plan.document.deepCopy();
        var palette = new JsonArray();
        var indices = new LinkedHashMap<String, Integer>();
        var packed = new JsonArray();
        for (var element : plan.document.getAsJsonArray("ops")) {
            var op = element.getAsJsonObject();
            var pos = op.getAsJsonObject("pos");
            var tuple = new JsonArray();
            tuple.add(pos.get("x"));
            tuple.add(pos.get("y"));
            tuple.add(pos.get("z"));
            for (String key : List.of("expect", "target")) {
                int index = indices.computeIfAbsent(op.get(key).getAsString(), state -> {
                    palette.add(state);
                    return palette.size() - 1;
                });
                tuple.add(index);
            }
            tuple.add(op.get("kind"));
            tuple.add(op.get("phase"));
            tuple.add(op.get("order"));
            packed.add(tuple);
        }
        encoded.add("ops", packed);
        encoded.add("opPalette", palette);
        grant.add("plan", encoded);
        return grant.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static JsonObject identity(SurveyPlan plan) {
        var json = new JsonObject();
        json.addProperty("planId", plan.id.toString());
        json.add("revision", plan.document.get("revision"));
        json.add("planHash", plan.document.get("planHash"));
        json.addProperty("grantId", plan.grantId.toString());
        return json;
    }

    private static boolean hasGrant(SurveyPlan plan) {
        return plan.status == CONFIRMED || plan.status == RUNNING;
    }

    private static boolean expired(SurveyPlan plan) {
        return plan.document.get("expiresAt").getAsLong() <= System.currentTimeMillis();
    }

    private static void revoke(MinecraftServer server, PlanStore store, SurveyPlan plan,
                               SurveyPlan.Status next, String reason, boolean notify) {
        UUID oldGrant = plan.grantId;
        plan.grantId = null;
        plan.status = next;
        plan.reason = reason;
        store.markDirty();
        if (notify && oldGrant != null) {
            var bot = config.findBot(server);
            if (bot != null && bot.getUuid().equals(plan.botUuid) && PlanChannel.isReady(bot)) {
                var message = new JsonObject();
                message.addProperty("type", "revoke");
                message.addProperty("grantId", oldGrant.toString());
                message.addProperty("reason", reason);
                PlanChannel.send(bot, message);
            }
        }
    }

    private static void tick(MinecraftServer server) {
        if (!config.enabled()) return;
        var store = PlanStore.get(server);
        for (var plan : store.plans.values()) {
            if (plan.status == PREVIEWED && expired(plan)) {
                plan.status = EXPIRED;
                plan.reason = "preview_expired";
                store.markDirty();
            } else if (hasGrant(plan) && System.nanoTime() >= plan.heartbeatDeadline) {
                revoke(server, store, plan, PAUSED, "disconnected", true);
            }
        }
    }

    private static void receive(ServerPlayerEntity player, JsonObject message) {
        if (!config.enabled() || !config.isBot(player) || !PlanChannel.isReady(player)) return;
        String type = string(message, "type");
        if (!type.equals("accept") && !type.equals("heartbeat") && !type.equals("progress")) return;
        var world = player.getWorld();
        var server = world.getServer();
        var store = PlanStore.get(server);
        UUID id;
        try {
            id = UUID.fromString(string(message, "planId"));
        } catch (IllegalArgumentException invalid) {
            deny(store, null, null, type, "invalid_plan_identity");
            return;
        }
        var plan = store.plans.get(id);
        if (plan == null || !player.getUuid().equals(plan.botUuid)) {
            deny(store, null, id, type, "invalid_plan_identity");
            return;
        }
        if ((type.equals("accept") && plan.status != CONFIRMED) || (!type.equals("accept") && plan.status != RUNNING)
            || plan.grantId == null || !plan.grantId.toString().equals(string(message, "grantId"))) {
            deny(store, null, id, type, "replayed_or_inactive_grant");
            return;
        }
        if (System.nanoTime() >= plan.heartbeatDeadline) {
            revoke(server, store, plan, PAUSED, "disconnected", true);
            deny(store, null, id, type, "late_grant_message");
            return;
        }
        if (!plan.document.get("revision").equals(message.get("revision"))
            || !plan.document.get("planHash").getAsString().equals(string(message, "planHash"))) {
            deny(store, null, id, type, "invalid_plan_identity");
            return;
        }
        String contextError = contextCheck(world, plan);
        if (contextError != null) {
            revoke(server, store, plan, PAUSED, contextError, true);
            deny(store, null, id, type, contextError);
            return;
        }
        if (type.equals("accept")) {
            String snapshot = PlanCompiler.snapshotHash(world, plan.document.getAsJsonObject("selection"));
            if (!snapshot.equals(plan.document.get("snapshotHash").getAsString())) {
                revoke(server, store, plan, PAUSED, "snapshot_changed", true);
                return;
            }
            plan.status = RUNNING;
            store.revokedBots.remove(player.getUuid());
            plan.heartbeatDeadline = System.nanoTime() + HEARTBEAT_NANOS;
            store.markDirty();
        } else if (type.equals("heartbeat")) {
            plan.heartbeatDeadline = System.nanoTime() + HEARTBEAT_NANOS;
        } else {
            var completed = message.get("completed");
            if (completed == null || !completed.isJsonPrimitive() || !completed.getAsJsonPrimitive().isNumber()
                || !completed.getAsString().matches("0|[1-9][0-9]{0,6}")) return;
            int count = completed.getAsInt();
            if (count <= plan.document.getAsJsonArray("ops").size() && count != plan.reportedProgress) {
                plan.reportedProgress = count;
                store.markDirty();
            }
        }
    }

    private static String string(JsonObject json, String field) {
        return json.has(field) && json.get(field).isJsonPrimitive() && json.getAsJsonPrimitive(field).isString()
            ? json.get(field).getAsString() : "";
    }

    private static String deny(PlanStore store, SurveyPlan plan, UUID id, String action, String reason) {
        if (plan != null) plan.lastDenial = reason;
        var event = new JsonObject();
        if (id != null) event.addProperty("planId", id.toString());
        event.addProperty("action", action);
        event.addProperty("reason", reason);
        store.audit(store.protocolRejections, event);
        if (plan != null || store.allowProtocolWarning()) LOGGER.warn("Survey plan request rejected: {}", event);
        return reasonLabel(reason);
    }

    private static boolean allowBreak(ServerWorld world, ServerPlayerEntity player, BlockPos pos, BlockState state) {
        if (!config.enabled() || !config.isBot(player)) return true;
        return allowed(world, player, "break", pos,
            footprint(pos, state, "minecraft:air"), Map.of(pos, PlanCompiler.stateName(state)), false);
    }

    public static Map<BlockPos, String> checkPlacement(ServerWorld world, ServerPlayerEntity player, BlockPos pos,
                                                       BlockState state, boolean custom) {
        if (!config.enabled() || !config.isBot(player)) return Map.of();
        var targets = footprint(pos, state, null);
        var before = new LinkedHashMap<BlockPos, String>();
        targets.keySet().forEach(block -> before.put(block, PlanCompiler.stateName(world.getBlockState(block))));
        return allowed(world, player, "place", pos, targets, before, custom) ? before : null;
    }

    private static Map<BlockPos, String> footprint(BlockPos pos, BlockState state, String change) {
        var targets = new LinkedHashMap<BlockPos, String>();
        targets.put(pos, change == null ? PlanCompiler.stateName(state) : change);
        if (state.getBlock() instanceof DoorBlock || state.getBlock() instanceof TallPlantBlock) {
            var half = state.get(DoorBlock.HALF);
            var other = half == DoubleBlockHalf.LOWER ? DoubleBlockHalf.UPPER : DoubleBlockHalf.LOWER;
            targets.put(half == DoubleBlockHalf.LOWER ? pos.up() : pos.down(),
                change == null ? PlanCompiler.stateName(state.with(DoorBlock.HALF, other)) : change);
        } else if (state.getBlock() instanceof BedBlock) {
            var part = state.get(BedBlock.PART);
            var other = part == BedPart.FOOT ? BedPart.HEAD : BedPart.FOOT;
            var facing = state.get(BedBlock.FACING);
            targets.put(pos.offset(part == BedPart.FOOT ? facing : facing.getOpposite()),
                change == null ? PlanCompiler.stateName(state.with(BedBlock.PART, other)) : change);
        }
        return targets;
    }

    private static boolean allowed(ServerWorld world, ServerPlayerEntity player, String action, BlockPos origin,
                                   Map<BlockPos, String> targets, Map<BlockPos, String> observed, boolean custom) {
        if (!config.enabled() || !config.isBot(player)) return true;
        var server = world.getServer();
        var store = PlanStore.get(server);
        SurveyPlan matching = null;
        SurveyPlan controlling = null;
        for (var plan : store.plans.values()) {
            if (!plan.status.holdsSelection() || !player.getUuid().equals(plan.botUuid)) continue;
            controlling = plan;
            if (plan.status == RUNNING && plan.dimension.equals(dimension(world)) && plan.next(origin) != null) {
                matching = plan;
                break;
            }
        }
        UUID revoked = store.revokedBots.get(player.getUuid());
        if (revoked != null) {
            return rejectChange(store, store.plans.get(revoked), action, origin, "authorization_revoked");
        }
        if (controlling == null) return true;
        if (custom) return rejectChange(store, controlling, action, origin, "custom_item_data");
        if (matching == null) {
            return rejectChange(store, controlling, action, origin, "outside_authorized_operations");
        }
        if (System.nanoTime() >= matching.heartbeatDeadline) {
            revoke(server, store, matching, PAUSED, "disconnected", true);
            return rejectChange(store, matching, action, origin, "authorization_expired");
        }
        for (var target : targets.entrySet()) {
            var pos = target.getKey();
            var op = matching.next(pos);
            if (op == null || !op.target().equals(target.getValue())) {
                return rejectChange(store, matching, action, pos, "outside_authorized_operations");
            }
            String actual = observed.containsKey(pos) ? observed.get(pos) : PlanCompiler.stateName(world.getBlockState(pos));
            if (!actual.equals(op.expect())) {
                revoke(server, store, matching, PAUSED, mismatch(pos, op.expect(), actual), true);
                return rejectChange(store, matching, action, pos, "expected_block_changed");
            }
        }
        return true;
    }

    public static void observePlacement(ServerWorld world, ServerPlayerEntity player, Map<BlockPos, String> changes) {
        changes.forEach((pos, before) -> observeChange(world, player, pos, before));
    }

    private static void observeChange(ServerWorld world, ServerPlayerEntity player, BlockPos pos, String before) {
        if (!config.enabled() || !config.isBot(player)) return;
        var server = world.getServer();
        var store = PlanStore.get(server);
        for (var plan : store.plans.values()) {
            if (plan.status != RUNNING || !player.getUuid().equals(plan.botUuid) || !plan.dimension.equals(dimension(world))) continue;
            var operation = plan.next(pos);
            if (operation == null || !operation.expect().equals(before)
                || !operation.target().equals(PlanCompiler.stateName(world.getBlockState(pos)))) continue;
            plan.consumed.merge(pos.toImmutable(), 1, Integer::sum);
            store.markDirty();
            if (plan.operations.keySet().stream().allMatch(block -> plan.next(block) == null)) {
                boolean complete = plan.rejectedChanges == 0 && matches(world, plan.finalTargets)
                    && matches(world, plan.protectedBaseline);
                revoke(server, store, plan, complete ? COMPLETED : FAILED, complete ? "" : "server_final_verification_failed", true);
            }
        }
    }

    private static boolean matches(ServerWorld world, Map<BlockPos, String> expected) {
        return expected.entrySet().stream().allMatch(entry ->
            entry.getValue().equals(PlanCompiler.stateName(world.getBlockState(entry.getKey()))));
    }

    private static String mismatch(BlockPos pos, String expected, String actual) {
        return "expected_block_changed at " + pos.toShortString() + " expected " + expected + " actual " + actual;
    }

    private static boolean rejectChange(PlanStore store, SurveyPlan plan, String action, BlockPos pos, String reason) {
        var event = new JsonObject();
        if (plan != null) {
            event.addProperty("planId", plan.id.toString());
            plan.rejectedChanges++;
        }
        event.addProperty("action", action);
        var position = new JsonObject();
        position.addProperty("x", pos.getX());
        position.addProperty("y", pos.getY());
        position.addProperty("z", pos.getZ());
        event.add("pos", position);
        event.addProperty("reason", reason);
        store.audit(store.rejections, event);
        LOGGER.warn("Survey plan block change rejected: {}", event);
        return false;
    }
}
