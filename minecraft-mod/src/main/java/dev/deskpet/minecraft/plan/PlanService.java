package dev.deskpet.minecraft.plan;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.deskpet.minecraft.PlanChannel;
import dev.deskpet.minecraft.WorldIdentity;
import dev.deskpet.minecraft.wand.PlanCompiler;
import dev.deskpet.minecraft.wand.WandInteractions;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.player.PlayerBlockBreakEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.registry.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.text.Text;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.GameRules;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static dev.deskpet.minecraft.plan.SurveyPlan.Status.*;

public final class PlanService {
    private static final Logger LOGGER = LoggerFactory.getLogger("deskpet.plan");
    private static final long HEARTBEAT_NANOS = Duration.ofSeconds(10).toNanos();
    private static final long REVOKE_NANOS = Duration.ofSeconds(15).toNanos();
    private static final long PREVIEW_MILLIS = Duration.ofMinutes(10).toMillis();
    private static final int CHUNK_BYTES = 23 * 1024;
    private static final int MAX_CHUNKS = 512;
    private static final Set<String> CLIENT_MESSAGES = Set.of("accept", "heartbeat", "progress", "state", "blocked");
    private static final Set<String> WAITING_REASONS = Set.of("night", "materials", "chest_full");
    private static boolean stopping;
    private static PlanConfig config = new PlanConfig(false, null, null, "");

    private enum BlockDenial {
        VIOLATION, SITE_CHANGE, LATE_ATTEMPT, MISPLACEMENT
    }

    private PlanService() {}

    public static void init() {
        try {
            config = PlanConfig.read();
        } catch (IOException | RuntimeException error) {
            LOGGER.error("Survey plan authorization disabled because configuration could not be loaded", error);
        }
        PlanDebugCommands.register();
        PlanChannel.onMessage(PlanService::receive);
        ServerTickEvents.END_SERVER_TICK.register(PlanService::tick);
        ServerLifecycleEvents.SERVER_STARTING.register(server -> stopping = false);
        ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
            stopping = true;
            PlanPresentation.clear();
            PlanStatusFeed.clear();
        });
        ServerLivingEntityEvents.AFTER_DEATH.register((entity, damage) -> {
            if (config.enabled() && entity instanceof ServerPlayerEntity bot && config.isBot(bot)) {
                pauseOnDeath(bot);
            }
        });
        ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> {
            PlanStatusFeed.disconnect(handler.player);
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
                observeInteraction(serverWorld, serverPlayer, PlanInteraction.footprint(pos, state, null));
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
            @Override public boolean isOwner(ServerPlayerEntity p) { return PlanService.isOwner(p); }
            @Override public JsonObject recompare(ServerPlayerEntity p, UUID id) { return PlanService.recompare(p, id); }
            @Override public WandInteractions.Progress progress(ServerPlayerEntity p, UUID id, boolean includeRemaining) {
                var plan = PlanStore.get(p.getWorld().getServer()).plans.get(id);
                return ownerCheck(p, plan) == null ? PlanPresentation.progress(plan, includeRemaining) : null;
            }
            @Override public List<WandInteractions.HistoryEntry> history(ServerPlayerEntity p) {
                return isOwner(p) ? PlanPresentation.history(PlanStore.get(p.getWorld().getServer()), p) : List.of();
            }
            @Override public boolean enabled() { return config.enabled(); }
        });
    }

    /** Called on the dedicated server thread from its stdin queue. */
    public static void reloadFromConsole(MinecraftServer server) {
        PlanConfig next;
        boolean valid = true;
        try {
            next = PlanConfig.read();
        } catch (IOException | RuntimeException error) {
            next = new PlanConfig(false, config.ownerUuid(), config.botUuid(), config.botName());
            valid = false;
            LOGGER.error("DeskPet plan configuration rejected; game confirmation disabled", error);
        }
        var store = PlanStore.get(server);
        var nextBot = next.resolveBotUuid(server);
        for (var plan : store.plans.values()) {
            if (!plan.status.holdsSelection() && plan.status != PREVIEWED) continue;
            if (!plan.ownerUuid.equals(next.ownerUuid()) || (plan.botUuid != null && !plan.botUuid.equals(nextBot))) {
                revoke(server, store, plan, CANCELLED, "authorization_changed", true);
            } else if (!next.enabled() && hasGrant(plan)) {
                revoke(server, store, plan, PAUSED, "authorization_disabled", true);
            }
        }
        if (!next.equals(config)) PlanPresentation.clear();
        config = next;
        PlanStatusFeed.publish(server, store, config, false);
        if (valid) LOGGER.info("DeskPet plan configuration reloaded");
    }

    private static void pauseOnDeath(ServerPlayerEntity bot) {
        var world = bot.getWorld();
        var server = world.getServer();
        var store = PlanStore.get(server);
        for (var plan : store.plans.values()) {
            if (!hasGrant(plan) || !bot.getUuid().equals(plan.botUuid)) continue;
            var blockage = new JsonObject();
            blockage.addProperty("reason", "bot_died");
            blockage.add("pos", position(bot.getBlockPos()));
            blockage.addProperty("dimension", dimension(world));
            plan.blockage = blockage;
            revoke(server, store, plan, PAUSED, "bot_died", true);
        }
    }

    static UUID botUuid(ServerPlayerEntity player) {
        return config.resolveBotUuid(player.getWorld().getServer());
    }

    private static boolean isOwner(ServerPlayerEntity player) {
        return config.enabled() && player.getUuid().equals(config.ownerUuid());
    }

    private static UUID active(ServerPlayerEntity player) {
        if (!isOwner(player)) return null;
        var store = PlanStore.get(player.getWorld().getServer());
        UUID id = null;
        for (var plan : store.plans.values()) {
            if (plan.status.holdsSelection() && plan.ownerUuid.equals(player.getUuid())) id = plan.id;
        }
        return id;
    }

    static void preview(ServerPlayerEntity player, JsonObject planJson) {
        if (!config.enabled() && !player.getUuid().equals(config.ownerUuid())) return;
        var server = player.getWorld().getServer();
        var store = PlanStore.get(server);
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
        PlanStatusFeed.transition(server, store, config, plan);
    }

    static String confirm(ServerPlayerEntity player, UUID id) {
        var world = player.getWorld();
        var server = world.getServer();
        var store = PlanStore.get(server);
        var draft = comparisonByToken(store, id);
        if (draft != null) return confirmComparison(player, store, draft);
        var plan = store.plans.get(id);
        if (isOwner(player) && store.retiredPreviews.containsKey(id)) {
            return deny(store, null, id, "confirm", store.retiredPreviews.get(id));
        }
        String error = ownerCheck(player, plan);
        if (error == null) error = contextCheck(world, plan);
        if (error != null) return deny(store, plan, id, "confirm", error);
        if (plan.status == PREVIEWED && expired(plan)) expirePreview(server, store, plan);
        if (plan.status == EXPIRED) return deny(store, plan, id, "confirm", "preview_expired");
        if (plan.status != PREVIEWED) return deny(store, plan, id, "confirm", "not_previewed");
        if (plan.document.getAsJsonArray("conflicts").size() > 0) {
            return deny(store, plan, id, "confirm", "preview_conflicts");
        }
        var conflict = siteProblem(world, plan);
        if (conflict != null) return deny(store, plan, id, "confirm", conflict.message());
        return issue(server, store, plan, "confirm");
    }

    static JsonObject recompare(ServerPlayerEntity player, UUID id) {
        var world = player.getWorld();
        var store = PlanStore.get(world.getServer());
        var plan = store.plans.get(id);
        String error = ownerCheck(player, plan);
        if (error == null) error = contextCheck(world, plan);
        if (error == null && plan.status != PAUSED) error = "not_paused";
        if (error == null) {
            var compiled = PlanCompiler.recompare(world, plan.document, plan.remaining(), plan.finalTargets,
                plan.protectedBaseline, System.currentTimeMillis());
            if (compiled != null) {
                var diff = comparisonDiff(plan.remaining(), compiled.document().getAsJsonArray("ops"));
                var draft = new PlanStore.Recomparison(UUID.randomUUID(), plan, compiled, diff);
                store.retireComparison(id, "preview_superseded");
                store.recomparisons.put(id, draft);
                return draft.export();
            }
            error = "template_revision_unavailable";
        }
        var result = new JsonObject();
        result.addProperty("error", deny(store, plan, id, "recompare", error));
        return result;
    }

    private static JsonObject comparisonDiff(JsonArray before, JsonArray after) {
        var old = indexOperations(before);
        var revised = indexOperations(after);
        var added = new JsonArray();
        var removed = new JsonArray();
        var unchanged = new JsonArray();
        revised.forEach((key, op) -> (old.containsKey(key) ? unchanged : added).add(op.deepCopy()));
        old.forEach((key, op) -> {
            if (!revised.containsKey(key)) removed.add(op.deepCopy());
        });
        var diff = new JsonObject();
        diff.add("added", added);
        diff.add("removed", removed);
        diff.add("unchanged", unchanged);
        return diff;
    }

    private static Map<String, JsonObject> indexOperations(JsonArray operations) {
        var indexed = new LinkedHashMap<String, JsonObject>();
        for (var element : operations) {
            var op = element.getAsJsonObject();
            var identity = op.deepCopy();
            identity.remove("order");
            indexed.put(PlanCompiler.canonical(identity), op);
        }
        return indexed;
    }

    private static PlanStore.Recomparison comparisonByToken(PlanStore store, UUID token) {
        return store.recomparisons.values().stream().filter(draft -> draft.previewId().equals(token)).findFirst().orElse(null);
    }

    static boolean expireComparison(PlanStore store, UUID token) {
        var draft = comparisonByToken(store, token);
        if (draft == null) return false;
        store.retireComparison(draft.base().id, "preview_expired");
        return true;
    }

    private static String confirmComparison(ServerPlayerEntity player, PlanStore store, PlanStore.Recomparison draft) {
        var world = player.getWorld();
        var old = store.plans.get(draft.base().id);
        var token = draft.previewId();
        String error = ownerCheck(player, old);
        if (error == null) error = contextCheck(world, old);
        if (error == null && (old != draft.base() || old.status != PAUSED)) error = "preview_superseded";
        if (error != null) return deny(store, old, token, "confirm", error);
        var revised = new SurveyPlan(draft.compiled().document());
        if (expired(revised)) {
            expireComparison(store, token);
            return deny(store, old, token, "confirm", "preview_expired");
        }
        if (revised.document.getAsJsonArray("conflicts").size() > 0) {
            return deny(store, old, token, "confirm", "preview_conflicts");
        }
        revised.finalTargets.clear();
        revised.finalTargets.putAll(draft.compiled().targets());
        revised.protectedBaseline.putAll(draft.compiled().protectedBaseline());
        revised.inheritProgress(old);
        revised.status = PAUSED;
        var conflict = siteProblem(world, revised);
        if (conflict != null) return deny(store, old, token, "confirm", conflict.message());
        return issue(world.getServer(), store, revised, "confirm");
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
        var conflict = siteProblem(world, plan);
        if (conflict != null) return deny(store, plan, id, "resume", conflict.message());

        var revised = plan.document.deepCopy();
        revised.addProperty("revision", revised.get("revision").getAsInt() + 1);
        revised.add("ops", plan.remaining());
        revised.addProperty("expiresAt", System.currentTimeMillis() + PREVIEW_MILLIS);
        revised.remove("planHash");
        revised.addProperty("planHash", PlanCompiler.sha256(revised));
        var renewed = new SurveyPlan(revised);
        renewed.finalTargets.putAll(plan.finalTargets);
        renewed.protectedBaseline.putAll(plan.protectedBaseline);
        renewed.inheritProgress(plan);
        renewed.status = PAUSED;
        return issue(server, store, renewed, "resume");
    }

    static String cancel(ServerPlayerEntity player, UUID id) {
        var world = player.getWorld();
        var store = PlanStore.get(world.getServer());
        var plan = store.plans.get(id);
        String error = ownerCheck(player, plan);
        if (error != null) return deny(store, plan, id, "cancel", error);
        if (!plan.status.holdsSelection() && plan.status != PREVIEWED) {
            return deny(store, plan, id, "cancel", "not_cancellable");
        }
        revoke(world.getServer(), store, plan, CANCELLED, "owner_cancelled", true);
        return describe(plan);
    }

    private static String describe(SurveyPlan plan) {
        return PlanPresentation.statusLabel(plan.status) + (plan.reason.isEmpty() ? "" : " · " + describeReason(plan))
            + (plan.status == RUNNING ? " · " + progressLabel(plan) : "")
            + " · 越界 " + plan.violations + " · 放错 " + plan.misplacements
            + " · 现场变化 " + plan.siteChanges + " · 迟到操作 " + plan.lateAttempts;
    }

    private static String describeReason(SurveyPlan plan) {
        if (plan.status != PAUSED || plan.blockage == null) return reasonLabel(plan.reason);
        String reason = reasonLabel(string(plan.blockage, "reason"));
        if (plan.blockage.has("pos")) {
            reason += " · " + SurveyPlan.readPosition(plan.blockage.getAsJsonObject("pos")).toShortString();
        }
        if (plan.blockage.has("detail")) reason += " · " + plan.blockage.get("detail").getAsString();
        return reason;
    }

    private static String progressLabel(SurveyPlan plan) {
        String phase = PlanPresentation.phaseLabel(plan.phase);
        String waiting = switch (plan.waiting) {
            case "night" -> " · 夜里停工";
            case "chest_full" -> " · 等材料箱腾出空间";
            case "materials" -> {
                var requirements = new ArrayList<String>();
                plan.missing.entrySet().forEach(entry -> requirements.add(entry.getKey() + " ×" + entry.getValue().getAsInt()));
                yield " · 等材料" + (requirements.isEmpty() ? "" : " " + String.join("、", requirements));
            }
            default -> "";
        };
        int completed = plan.execute ? plan.completed() : plan.completedBefore + Math.max(plan.appliedCount, plan.reportedProgress);
        return phase + " · " + completed + "/" + plan.total() + waiting;
    }

    static String reasonLabel(String reason) {
        return switch (reason) {
            case "disabled" -> "游戏内授权未启用";
            case "authorization_disabled" -> "游戏内授权已关闭";
            case "authorization_changed" -> "主人或机器人配置已更改";
            case "wrong_owner" -> "只有配置的主人可以操作";
            case "missing_plan" -> "找不到计划";
            case "wrong_world" -> "计划属于另一个世界";
            case "wrong_dimension" -> "请回到计划所在维度";
            case "preview_expired" -> "预览已过期，请重新预览";
            case "preview_superseded" -> "预览已作废，请使用最新的重新比对";
            case "template_revision_unavailable" -> "原房型版本不可用";
            case "preview_conflicts" -> "有现场冲突，不能确认";
            case "overlapping_plan" -> "已有进行中的计划和此选区重叠";
            case "bot_busy" -> "机器人正在处理另一份计划";
            case "bot_unavailable" -> "机器人尚未连接计划频道";
            case "bot_died" -> "机器人死亡";
            case "bot_wrong_dimension" -> "机器人不在计划所在维度";
            case "disconnected" -> "断线";
            case "server_restart" -> "服务器重启";
            case "owner_paused" -> "主人暂停";
            case "owner_cancelled" -> "主人取消";
            case "authorization_revoked" -> "选区正在等待机器人确认撤销";
            case "outside_authorized_operations" -> "机器人尝试了授权清单外的操作";
            case "server_final_state_changed" -> "现场目标格发生变化";
            case "protected_block_changed" -> "受保护格发生变化";
            case "expected_block_changed" -> "现场方块与预期不符";
            case "outside_selection" -> "需要改动原选区之外的方块";
            case "outside_attachment" -> "待挖方块有外部附着";
            case "cross_boundary_tree" -> "树超出选区";
            case "adjacent_fluid" -> "待挖方块贴着水或岩浆";
            case "falling_column" -> "沙或沙砾柱超出范围";
            case "no_reachable_stand", "no_reachable_station", "placement_station_unreachable" ->
                "没有可达的施工站位";
            case "placement_rejected", "misplacement_retries_exhausted" -> "多次放置仍未达到指定状态";
            case "supply_chest_unreachable" -> "无法走到材料箱";
            case "supply_chest_changed" -> "材料箱已发生变化";
            case "worksite_unreachable" -> "无法走到施工区域";
            case "site_changed" -> "施工现场已发生变化";
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
        pruneRevocations(store, System.nanoTime());
        if (store.revocations.values().stream().anyMatch(revocation ->
            !revocation.plan().status.holdsSelection() && overlaps(revocation.plan(), plan))) {
            return deny(store, store.plans.get(plan.id), plan.id, method, "authorization_revoked");
        }
        var bot = config.findBot(server);
        if (bot == null || !bot.isAlive() || !bot.getUuid().equals(plan.botUuid) || !PlanChannel.canReceiveGrant(bot)) {
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
        plan.phase = "";
        plan.waiting = "";
        plan.missing = new JsonObject();
        plan.blockage = null;
        plan.heartbeatDeadline = System.nanoTime() + HEARTBEAT_NANOS;
        store.plans.put(plan.id, plan);
        store.retireComparison(plan.id, "preview_superseded");
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
        PlanStatusFeed.transition(server, store, config, plan);
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
        var previous = plan.status;
        UUID oldGrant = plan.grantId;
        plan.grantId = null;
        plan.status = next;
        plan.reason = reason;
        plan.waiting = "";
        plan.missing = new JsonObject();
        if (plan.execute && !stopping) {
            var owner = server.getPlayerManager().getPlayer(plan.ownerUuid);
            if (owner != null) owner.sendMessage(Text.literal(describe(plan)), true);
        }
        if (next.finished()) {
            store.retireComparison(plan.id, "preview_superseded");
            store.recordFinish(plan);
        }
        if (!stopping && plan.ownerUuid.equals(config.ownerUuid())) PlanPresentation.transition(server, plan, previous);
        if (oldGrant != null) {
            store.revocations.put(plan.id, new PlanStore.Revocation(plan, oldGrant, System.nanoTime() + REVOKE_NANOS));
        }
        store.markDirty();
        if (notify && oldGrant != null) {
            var bot = server.getPlayerManager().getPlayer(plan.botUuid);
            if (bot != null && PlanChannel.isReady(bot)) {
                var message = new JsonObject();
                message.addProperty("type", "revoke");
                message.addProperty("grantId", oldGrant.toString());
                message.addProperty("reason", reason);
                message.addProperty("status", next.name().toLowerCase(Locale.ROOT));
                PlanChannel.send(bot, message);
            }
        }
        PlanStatusFeed.transition(server, store, config, plan);
    }

    private static void pruneRevocations(PlanStore store, long now) {
        store.revocations.values().removeIf(revocation -> now - revocation.deadline() >= 0);
    }

    private static void tick(MinecraftServer server) {
        var store = PlanStore.get(server);
        pruneRevocations(store, System.nanoTime());
        if (!config.enabled()) {
            PlanStatusFeed.publish(server, store, config, false);
            return;
        }
        for (var plan : store.plans.values()) {
            if (plan.status == PREVIEWED && expired(plan)) {
                expirePreview(server, store, plan);
            } else if (hasGrant(plan) && System.nanoTime() >= plan.heartbeatDeadline) {
                revoke(server, store, plan, PAUSED, "disconnected", true);
            } else if (plan.status == RUNNING && plan.execute && server.getTicks() % 20 == 0) {
                var owner = server.getPlayerManager().getPlayer(plan.ownerUuid);
                if (owner != null) owner.sendMessage(Text.literal(progressLabel(plan)), true);
            }
        }
        var elapsed = new ArrayList<UUID>();
        long now = System.currentTimeMillis();
        store.recomparisons.forEach((id, draft) -> {
            if (draft.compiled().document().get("expiresAt").getAsLong() <= now) elapsed.add(id);
        });
        elapsed.forEach(id -> store.retireComparison(id, "preview_expired"));
        store.trimHistory();
        PlanPresentation.tick(server, store, config.ownerUuid());
        PlanStatusFeed.publish(server, store, config, false);
    }

    private static void expirePreview(MinecraftServer server, PlanStore store, SurveyPlan plan) {
        plan.status = EXPIRED;
        plan.reason = "preview_expired";
        store.recordFinish(plan);
        PlanStatusFeed.transition(server, store, config, plan);
    }

    private static void receive(ServerPlayerEntity player, JsonObject message) {
        String type = string(message, "type");
        var world = player.getWorld();
        var server = world.getServer();
        if (!PlanChannel.isReady(player)) return;
        if (type.equals("status_query")) {
            PlanStatusFeed.subscribe(server, PlanStore.get(server), config, player);
            return;
        }
        if (!type.equals("revoke_ack") && (!config.enabled() || !config.isBot(player) || !PlanChannel.canReceiveGrant(player))) return;
        var store = PlanStore.get(server);
        if (type.equals("revoke_ack")) {
            String grantId = string(message, "grantId");
            store.revocations.values().removeIf(revocation -> revocation.plan().botUuid.equals(player.getUuid())
                && revocation.grantId().toString().equals(grantId));
            return;
        }
        if (!CLIENT_MESSAGES.contains(type)) return;
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
            var conflict = siteProblem(world, plan);
            if (conflict != null) {
                plan.siteChanges++;
                recordSiteBlockage(plan, conflict.reason(), conflict.pos());
                revoke(server, store, plan, PAUSED, conflict.message(), true);
                return;
            }
            plan.status = RUNNING;
            plan.execute = truth(message.get("execute"));
            plan.heartbeatDeadline = System.nanoTime() + HEARTBEAT_NANOS;
            if (!stopping && plan.ownerUuid.equals(config.ownerUuid())) PlanPresentation.transition(server, plan, CONFIRMED);
            store.markDirty();
            var running = identity(plan);
            running.addProperty("type", "running");
            PlanChannel.send(player, running);
            PlanStatusFeed.transition(server, store, config, plan);
            if (!plan.execute) finishIfDone(world, store, plan);
            return;
        }
        switch (type) {
            case "heartbeat" -> plan.heartbeatDeadline = System.nanoTime() + HEARTBEAT_NANOS;
            case "progress" -> {
                Integer count = integer(message.get("completed"));
                if (count == null || count < 0 || count > plan.document.getAsJsonArray("ops").size()) return;
                if (count != plan.reportedProgress) {
                    plan.reportedProgress = count;
                    store.markDirty();
                }
                if (plan.execute && truth(message.get("settled")) && count == plan.appliedCount) {
                    finishIfDone(world, store, plan);
                }
            }
            case "state" -> {
                if (plan.execute) receiveState(store, plan, message);
            }
            case "blocked" -> {
                if (plan.execute) receiveBlocked(server, store, plan, message);
            }
        }
    }

    private static void receiveState(PlanStore store, SurveyPlan plan, JsonObject message) {
        if (!isString(message.get("phase"))) return;
        String phase = string(message, "phase");
        if (!phase.isEmpty() && !plan.phases.contains(phase)) return;
        var waitingValue = message.get("waiting");
        if (waitingValue == null) return;
        String waiting = waitingValue.isJsonNull() ? "" : string(message, "waiting");
        if (!waitingValue.isJsonNull() && !WAITING_REASONS.contains(waiting)) return;
        var missing = new JsonObject();
        var requirements = message.get("missing");
        if (waiting.equals("materials") && requirements != null) {
            if (!requirements.isJsonObject() || requirements.getAsJsonObject().size() > 128) return;
            for (var entry : requirements.getAsJsonObject().entrySet()) {
                Integer quantity = integer(entry.getValue());
                if (entry.getKey().length() > 128 || !entry.getKey().matches("[a-z0-9_.-]+:[a-z0-9_/.-]+")
                    || quantity == null || quantity <= 0 || quantity > 100_000) return;
                missing.addProperty(entry.getKey(), quantity);
            }
        }
        if (plan.phase.equals(phase) && plan.waiting.equals(waiting) && plan.missing.equals(missing)) return;
        plan.phase = phase;
        plan.waiting = waiting;
        plan.missing = missing;
        store.markDirty();
    }

    private static void receiveBlocked(MinecraftServer server, PlanStore store, SurveyPlan plan, JsonObject message) {
        String reason = string(message, "reason");
        String detail = string(message, "detail");
        if (reason.isBlank() || reason.length() > 96 || detail.length() > 300) return;
        var blockage = new JsonObject();
        blockage.addProperty("reason", reason);
        if (message.has("pos") && !message.get("pos").isJsonNull()) {
            if (!message.get("pos").isJsonObject()) return;
            var pos = message.getAsJsonObject("pos");
            Integer x = integer(pos.get("x"));
            Integer y = integer(pos.get("y"));
            Integer z = integer(pos.get("z"));
            if (x == null || y == null || z == null) return;
            var block = new BlockPos(x, y, z);
            blockage.add("pos", position(block));
        }
        if (!detail.isBlank()) {
            blockage.addProperty("detail", detail);
        }
        plan.blockage = blockage;
        revoke(server, store, plan, PAUSED, reason, true);
    }

    private static boolean truth(JsonElement value) {
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isBoolean() && value.getAsBoolean();
    }

    private static Integer integer(JsonElement value) {
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()
            || !value.getAsString().matches("-?(0|[1-9][0-9]{0,8})")) return null;
        return value.getAsInt();
    }

    private static String string(JsonObject json, String field) {
        var value = json.get(field);
        return isString(value) ? value.getAsString() : "";
    }

    private static boolean isString(JsonElement value) {
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString();
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

    private static PlanCompiler.SiteProblem siteProblem(ServerWorld world, SurveyPlan plan) {
        return PlanCompiler.siteProblem(world, plan.document, plan.remaining(), plan.finalTargets, plan.protectedBaseline);
    }

    private static void recordSiteBlockage(SurveyPlan plan, String reason, BlockPos pos) {
        var blockage = new JsonObject();
        blockage.addProperty("reason", reason);
        blockage.add("pos", position(pos));
        blockage.addProperty("dimension", plan.dimension);
        plan.blockage = blockage;
    }

    private static boolean allowBreak(ServerWorld world, ServerPlayerEntity player, BlockPos pos, BlockState state) {
        if (!guardsInteractions(player)) return true;
        return allowed(world, player, "break", pos, PlanInteraction.footprint(pos, state, Blocks.AIR.getDefaultState()), false);
    }

    public static boolean guardsInteractions(ServerPlayerEntity player) {
        var store = PlanStore.get(player.getWorld().getServer());
        var botId = player.getUuid();
        for (var plan : store.plans.values()) {
            if (plan.status.holdsSelection() && botId.equals(plan.botUuid)) return true;
        }
        for (var revocation : store.revocations.values()) {
            if (botId.equals(revocation.plan().botUuid)) return true;
        }
        return false;
    }

    public static boolean allowInteraction(ServerWorld world, ServerPlayerEntity player, String action, BlockPos origin,
                                           Map<BlockPos, BlockState> targets, boolean custom) {
        return allowed(world, player, action, origin, targets, custom);
    }

    private static boolean allowed(ServerWorld world, ServerPlayerEntity player, String action, BlockPos origin,
                                   Map<BlockPos, BlockState> targets, boolean custom) {
        var server = world.getServer();
        var store = PlanStore.get(server);
        long now = System.nanoTime();
        String dimension = dimension(world);
        UUID botId = player.getUuid();
        pruneRevocations(store, now);
        for (var revocation : store.revocations.values()) {
            var plan = revocation.plan();
            if (!plan.status.holdsSelection() && botId.equals(plan.botUuid) && plan.dimension.equals(dimension)) {
                var blocked = insideSelection(plan, targets);
                if (blocked != null) return rejectChange(store, plan, action, blocked, "authorization_revoked", BlockDenial.LATE_ATTEMPT);
            }
        }

        SurveyPlan matching = null;
        for (var plan : store.plans.values()) {
            if (!plan.status.holdsSelection() || !botId.equals(plan.botUuid)) continue;
            boolean sameDimension = plan.dimension.equals(dimension);
            boolean timedOut = hasGrant(plan) && now - plan.heartbeatDeadline >= 0;
            if (timedOut) revoke(server, store, plan, PAUSED, "disconnected", true);
            if (plan.status == RUNNING) {
                matching = plan;
                if (!sameDimension) return rejectViolation(server, store, plan, action, origin, "outside_authorized_operations");
                break;
            }
            if (sameDimension) {
                var blocked = insideSelection(plan, targets);
                if (blocked != null) {
                    return rejectChange(store, plan, action, blocked,
                        timedOut ? "authorization_expired" : "authorization_inactive", BlockDenial.LATE_ATTEMPT);
                }
            }
        }
        if (matching == null) return true;
        if (custom) return rejectViolation(server, store, matching, action, origin, "custom_item_data");
        for (var target : targets.entrySet()) {
            var pos = target.getKey();
            var op = matching.next(pos);
            if (op == null) {
                return rejectViolation(server, store, matching, action, pos, "outside_authorized_operations");
            }
            var current = world.getBlockState(pos);
            if (!PlanCompiler.matchesExpect(world, pos, op.kind(), op.expect(), op.target(), current)) {
                recordSiteBlockage(matching, "expected_block_changed", pos);
                revoke(server, store, matching, PAUSED, mismatch(pos, op.expect(), PlanCompiler.stateName(current)), true);
                return rejectChange(store, matching, action, pos, "expected_block_changed", BlockDenial.SITE_CHANGE);
            }
            if (!PlanCompiler.matchesState(op.target(), target.getValue())) {
                // The placement mixin preflights the primary cell before a multi-block footprint
                // (e.g. the head of a bed). A wrong primary orientation is rejected before writes.
                if (action.equals("place") && !target.getValue().isAir() && sameBlock(op.target(), target.getValue())) {
                    return rejectMisplacement(store, matching, player, pos, op.target(), target.getValue());
                }
                return rejectViolation(server, store, matching, action, pos, "outside_authorized_operations");
            }
            if (target.getValue().isAir() && !current.isAir()) {
                var conflict = PlanCompiler.removalProblem(world, matching.document, pos, targets::containsKey);
                if (conflict != null) {
                    recordSiteBlockage(matching, conflict.reason(), conflict.pos());
                    revoke(server, store, matching, PAUSED, conflict.message(), true);
                    return rejectChange(store, matching, action, pos, "expected_block_changed", BlockDenial.SITE_CHANGE);
                }
            }
        }
        return true;
    }

    private static BlockPos insideSelection(SurveyPlan plan, Map<BlockPos, BlockState> targets) {
        for (var pos : targets.keySet()) {
            if (plan.contains(pos)) return pos;
        }
        return null;
    }

    public static void observeInteraction(ServerWorld world, ServerPlayerEntity player, Map<BlockPos, BlockState> changes) {
        if (!config.enabled() || !config.isBot(player)) return;
        var server = world.getServer();
        var store = PlanStore.get(server);
        for (var plan : store.plans.values()) {
            if (plan.status != RUNNING || !player.getUuid().equals(plan.botUuid) || !plan.dimension.equals(dimension(world))) continue;
            var positions = new JsonArray();
            changes.forEach((pos, before) -> {
                var operation = plan.next(pos);
                BlockState actual = world.getBlockState(pos);
                // The original state was checked before the write. The transaction records
                // which authorized writes were actually applied, including both halves.
                if (operation != null && before != actual && PlanCompiler.matchesState(operation.target(), actual)) {
                    plan.consume(pos);
                    positions.add(position(pos));
                }
            });
            if (positions.isEmpty()) continue;
            store.markDirty();
            if (plan.execute) {
                var applied = identity(plan);
                applied.addProperty("type", "applied");
                applied.add("positions", positions);
                PlanChannel.send(player, applied);
            } else {
                finishIfDone(world, store, plan);
            }
        }
    }

    private static void finishIfDone(ServerWorld world, PlanStore store, SurveyPlan plan) {
        if (plan.completed() != plan.total()) return;
        var server = world.getServer();
        if (plan.violations > 0) {
            revoke(server, store, plan, FAILED, "outside_authorized_operations", true);
        } else {
            var changedProtected = plan.protectedBaseline.entrySet().stream().filter(entry ->
                !PlanCompiler.matchesState(entry.getValue(), world.getBlockState(entry.getKey())))
                .map(Map.Entry::getKey).findFirst().orElse(null);
            boolean randomTicksEnabled = world.getGameRules().getInt(GameRules.RANDOM_TICK_SPEED) > 0;
            var changedTarget = plan.finalTargets.entrySet().stream().filter(target ->
                !PlanCompiler.matchesFinalTarget(plan.document, target.getKey(), target.getValue(),
                    world.getBlockState(target.getKey()), randomTicksEnabled))
                .map(Map.Entry::getKey).findFirst().orElse(null);
            if (changedProtected == null && changedTarget == null) {
                revoke(server, store, plan, COMPLETED, "", true);
                return;
            }
            plan.siteChanges++;
            String reason = changedProtected == null ? "server_final_state_changed" : "protected_block_changed";
            recordSiteBlockage(plan, reason, changedProtected == null ? changedTarget : changedProtected);
            revoke(server, store, plan, PAUSED, reason, true);
        }
    }

    private static String mismatch(BlockPos pos, String expected, String actual) {
        return "expected_block_changed at " + pos.toShortString() + " expected " + expected + " actual " + actual;
    }

    static boolean sameBlock(String expected, BlockState state) {
        int properties = expected.indexOf('[');
        String id = properties < 0 ? expected : expected.substring(0, properties);
        return Registries.BLOCK.getId(state.getBlock()).toString().equals(id);
    }

    private static boolean rejectViolation(MinecraftServer server, PlanStore store, SurveyPlan plan,
                                           String action, BlockPos pos, String reason) {
        rejectChange(store, plan, action, pos, reason, BlockDenial.VIOLATION);
        if (plan.execute) revoke(server, store, plan, FAILED, "outside_authorized_operations", true);
        return false;
    }

    private static boolean rejectMisplacement(PlanStore store, SurveyPlan plan, ServerPlayerEntity player, BlockPos pos,
                                              String expected, BlockState state) {
        rejectChange(store, plan, "place", pos, "wrong_block_state", BlockDenial.MISPLACEMENT);
        if (plan.execute) {
            var message = identity(plan);
            message.addProperty("type", "misplacement");
            message.add("pos", position(pos));
            message.addProperty("expected", expected);
            message.addProperty("actual", PlanCompiler.stateName(state));
            message.addProperty("misplacements", plan.misplacements);
            PlanChannel.send(player, message);
        }
        return false;
    }

    private static JsonObject position(BlockPos pos) {
        var position = new JsonObject();
        position.addProperty("x", pos.getX());
        position.addProperty("y", pos.getY());
        position.addProperty("z", pos.getZ());
        return position;
    }

    private static boolean rejectChange(PlanStore store, SurveyPlan plan, String action, BlockPos pos, String reason,
                                        BlockDenial denial) {
        switch (denial) {
            case VIOLATION -> plan.violations++;
            case SITE_CHANGE -> plan.siteChanges++;
            case LATE_ATTEMPT -> plan.lateAttempts++;
            case MISPLACEMENT -> plan.misplacements++;
        }
        var event = new JsonObject();
        event.addProperty("planId", plan.id.toString());
        event.addProperty("category", denial.name().toLowerCase(Locale.ROOT));
        event.addProperty("action", action);
        event.add("pos", position(pos));
        event.addProperty("reason", reason);
        store.audit(store.rejections, event);
        LOGGER.warn("Survey plan block change rejected: {}", event);
        return false;
    }
}
