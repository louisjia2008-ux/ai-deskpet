package dev.deskpet.minecraft.plan;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import dev.deskpet.minecraft.PlanChannel;
import dev.deskpet.minecraft.WorldIdentity;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;

import java.util.Locale;

/** Sends a bounded, read-only view of the Mod's authoritative state. */
final class PlanStatusFeed {
    private static ServerPlayerEntity subscriber;
    private static JsonElement last;

    private PlanStatusFeed() {}

    static void clear() {
        subscriber = null;
        last = null;
    }

    static void disconnect(ServerPlayerEntity player) {
        if (subscriber == player) clear();
    }

    static void subscribe(MinecraftServer server, PlanStore store, PlanConfig config, ServerPlayerEntity player) {
        if (!config.isBot(player)) return;
        subscriber = player;
        publish(server, store, config, true);
    }

    static void transition(MinecraftServer server, PlanStore store, PlanConfig config, SurveyPlan changed) {
        if (subscriber == null || !PlanChannel.isReady(subscriber) || !config.isBot(subscriber)) return;
        if (visible(changed, config, subscriber) && changed != current(store, config, subscriber)) {
            send(server, snapshot(changed), false, false);
        }
        publish(server, store, config, false);
    }

    static void publish(MinecraftServer server, PlanStore store, PlanConfig config, boolean initial) {
        if (subscriber == null || !PlanChannel.isReady(subscriber)) return;
        var plan = config.isBot(subscriber) ? current(store, config, subscriber) : null;
        JsonElement view = plan == null ? JsonNull.INSTANCE : snapshot(plan);
        if (!initial && view.equals(last)) return;
        send(server, view, initial, true);
        last = view;
    }

    private static void send(MinecraftServer server, JsonElement view, boolean initial, boolean current) {
        var message = new JsonObject();
        message.addProperty("type", "plan_status");
        message.addProperty("worldId", WorldIdentity.get(server).toString());
        message.addProperty("initial", initial);
        if (!current) message.addProperty("current", false);
        message.add("plan", view);
        PlanChannel.send(subscriber, message);
    }

    private static boolean visible(SurveyPlan plan, PlanConfig config, ServerPlayerEntity bot) {
        return plan.ownerUuid.equals(config.ownerUuid()) && bot.getUuid().equals(plan.botUuid);
    }

    private static SurveyPlan current(PlanStore store, PlanConfig config, ServerPlayerEntity bot) {
        SurveyPlan latest = null;
        for (var plan : store.plans.values()) {
            if (!visible(plan, config, bot)) continue;
            if (plan.status.holdsSelection()) return plan;
            if (plan.status != SurveyPlan.Status.DRAFT) latest = plan;
        }
        return latest;
    }

    static JsonObject snapshot(SurveyPlan plan) {
        var view = new JsonObject();
        view.addProperty("planId", plan.id.toString());
        view.add("revision", plan.document.get("revision"));
        view.add("template", plan.document.getAsJsonObject("template").get("id"));
        view.addProperty("status", plan.status.name().toLowerCase(Locale.ROOT));
        if (!plan.reason.isEmpty()) view.addProperty("reason", plan.reason);
        if (!plan.phase.isEmpty()) view.addProperty("phase", plan.phase);
        if (!plan.waiting.isEmpty()) view.addProperty("waiting", plan.waiting);
        if (plan.blockage != null) view.add("blocked", plan.blockage.deepCopy());
        view.addProperty("completed", plan.completed());
        view.addProperty("total", plan.total());
        view.addProperty("violations", plan.violations);
        view.addProperty("misplacements", plan.misplacements);
        view.addProperty("siteChanges", plan.siteChanges);
        view.addProperty("lateAttempts", plan.lateAttempts);
        view.addProperty("started", plan.started);
        if (plan.finishedAt > 0) view.addProperty("finishedAt", plan.finishedAt);
        return view;
    }
}
