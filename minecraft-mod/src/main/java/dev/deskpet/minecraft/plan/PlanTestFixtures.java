package dev.deskpet.minecraft.plan;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.mojang.brigadier.exceptions.SimpleCommandExceptionType;
import dev.deskpet.minecraft.WorldIdentity;
import dev.deskpet.minecraft.wand.PlanCompiler;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.enums.DoubleBlockHalf;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.state.property.Properties;
import net.minecraft.text.Text;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;

import java.util.List;
import java.util.UUID;

/** Small fixed plans for the dedicated server acceptance harness. */
final class PlanTestFixtures {
    private static final SimpleCommandExceptionType UNKNOWN_FIXTURE =
        new SimpleCommandExceptionType(Text.literal("Unknown survey plan fixture"));
    private static final SimpleCommandExceptionType NO_BOT =
        new SimpleCommandExceptionType(Text.literal("No configured fixture bot"));

    private record Step(BlockPos pos, BlockState expect, BlockState target, String kind, String phase) {}

    private PlanTestFixtures() {}

    static UUID preview(ServerPlayerEntity player, String profile, BlockPos origin) throws CommandSyntaxException {
        BlockState air = Blocks.AIR.getDefaultState();
        BlockState dirt = Blocks.DIRT.getDefaultState();
        var door = Blocks.OAK_DOOR.getDefaultState().with(Properties.HORIZONTAL_FACING, Direction.NORTH);
        List<Step> steps = switch (profile) {
            case "small" -> List.of(
                new Step(origin, dirt, air, "cut", "terrain"),
                new Step(origin.east(), dirt, air, "cut", "terrain"),
                new Step(origin.east(2), air, dirt, "fill", "terrain"));
            case "interactions" -> List.of(
                new Step(origin.down(), dirt, Blocks.FARMLAND.getDefaultState(), "build", "structure"),
                new Step(origin.east(3), air, door, "build", "structure"),
                new Step(origin.east(3).up(), air, door.with(Properties.DOUBLE_BLOCK_HALF, DoubleBlockHalf.UPPER),
                    "build", "structure"),
                new Step(origin.east(8), air, Blocks.WATER.getDefaultState(), "furnish", "furnish"));
            default -> throw UNKNOWN_FIXTURE.create();
        };
        var bot = PlanService.botUuid(player);
        if (bot == null) throw NO_BOT.create();
        var world = player.getWorld();
        var id = UUID.randomUUID();
        var plan = new JsonObject();
        plan.addProperty("planId", id.toString());
        plan.addProperty("revision", 1);
        plan.addProperty("worldId", WorldIdentity.get(world).toString());
        plan.addProperty("dimension", world.getRegistryKey().getValue().toString());
        plan.addProperty("ownerUuid", player.getUuidAsString());
        plan.addProperty("botUuid", bot.toString());
        var selection = new JsonObject();
        selection.addProperty("minX", origin.getX());
        selection.addProperty("maxX", origin.getX() + (profile.equals("small") ? 2 : 9));
        selection.addProperty("minY", origin.getY() - 1);
        selection.addProperty("maxY", origin.getY() + 2);
        selection.addProperty("minZ", origin.getZ() - 1);
        selection.addProperty("maxZ", origin.getZ() + 1);
        plan.add("selection", selection);
        var template = new JsonObject();
        template.addProperty("id", profile.equals("small") ? "starter_house" : "wheat_field");
        template.addProperty("version", 1);
        template.addProperty("rotation", 0);
        template.add("anchor", position(origin));
        plan.add("template", template);
        plan.addProperty("groundY", origin.getY());
        plan.addProperty("mode", "selection");
        plan.addProperty("fillDepthLimit", 1);
        plan.addProperty("clipTrees", false);
        var operations = new JsonArray();
        for (int index = 0; index < steps.size(); index++) {
            var step = steps.get(index);
            var operation = new JsonObject();
            operation.add("pos", position(step.pos()));
            operation.addProperty("expect", PlanCompiler.stateName(step.expect()));
            operation.addProperty("target", PlanCompiler.stateName(step.target()));
            operation.addProperty("kind", step.kind());
            operation.addProperty("phase", step.phase());
            operation.addProperty("order", index);
            operations.add(operation);
        }
        plan.add("ops", operations);
        plan.add("protected", new JsonArray());
        plan.add("conflicts", new JsonArray());
        plan.addProperty("expiresAt", System.currentTimeMillis() + 600_000);
        plan.addProperty("planHash", PlanCompiler.sha256(plan));
        PlanService.preview(player, plan);
        return id;
    }

    private static JsonObject position(BlockPos pos) {
        var value = new JsonObject();
        value.addProperty("x", pos.getX());
        value.addProperty("y", pos.getY());
        value.addProperty("z", pos.getZ());
        return value;
    }
}
