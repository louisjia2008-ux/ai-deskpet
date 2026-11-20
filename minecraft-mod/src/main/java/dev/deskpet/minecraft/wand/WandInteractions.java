package dev.deskpet.minecraft.wand;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.brigadier.exceptions.SimpleCommandExceptionType;
import dev.deskpet.minecraft.WorldIdentity;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.block.ChestBlock;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.item.ItemUsageContext;
import net.minecraft.registry.Registries;
import net.minecraft.registry.RegistryKey;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.text.Text;
import net.minecraft.util.ActionResult;
import net.minecraft.util.Hand;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.World;

import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class WandInteractions {
    public interface Authorization {
        default boolean enabled() { return false; }
        default boolean isOwner(ServerPlayerEntity owner) { return false; }
        default UUID botUuid(ServerPlayerEntity owner) { return null; }
        default UUID active(ServerPlayerEntity owner) { return null; }
        default void preview(ServerPlayerEntity owner, JsonObject plan) {}
        default String confirm(ServerPlayerEntity owner, UUID planId) { return "确认开工尚未启用"; }
        default String pause(ServerPlayerEntity owner, UUID planId) { return ""; }
        default String resume(ServerPlayerEntity owner, UUID planId) { return ""; }
        default String cancel(ServerPlayerEntity owner, UUID planId) { return ""; }
        default JsonObject recompare(ServerPlayerEntity owner, UUID planId) { return new JsonObject(); }
        default Progress progress(ServerPlayerEntity owner, UUID planId, boolean includeRemaining) { return null; }
        default List<HistoryEntry> history(ServerPlayerEntity owner) { return List.of(); }
    }

    public record Progress(int revision, String status, String dimension, List<String> lines,
                           BlockPos blockage, String blockageDimension, boolean death, JsonArray remaining) {}
    public record HistoryEntry(String title, List<String> lines) {}

    private static final Identifier WAND_ID = Identifier.of("deskpet", "survey_wand");
    private static final Map<UUID, Selection> SELECTIONS = new HashMap<>();
    private static final SimpleCommandExceptionType NOT_OWNER = new SimpleCommandExceptionType(
        Text.literal("只有配置的主人可以查看施工计划"));
    private static Authorization authorization = new Authorization() {};

    private WandInteractions() {}

    public static void authorization(Authorization implementation) {
        authorization = implementation;
    }

    static Authorization authorization() {
        return authorization;
    }

    public static void register() {
        CommandRegistrationCallback.EVENT.register((dispatcher, access, environment) ->
            dispatcher.register(CommandManager.literal("deskpet").then(CommandManager.literal("plan").executes(context -> {
                var player = context.getSource().getPlayerOrThrow();
                if (!authorization.isOwner(player)) throw NOT_OWNER.create();
                var selection = selection(player, player.getWorld());
                selection.showManagement(authorization.active(player));
                var progress = selection.progress();
                player.sendMessage(Text.literal(progress == null ? "当前没有施工计划" : String.join("\n", progress.lines())), false);
                selection.open();
                return 1;
            }))));
        UseBlockCallback.EVENT.register((player, world, hand, hit) -> {
            if (player instanceof ServerPlayerEntity serverPlayer && !player.isSpectator() &&
                Registries.ITEM.getId(player.getStackInHand(hand).getItem()).equals(WAND_ID)) {
                return onBlock(serverPlayer, (ServerWorld) world, hit.getBlockPos());
            }
            return ActionResult.PASS;
        });
        ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> remove(handler.player.getUuid()));
        ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
            SELECTIONS.values().forEach(Selection::close);
            SELECTIONS.clear();
        });
        ServerTickEvents.END_SERVER_TICK.register(server -> {
            long now = System.currentTimeMillis();
            for (Selection selection : SELECTIONS.values()) {
                if (selection.preview != null && selection.displayExpired(now)) selection.clearDisplay();
            }
        });
    }

    public static ActionResult useOnBlock(ItemUsageContext context) {
        if (context.getPlayer() instanceof ServerPlayerEntity player && !player.isSpectator()) {
            return onBlock(player, (ServerWorld) context.getWorld(), context.getBlockPos());
        }
        return ActionResult.PASS;
    }

    private static ActionResult onBlock(ServerPlayerEntity player, ServerWorld world, BlockPos pos) {
        Selection selection = selection(player, world);
        if (player.isSneaking() && world.getBlockState(pos).getBlock() instanceof ChestBlock) {
            selection.supplyChest = pos.toImmutable();
            selection.invalidate();
            message(player, "材料箱 " + label(pos));
            return ActionResult.SUCCESS;
        }
        if (selection.first == null || selection.second != null) {
            selection.first = pos.toImmutable();
            selection.second = null;
            selection.settings = PlanCompiler.Settings.defaults();
            selection.invalidate();
            message(player, "角 1 " + label(pos));
        } else {
            PlanCompiler.Area area = PlanCompiler.Area.between(selection.first, pos);
            if (area.width() > PlanCompiler.MAX_WIDTH || area.length() > PlanCompiler.MAX_WIDTH) {
                message(player, "选区最多 48×48，请选择更近的角 2");
            } else {
                selection.second = pos.toImmutable();
                selection.invalidate();
                message(player, "角 2 " + label(pos) + " · " + area.width() + "×" + area.length());
            }
        }
        return ActionResult.SUCCESS;
    }

    public static ActionResult use(World world, PlayerEntity actor, Hand hand) {
        if (!(actor instanceof ServerPlayerEntity player) || player.isSpectator()) {
            return ActionResult.PASS;
        }
        Selection selection = selection(player, (ServerWorld) world);
        if (player.isSneaking()) {
            selection.undo();
        } else if (selection.second != null && !selection.isManagement()) {
            if (selection.result == null) {
                selection.compile();
            }
            selection.open();
        } else {
            UUID active = selection.managing != null ? selection.managing : authorization.active(player);
            if (active != null) {
                if (!selection.isManagement()) selection.showManagement(active);
                selection.open();
            } else {
                message(player, "用法杖右键方块设置两个角");
            }
        }
        return ActionResult.SUCCESS;
    }

    private static Selection selection(ServerPlayerEntity player, ServerWorld world) {
        UUID id = player.getUuid();
        Selection existing = SELECTIONS.get(id);
        if (existing == null || !existing.dimension.equals(world.getRegistryKey()) || existing.owner != player) {
            remove(id);
            existing = new Selection(player, world);
            SELECTIONS.put(id, existing);
        }
        return existing;
    }

    private static void remove(UUID id) {
        Selection selection = SELECTIONS.remove(id);
        if (selection != null) {
            selection.close();
        }
    }

    static void message(ServerPlayerEntity player, String message) {
        if (!message.isBlank()) {
            player.sendMessage(Text.literal(message), true);
        }
    }

    static String label(BlockPos pos) {
        return "(" + pos.getX() + ", " + pos.getY() + ", " + pos.getZ() + ")";
    }

    public static String templateLabel(String id) {
        for (var house : HouseTemplates.Type.values()) {
            if (house.id.equals(id)) return house.label;
        }
        return id;
    }

    static final class Selection {
        final ServerPlayerEntity owner;
        final ServerWorld world;
        final RegistryKey<World> dimension;
        final EnumSet<WandPreview.Layer> layers = EnumSet.allOf(WandPreview.Layer.class);
        BlockPos first;
        BlockPos second;
        BlockPos supplyChest;
        UUID managing;
        boolean managePage;
        boolean historyPage;
        boolean showRemaining;
        JsonObject comparison;
        private ProgressMarkers progressMarkers;
        PlanCompiler.Result result;
        PlanCompiler.Settings settings = PlanCompiler.Settings.defaults();
        WandMenu menu;
        WandPreview preview;

        private record ProgressMarkers(BlockPos blockage, boolean death, JsonArray remaining) {}

        Selection(ServerPlayerEntity owner, ServerWorld world) {
            this.owner = owner;
            this.world = world;
            this.dimension = world.getRegistryKey();
        }

        void undo() {
            if (second != null) {
                second = null;
                message(owner, "已撤销角 2");
            } else if (first != null) {
                first = null;
                message(owner, "已撤销角 1");
            }
            invalidate();
            close();
        }

        void invalidate() {
            clearDisplay();
            result = null;
            managing = null;
            managePage = false;
            historyPage = false;
            comparison = null;
        }

        void compile() {
            if (second == null) {
                return;
            }
            UUID worldId = WorldIdentity.get(world.getServer());
            result = PlanCompiler.compile(PlanCompiler.view(world), new PlanCompiler.Request(
                UUID.randomUUID(), 1, worldId, dimension.getValue().toString(), owner.getUuid(),
                authorization.botUuid(owner), PlanCompiler.Area.between(first, second), settings,
                supplyChest, System.currentTimeMillis()));
            settings = new PlanCompiler.Settings(settings.house(), settings.rotation(), result.shiftX(), result.shiftZ(),
                settings.groundOffset(), settings.mode(), settings.fillDepth(), settings.clipTrees());
            if (result.valid()) {
                authorization.preview(owner, result.plan());
            }
        }

        void open() {
            if (menu != null && menu.isOpen()) {
                menu.refresh();
                return;
            }
            menu = new WandMenu(this);
            if (menu.open()) {
                refreshDisplay();
            }
        }

        boolean isManagement() {
            return managePage;
        }

        void showManagement(UUID id) {
            managePage = true;
            managing = id;
            historyPage = false;
            comparison = null;
            clearDisplay();
        }

        Progress progress() {
            return managing == null ? null : authorization.progress(owner, managing, showRemaining);
        }

        JsonObject comparisonPlan() {
            return comparison.getAsJsonObject("plan");
        }

        boolean displayExpired(long now) {
            if (owner.getWorld() != world) return true;
            var plan = comparison != null ? comparisonPlan() : !managePage && result != null ? result.plan() : null;
            return plan != null && (plan.get("expiresAt").getAsLong() <= now || !inReach(plan));
        }

        void clearDisplay() {
            if (preview != null) {
                preview.destroy();
                preview = null;
            }
            progressMarkers = null;
        }

        boolean inReach(JsonObject plan) {
            if (owner.getWorld() != world) {
                return false;
            }
            var selection = plan.getAsJsonObject("selection");
            BlockPos at = owner.getBlockPos();
            return at.getX() >= selection.get("minX").getAsInt() - 32 && at.getX() <= selection.get("maxX").getAsInt() + 32 &&
                at.getZ() >= selection.get("minZ").getAsInt() - 32 && at.getZ() <= selection.get("maxZ").getAsInt() + 32 &&
                at.getY() >= selection.get("minY").getAsInt() - 48 &&
                at.getY() <= selection.get("maxY").getAsInt() + 48;
        }

        void refreshDisplay() {
            clearDisplay();
            if (historyPage || owner.getWorld() != world) return;
            if (comparison != null) {
                if (inReach(comparisonPlan()) && comparisonPlan().get("expiresAt").getAsLong() > System.currentTimeMillis()) {
                    preview = WandPreview.showComparison(owner, comparison);
                }
            } else if (isManagement()) {
                showProgress(progress());
            } else if (result != null && inReach(result.plan()) && result.plan().get("expiresAt").getAsLong() > System.currentTimeMillis()) {
                preview = WandPreview.show(owner, result, layers);
            }
        }

        void showProgress(Progress status) {
            if (status == null || owner.getWorld() != world || historyPage || comparison != null) {
                clearDisplay();
                return;
            }
            String currentDimension = dimension.getValue().toString();
            BlockPos blockage = status.blockageDimension().equals(currentDimension) ? status.blockage() : null;
            JsonArray remaining = status.dimension().equals(currentDimension) ? status.remaining() : new JsonArray();
            var markers = new ProgressMarkers(blockage, status.death(), remaining);
            if (markers.equals(progressMarkers)) return;
            clearDisplay();
            progressMarkers = markers;
            if (markers.blockage() != null || !markers.remaining().isEmpty()) {
                preview = WandPreview.showProgress(owner, markers.blockage(), markers.death(), markers.remaining());
            }
        }

        void close() {
            if (menu != null) {
                menu.close();
                menu = null;
            }
            clearDisplay();
        }
    }
}
