package dev.deskpet.minecraft.plan;

import com.google.gson.JsonArray;
import dev.deskpet.minecraft.wand.WandInteractions;
import net.minecraft.entity.boss.BossBar;
import net.minecraft.entity.boss.ServerBossBar;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.Text;
import net.minecraft.util.math.BlockPos;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

final class PlanPresentation {
    private static final DateTimeFormatter HISTORY_TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm z", Locale.ROOT);
    private static UUID displayedPlan;
    private static ServerBossBar bar;

    private PlanPresentation() {}

    static void tick(MinecraftServer server, PlanStore store, UUID ownerId) {
        var owner = ownerId == null ? null : server.getPlayerManager().getPlayer(ownerId);
        if (owner == null) {
            clear();
            return;
        }
        SurveyPlan active = null;
        for (var plan : store.plans.values()) {
            if (plan.status.holdsSelection() && ownerId.equals(plan.ownerUuid)) active = plan;
        }
        if (active == null) {
            clear();
            return;
        }
        if (!active.id.equals(displayedPlan)) {
            clear();
            displayedPlan = active.id;
            bar = new ServerBossBar(Text.empty(), BossBar.Color.BLUE, BossBar.Style.PROGRESS);
        }
        var suffix = contextualStatus(active);
        var name = house(active) + " · " + phaseLabel(active.phase) + " · " + count(active)
            + (suffix.isEmpty() ? "" : " · " + suffix);
        if (!bar.getPlayers().contains(owner)) bar.clearPlayers();
        bar.setName(Text.literal(name));
        bar.setPercent(active.total() == 0 ? 1 : Math.clamp((float) active.completed() / active.total(), 0, 1));
        bar.setColor(active.status == SurveyPlan.Status.PAUSED ? BossBar.Color.YELLOW : BossBar.Color.BLUE);
        bar.addPlayer(owner);
    }

    static void clear() {
        if (bar != null) bar.clearPlayers();
        bar = null;
        displayedPlan = null;
    }

    static void transition(MinecraftServer server, SurveyPlan plan, SurveyPlan.Status previous) {
        if (previous == plan.status) return;
        String event = switch (plan.status) {
            case RUNNING -> plan.started ? "" : "开工";
            case PAUSED -> "暂停";
            case COMPLETED -> "完成";
            case FAILED -> "失败";
            case CANCELLED -> "取消";
            default -> "";
        };
        if (plan.status == SurveyPlan.Status.RUNNING) plan.started = true;
        if (event.isEmpty()) return;
        var owner = server.getPlayerManager().getPlayer(plan.ownerUuid);
        if (owner == null) return;
        String reason = PlanService.reasonLabel(plan.reason);
        BlockPos pos = blockage(plan);
        owner.sendMessage(Text.literal("【施工】 " + event + " · " + house(plan) + " · " + count(plan)
            + (reason.isEmpty() ? "" : " · " + reason) + (pos == null ? "" : " · " + pos.toShortString())), false);
    }

    static WandInteractions.Progress progress(SurveyPlan plan, boolean includeRemaining) {
        var pos = blockage(plan);
        boolean death = plan.reason.equals("bot_died");
        String reason = PlanService.reasonLabel(plan.reason);
        String wait = waitingLabel(plan.waiting);
        var lines = new ArrayList<String>();
        lines.add(house(plan) + " · 版本 " + plan.document.get("revision").getAsInt());
        lines.add(statusLabel(plan.status) + (reason.isEmpty() ? "" : " · " + reason));
        lines.add(phaseLabel(plan.phase) + " · " + count(plan) + (wait.isEmpty() ? "" : " · " + wait));
        for (var item : plan.missing.entrySet()) {
            lines.add("缺料 " + item.getKey() + " ×" + item.getValue().getAsInt());
        }
        if (pos != null) lines.add((death ? "机器人死亡" : "受阻") + " · " + pos.toShortString());
        if (plan.blockage != null && plan.blockage.has("detail")) {
            lines.add(plan.blockage.get("detail").getAsString());
        }
        lines.add("越界 " + plan.violations + " · 放错 " + plan.misplacements
            + " · 现场变化 " + plan.siteChanges + " · 迟到操作 " + plan.lateAttempts);
        String dimension = plan.blockage != null && plan.blockage.has("dimension")
            ? plan.blockage.get("dimension").getAsString() : plan.dimension;
        return new WandInteractions.Progress(plan.document.get("revision").getAsInt(),
            plan.status.name().toLowerCase(Locale.ROOT), plan.dimension, List.copyOf(lines), pos, dimension, death,
            includeRemaining && plan.status.holdsSelection() ? plan.remaining() : new JsonArray());
    }

    static List<WandInteractions.HistoryEntry> history(PlanStore store, ServerPlayerEntity owner) {
        var finished = new ArrayList<SurveyPlan>();
        for (var plan : store.plans.values()) {
            if (plan.status.finished() && plan.ownerUuid.equals(owner.getUuid())) finished.add(plan);
        }
        Collections.reverse(finished);
        finished.sort(Comparator.comparingLong((SurveyPlan plan) -> plan.finishOrder).reversed());
        return finished.stream().limit(20).map(plan -> {
            String reason = PlanService.reasonLabel(plan.reason);
            String time = plan.finishedAt > 0 ? HISTORY_TIME.format(Instant.ofEpochMilli(plan.finishedAt).atZone(ZoneId.systemDefault()))
                : "旧记录未保存结束时间";
            return new WandInteractions.HistoryEntry(house(plan) + " · " + statusLabel(plan.status),
                reason.isEmpty() ? List.of(time) : List.of(reason, time));
        }).toList();
    }

    private static String house(SurveyPlan plan) {
        return WandInteractions.templateLabel(plan.document.getAsJsonObject("template").get("id").getAsString());
    }

    private static BlockPos blockage(SurveyPlan plan) {
        if (plan.status != SurveyPlan.Status.PAUSED || plan.blockage == null || !plan.blockage.has("pos")) return null;
        return SurveyPlan.readPosition(plan.blockage.getAsJsonObject("pos"));
    }

    private static String count(SurveyPlan plan) {
        return plan.completed() + "/" + plan.total();
    }

    private static String contextualStatus(SurveyPlan plan) {
        return switch (plan.status) {
            case CONFIRMED -> "等待机器人接单";
            case PAUSED -> "已暂停 · " + PlanService.reasonLabel(plan.reason);
            default -> waitingLabel(plan.waiting);
        };
    }

    static String statusLabel(SurveyPlan.Status status) {
        return switch (status) {
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
    }

    static String phaseLabel(String phase) {
        return switch (phase) {
            case "terrain" -> "整地";
            case "foundation" -> "地基";
            case "scaffold" -> "搭脚手架";
            case "stair_base" -> "安装楼梯起步";
            case "walls" -> "砌墙";
            case "upper_walls" -> "砌上部墙体";
            case "floor" -> "铺楼板与楼梯";
            case "roof" -> "盖屋顶";
            case "furnish" -> "布置家具";
            case "remove_scaffold" -> "拆脚手架";
            case "irrigate" -> "放水";
            case "till" -> "锄地";
            case "sow" -> "播种";
            case "" -> "施工";
            default -> phase;
        };
    }

    private static String waitingLabel(String waiting) {
        return switch (waiting) {
            case "night" -> "夜里停工";
            case "materials" -> "等材料";
            case "chest_full" -> "等材料箱腾出空间";
            default -> "";
        };
    }
}
