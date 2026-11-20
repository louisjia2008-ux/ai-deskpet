package dev.deskpet.minecraft.wand;

import com.google.gson.JsonObject;
import dev.deskpet.minecraft.WorldIdentity;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.block.ChestBlock;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.item.ItemUsageContext;
import net.minecraft.registry.Registries;
import net.minecraft.registry.RegistryKey;
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
import java.util.Map;
import java.util.UUID;

public final class WandInteractions {
    public interface Authorization {
        default boolean enabled() { return false; }
        default UUID botUuid(ServerPlayerEntity owner) { return null; }
        default UUID active(ServerPlayerEntity owner) { return null; }
        default void preview(ServerPlayerEntity owner, JsonObject plan) {}
        default String confirm(ServerPlayerEntity owner, UUID planId) { return "确认开工尚未启用"; }
        default String status(ServerPlayerEntity owner, UUID planId) { return ""; }
        default String pause(ServerPlayerEntity owner, UUID planId) { return ""; }
        default String resume(ServerPlayerEntity owner, UUID planId) { return ""; }
        default String cancel(ServerPlayerEntity owner, UUID planId) { return ""; }
    }

    private static final Identifier WAND_ID = Identifier.of("deskpet", "survey_wand");
    private static final Map<UUID, Selection> SELECTIONS = new HashMap<>();
    private static Authorization authorization = new Authorization() {};

    private WandInteractions() {}

    public static void authorization(Authorization implementation) {
        authorization = implementation;
    }

    static Authorization authorization() {
        return authorization;
    }

    public static void register() {
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
                if (selection.preview != null && (selection.result == null ||
                    selection.result.plan().get("expiresAt").getAsLong() <= now ||
                    !selection.inReach())) {
                    selection.clearDisplay();
                }
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
        } else if (selection.second != null && selection.managing == null) {
            if (selection.result == null) {
                selection.compile();
            }
            selection.open();
        } else {
            UUID active = selection.managing != null ? selection.managing : authorization.active(player);
            if (active != null) {
                selection.managing = active;
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

    static final class Selection {
        final ServerPlayerEntity owner;
        final ServerWorld world;
        final RegistryKey<World> dimension;
        final EnumSet<WandPreview.Layer> layers = EnumSet.allOf(WandPreview.Layer.class);
        BlockPos first;
        BlockPos second;
        BlockPos supplyChest;
        UUID managing;
        PlanCompiler.Result result;
        PlanCompiler.Settings settings = PlanCompiler.Settings.defaults();
        WandMenu menu;
        WandPreview preview;

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
                return;
            }
            menu = new WandMenu(this);
            if (menu.open() && managing == null) {
                refreshDisplay();
            }
        }

        void clearDisplay() {
            if (preview != null) {
                preview.destroy();
                preview = null;
            }
        }

        boolean inReach() {
            if (owner.getWorld() != world || result == null || second == null) {
                return false;
            }
            var area = PlanCompiler.Area.between(first, second).expanded(32);
            var selection = result.plan().getAsJsonObject("selection");
            BlockPos at = owner.getBlockPos();
            return area.contains(at) && at.getY() >= selection.get("minY").getAsInt() - 48 &&
                at.getY() <= selection.get("maxY").getAsInt() + 48;
        }

        void refreshDisplay() {
            clearDisplay();
            if (inReach() && result.plan().get("expiresAt").getAsLong() > System.currentTimeMillis()) {
                preview = WandPreview.show(owner, result, layers);
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
