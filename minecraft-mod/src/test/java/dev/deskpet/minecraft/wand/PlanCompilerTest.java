package dev.deskpet.minecraft.wand;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.Bootstrap;
import net.minecraft.SharedConstants;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.command.argument.BlockArgumentParser;
import net.minecraft.registry.Registries;
import net.minecraft.state.property.Properties;
import net.minecraft.util.BlockRotation;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PlanCompilerTest {
    private static final PlanCompiler.Area FIELD = new PlanCompiler.Area(0, 12, 0, 12);
    private static final BlockPos PIT = new BlockPos(6, 63, 6);

    @BeforeAll
    static void bootstrap() {
        SharedConstants.createGameVersion();
        Bootstrap.initialize();
    }

    @Test
    void sixteenTemplateRotationsMatchGoldenPlans() throws Exception {
        var golden = new JsonObject();
        for (HouseTemplates.Type type : HouseTemplates.Type.values()) {
            for (BlockRotation rotation : BlockRotation.values()) {
                var result = compile(new Ground(), FIELD, type, rotation, PlanCompiler.Mode.FOUNDATION, false);
                assertTrue(result.valid(), () -> result.conflicts().toString());
                assertEquals(64, result.groundY());
                assertTrue(result.ops().stream().allMatch(op -> FIELD.contains(op.pos())));
                verifyExpectations(result);
                if (type == HouseTemplates.Type.WHEAT_FIELD) {
                    assertEquals(1, result.ops().stream().filter(op -> op.target().isOf(Blocks.WATER)).count());
                    assertEquals(80, result.ops().stream().filter(op -> op.target().isOf(Blocks.WHEAT)).count());
                    assertTrue(result.ops().subList(0, 80).stream()
                        .allMatch(op -> op.phase().equals("foundation") && op.target().isOf(Blocks.DIRT)));
                    assertTrue(result.ops().get(80).target().isOf(Blocks.WATER));
                    assertTrue(result.ops().stream().filter(op -> op.phase().equals("till"))
                        .allMatch(op -> op.expect().isOf(Blocks.DIRT) && op.target().isOf(Blocks.FARMLAND)));
                    assertEquals(2, result.plan().getAsJsonObject("materials").getAsJsonObject("required")
                        .get("minecraft:wooden_hoe").getAsInt());
                } else {
                    assertEquals(rotation.rotate(Direction.NORTH), result.doorFacing());
                    assertEquals(2, result.ops().stream().filter(op -> op.target().isOf(Blocks.OAK_DOOR) &&
                        op.target().get(Properties.HORIZONTAL_FACING) == result.doorFacing()).count());
                }
                var row = new JsonObject();
                row.addProperty("planHash", result.plan().get("planHash").getAsString());
                row.addProperty("snapshotHash", result.plan().get("snapshotHash").getAsString());
                row.addProperty("operations", result.ops().size());
                row.add("template", result.plan().get("template"));
                golden.add(type.id + "/" + rotation.ordinal() * 90, row);
            }
        }
        String writeGolden = System.getenv("DESKPET_UPDATE_GOLDENS");
        if (writeGolden != null) {
            Files.writeString(Path.of(writeGolden), new GsonBuilder().setPrettyPrinting().serializeNulls().create().toJson(golden) + "\n");
        }
        try (var stream = PlanCompilerTest.class.getResourceAsStream("/golden/compiled-plans.json")) {
            assertTrue(stream != null, "Missing checked-in plan fixture");
            var expected = JsonParser.parseReader(new InputStreamReader(stream, StandardCharsets.UTF_8));
            assertEquals(expected, golden);
        }
    }

    @Test
    void onlyNaturalGrassGrowthOnPlacedSoilBelowGradeIsAnAcceptedFinalTarget() {
        var plan = new JsonObject();
        plan.addProperty("groundY", 64);
        var fill = new BlockPos(3, 63, 3);
        var grass = Blocks.GRASS_BLOCK.getDefaultState();
        assertTrue(PlanCompiler.matchesFinalTarget(plan, fill, "minecraft:dirt", grass, true));
        assertFalse(PlanCompiler.matchesFinalTarget(plan, fill, "minecraft:dirt", grass, false));
        assertFalse(PlanCompiler.matchesFinalTarget(plan, fill.up(), "minecraft:dirt", grass, true));
        assertFalse(PlanCompiler.matchesFinalTarget(plan, fill, "minecraft:oak_planks", grass, true));
        assertFalse(PlanCompiler.matchesFinalTarget(plan, fill, "minecraft:dirt", Blocks.AIR.getDefaultState(), true));
    }

    @Test
    void excavatedStoneCanSupplyAnAuthorizedFill() {
        BlockPos cut = new BlockPos(6, 64, 4);
        BlockPos pit = new BlockPos(6, 63, 6);
        var result = compile(new Ground().put(cut, Blocks.STONE.getDefaultState()).put(pit, Blocks.AIR.getDefaultState()));
        assertTrue(result.valid(), () -> result.conflicts().toString());
        assertTrue(result.ops().stream().anyMatch(op -> op.pos().equals(pit) && op.kind().equals("fill")
            && op.target().isOf(Blocks.COBBLESTONE)));
        assertEquals(1, result.plan().getAsJsonObject("materials").getAsJsonObject("excavated")
            .get("minecraft:cobblestone").getAsInt());
    }

    @Test
    void farmlandHydrationAndWheatGrowthDoNotUndoAppliedOperationsUnderNormalRules() {
        var plan = new JsonObject();
        var hydrated = Blocks.FARMLAND.getDefaultState().with(Properties.MOISTURE, 7);
        var grown = Blocks.WHEAT.getDefaultState().with(Properties.AGE_7, 3);
        assertTrue(PlanCompiler.matchesFinalTarget(plan, PIT, "minecraft:farmland[moisture=0]", hydrated, true));
        assertTrue(PlanCompiler.matchesFinalTarget(plan, PIT.up(), "minecraft:wheat[age=0]", grown, true));
        assertFalse(PlanCompiler.matchesFinalTarget(plan, PIT, "minecraft:farmland[moisture=0]", hydrated, false));
        assertFalse(PlanCompiler.matchesFinalTarget(plan, PIT.up(), "minecraft:wheat[age=0]", grown, false));
        assertFalse(PlanCompiler.matchesFinalTarget(plan, PIT, "minecraft:farmland[moisture=0]",
            Blocks.DIRT.getDefaultState(), true));
    }

    @Test
    void multiStoreyScaffoldAndFloorOrderFitTheMinimumSelectionInEveryRotation() {
        var area = new PlanCompiler.Area(0, 10, 0, 10);
        for (BlockRotation rotation : BlockRotation.values()) {
            var result = compile(new Ground(), area, HouseTemplates.Type.TWO_STOREY_HOUSE, rotation,
                PlanCompiler.Mode.FOUNDATION, false);
            assertTrue(result.valid(), () -> result.conflicts().toString());
            Map<String, List<PlanCompiler.Operation>> phases = new LinkedHashMap<>();
            result.ops().forEach(op -> phases.computeIfAbsent(op.phase(), phase -> new ArrayList<>()).add(op));
            assertEquals(List.of("scaffold", "stair_base", "walls", "floor", "upper_walls", "roof", "furnish", "remove_scaffold"),
                List.copyOf(phases.keySet()));
            assertEquals(21, phases.get("scaffold").size());
            assertEquals(21, phases.get("remove_scaffold").size());
            assertTrue(phases.get("stair_base").getFirst().target().isOf(Blocks.OAK_STAIRS));
            assertEquals(3, phases.get("floor").stream().filter(op -> op.target().isOf(Blocks.OAK_STAIRS)).count());
            assertTrue(result.ops().stream().allMatch(op -> area.contains(op.pos())));
        }
    }

    @Test
    void protectedPlacementConflictsAndIsNeverScheduled() {
        BlockPos chest = new BlockPos(6, 64, 6);
        var world = new Ground().put(chest, Blocks.CHEST.getDefaultState())
            .put(chest.east(), Blocks.OAK_LEAVES.getDefaultState().with(Properties.PERSISTENT, true))
            .put(chest.west(), Blocks.OAK_LOG.getDefaultState());
        var result = compile(world);
        assertConflict(result, PlanCompiler.ConflictKind.PROTECTED);
        assertTrue(result.protectedCells().contains(chest));
        assertTrue(result.protectedCells().contains(chest.east()));
        assertTrue(result.protectedCells().contains(chest.west()));
        assertTrue(result.ops().stream().noneMatch(op -> result.protectedCells().contains(op.pos())));
    }

    @Test
    void crossBoundaryTreeIsConservativeAndCanBeClipped() {
        var world = new Ground();
        BlockPos base = new BlockPos(0, 64, 4);
        world.put(base, Blocks.OAK_LOG.getDefaultState()).put(base.up(), Blocks.OAK_LOG.getDefaultState())
            .put(base.up(2), Blocks.OAK_LEAVES.getDefaultState().with(Properties.PERSISTENT, false))
            .put(base.up(2).west(), Blocks.OAK_LEAVES.getDefaultState().with(Properties.PERSISTENT, false));
        assertConflict(compile(world), PlanCompiler.ConflictKind.CROSS_BOUNDARY_TREE);
        var clipped = compile(world, FIELD, HouseTemplates.Type.STARTER_HOUSE, BlockRotation.NONE,
            PlanCompiler.Mode.SELECTION, true);
        assertTrue(clipped.valid(), () -> clipped.conflicts().toString());
        assertTrue(clipped.ops().stream().anyMatch(op -> op.pos().equals(base) && op.target().isAir()));
        assertTrue(clipped.ops().stream().noneMatch(op -> !FIELD.contains(op.pos())));
    }

    @Test
    void waterAndLavaAdjacentToAnExcavationConflict() {
        BlockPos edge = new BlockPos(0, 64, 4);
        for (BlockState fluid : new BlockState[] {Blocks.WATER.getDefaultState(), Blocks.LAVA.getDefaultState()}) {
            var world = new Ground().put(edge, Blocks.DIRT.getDefaultState()).put(edge.west(), fluid);
            assertConflict(compile(world), PlanCompiler.ConflictKind.ADJACENT_FLUID);
        }
    }

    @Test
    void sandAndGravelDoNotExpandTheVerticalAuthorization() {
        BlockPos base = new BlockPos(0, 64, 4);
        for (BlockState gravity : new BlockState[] {Blocks.SAND.getDefaultState(), Blocks.GRAVEL.getDefaultState()}) {
            var world = new Ground().put(base, Blocks.STONE.getDefaultState());
            for (int y = 65; y <= 75; y++) {
                world.put(base.withY(y), gravity);
            }
            var result = compile(world);
            assertConflict(result, PlanCompiler.ConflictKind.FALLING_COLUMN);
            assertTrue(result.plan().getAsJsonObject("selection").get("maxY").getAsInt() < 75);
        }
    }

    @Test
    void wallAttachmentOnOutsideOfSelectionConflicts() {
        BlockPos support = new BlockPos(0, 64, 6);
        var world = new Ground().put(support, Blocks.STONE.getDefaultState())
            .put(support.west(), Blocks.WALL_TORCH.getDefaultState().with(Properties.HORIZONTAL_FACING, Direction.WEST));
        assertConflict(compile(world), PlanCompiler.ConflictKind.OUTSIDE_ATTACHMENT);
    }

    @Test
    void topAttachmentsBeyondCutBoundsAreRecognized() {
        BlockPos support = new BlockPos(0, 64, 6);
        for (BlockState attached : new BlockState[] {
            Blocks.OAK_SIGN.getDefaultState(), Blocks.TORCH.getDefaultState(), Blocks.RAIL.getDefaultState(),
            Blocks.OAK_DOOR.getDefaultState(), Blocks.WHITE_CARPET.getDefaultState(),
            Blocks.REDSTONE_WIRE.getDefaultState(), Blocks.FERN.getDefaultState()
        }) {
            assertTrue(TerrainRules.supportedBy(attached, support.up(), support), () -> attached.toString());
        }
        for (BlockState attached : new BlockState[] {
            Blocks.LADDER.getDefaultState().with(Properties.HORIZONTAL_FACING, Direction.WEST),
            Blocks.VINE.getDefaultState().with(Properties.EAST, true),
            Blocks.OAK_BUTTON.getDefaultState().with(Properties.BLOCK_FACE,
                net.minecraft.block.enums.BlockFace.WALL).with(Properties.HORIZONTAL_FACING, Direction.WEST),
            Blocks.LEVER.getDefaultState().with(Properties.BLOCK_FACE,
                net.minecraft.block.enums.BlockFace.WALL).with(Properties.HORIZONTAL_FACING, Direction.WEST)
        }) {
            assertTrue(TerrainRules.supportedBy(attached, support.west(), support), () -> attached.toString());
        }
    }

    @Test
    void tooSmallSelectionStopsBeforePublishingAnOperation() {
        var result = compile(new Ground(), new PlanCompiler.Area(0, 5, 0, 4), HouseTemplates.Type.STARTER_HOUSE,
            BlockRotation.NONE, PlanCompiler.Mode.FOUNDATION, false);
        assertConflict(result, PlanCompiler.ConflictKind.TEMPLATE_TOO_LARGE);
        assertTrue(result.ops().isEmpty());
    }

    @Test
    void recognizesDeepPitAndNeverPartiallyFillsIt() {
        var world = new Ground();
        for (int down = 0; down < 7; down++) {
            world.put(PIT.down(down), Blocks.AIR.getDefaultState());
        }
        var result = compile(world);
        assertConflict(result, PlanCompiler.ConflictKind.FILL_TOO_DEEP);
        assertTrue(result.ops().stream().noneMatch(op -> op.kind().equals("fill") && op.pos().getX() == PIT.getX() &&
            op.pos().getZ() == PIT.getZ()));
    }

    @Test
    void shallowFillIsBottomUpAndSupplyCountsCoverRequiredItems() {
        var world = new Ground().put(PIT, Blocks.AIR.getDefaultState()).put(PIT.down(), Blocks.AIR.getDefaultState());
        var result = compile(world);
        var fills = result.ops().stream().filter(op -> op.kind().equals("fill")).map(PlanCompiler.Operation::pos).toList();
        assertEquals(java.util.List.of(PIT.down(), PIT), fills);
        var materials = result.plan().getAsJsonObject("materials");
        assertEquals(46, materials.getAsJsonObject("required").get("minecraft:cobblestone").getAsInt());
        assertEquals(1, materials.getAsJsonObject("required").get("minecraft:oak_door").getAsInt());
        assertEquals(1, materials.getAsJsonObject("required").get("minecraft:red_bed").getAsInt());
        assertEquals(36, materials.getAsJsonObject("deficit").get("minecraft:cobblestone").getAsInt());
    }

    @Test
    void snapshotCoversPerimeterAndFullSelection() {
        var before = compile(new Ground()).plan().get("snapshotHash");
        var inside = compile(new Ground().put(new BlockPos(12, 64, 12), Blocks.OAK_PLANKS.getDefaultState()))
            .plan().get("snapshotHash");
        var outside = compile(new Ground().put(new BlockPos(-2, 64, 0), Blocks.OAK_PLANKS.getDefaultState()))
            .plan().get("snapshotHash");
        assertNotEquals(before, inside);
        assertNotEquals(before, outside);
    }

    @Test
    void recheckAcceptsNaturalChangesAndReadsOnlyTheNextOperationAtEachPosition() {
        BlockPos fill = new BlockPos(6, 62, 6);
        BlockPos cut = new BlockPos(6, 64, 7);
        BlockPos crop = new BlockPos(-2, 64, 0);
        var world = new Ground().put(fill.up(), Blocks.AIR.getDefaultState()).put(fill, Blocks.AIR.getDefaultState())
            .put(cut, Blocks.DIRT.getDefaultState()).put(crop, Blocks.WHEAT.getDefaultState());
        var plan = compile(world).plan();
        world.put(fill, Blocks.SHORT_GRASS.getDefaultState()).put(cut, Blocks.GRASS_BLOCK.getDefaultState())
            .put(crop, Blocks.WHEAT.getDefaultState().with(Properties.AGE_7, 7));
        assertNull(siteConflict(world, plan));
        world.put(fill, Blocks.SNOW.getDefaultState());
        assertNull(siteConflict(world, plan));
        world.put(fill, Blocks.WATER.getDefaultState());
        assertTrue(siteConflict(world, plan).contains("expected_block_changed"));
    }

    @Test
    void recheckFindsNewAttachmentFluidFallingColumnBoundaryTreeAndProtectedBlock() {
        BlockPos edge = new BlockPos(0, 64, 6);
        var before = new Ground().put(edge, Blocks.DIRT.getDefaultState());
        var plan = compile(before).plan();
        var addedTorch = new Ground().put(edge, Blocks.DIRT.getDefaultState()).put(edge.west(),
            Blocks.WALL_TORCH.getDefaultState().with(Properties.HORIZONTAL_FACING, Direction.WEST));
        assertTrue(siteConflict(addedTorch, plan).contains("outside_attachment"));
        var addedFluid = new Ground().put(edge, Blocks.DIRT.getDefaultState()).put(edge.west(), Blocks.LAVA.getDefaultState());
        assertTrue(siteConflict(addedFluid, plan).contains("adjacent_fluid"));
        var addedSand = new Ground().put(edge, Blocks.DIRT.getDefaultState()).put(edge.up(), Blocks.SAND.getDefaultState());
        assertTrue(siteConflict(addedSand, plan).contains("falling_column"));
        var crossedTree = new Ground().put(edge, Blocks.OAK_LOG.getDefaultState()).put(edge.west(),
            Blocks.OAK_LEAVES.getDefaultState().with(Properties.PERSISTENT, false));
        assertTrue(siteConflict(crossedTree, plan).contains("cross_boundary_tree"));
        var addedPlank = new Ground().put(edge, Blocks.OAK_PLANKS.getDefaultState());
        assertTrue(siteConflict(addedPlank, plan).contains("protected_block_changed"));
    }

    @Test
    void opensAreIgnoredForCompletedAndProtectedStatesButOrientationStillMatters() {
        var plan = compile(new Ground()).plan();
        BlockPos door = new BlockPos(5, 64, 6);
        BlockPos barrel = door.east();
        BlockState originalDoor = Blocks.OAK_DOOR.getDefaultState();
        BlockState openDoor = originalDoor.with(Properties.OPEN, true);
        BlockState closedBarrel = Blocks.BARREL.getDefaultState();
        BlockState openBarrel = closedBarrel.with(Properties.OPEN, true);
        var world = new Ground().put(door, openDoor).put(barrel, openBarrel);
        var finalTargets = Map.of(door, PlanCompiler.stateName(originalDoor));
        var protectedBaseline = Map.of(barrel, PlanCompiler.stateName(closedBarrel));
        assertTrue(PlanCompiler.isOpenToggle(originalDoor, openDoor));
        assertNull(PlanCompiler.firstSiteConflict(world, plan, new JsonArray(), finalTargets, protectedBaseline));
        BlockState wrongDoor = openDoor.cycle(Properties.HORIZONTAL_FACING);
        assertFalse(PlanCompiler.isOpenToggle(originalDoor, wrongDoor));
        world.put(door, wrongDoor);
        assertTrue(PlanCompiler.firstSiteConflict(world, plan, new JsonArray(), finalTargets, protectedBaseline)
            .contains("expected_block_changed"));
    }

    @Test
    void sharedExpectationCasesAgreeWithServerRules() throws Exception {
        try (var stream = PlanCompilerTest.class.getResourceAsStream("/survey-expect-cases.json")) {
            assertTrue(stream != null, "Missing shared Core/Mod expectation fixture");
            var cases = JsonParser.parseReader(new InputStreamReader(stream, StandardCharsets.UTF_8)).getAsJsonArray();
            for (var entry : cases) {
                var row = entry.getAsJsonObject();
                String kind = row.get("kind").getAsString();
                String expect = row.get("expect").getAsString();
                String target = row.has("target") ? row.get("target").getAsString() : null;
                String state = row.get("actual").getAsString();
                var actual = BlockArgumentParser.block(Registries.BLOCK, state, false).blockState();
                assertEquals(state, PlanCompiler.stateName(actual), row::toString);
                assertEquals(row.get("matches").getAsBoolean(),
                    PlanCompiler.matchesExpect(kind, expect, target, actual, () -> row.get("naturalLog").getAsBoolean()),
                    row::toString);
            }
        }
    }

    private static String siteConflict(Ground ground, JsonObject plan) {
        return PlanCompiler.firstSiteConflict(ground, plan, plan.getAsJsonArray("ops"), Map.of(), Map.of());
    }

    @Test
    void recompareAddsClearanceToOnePendingBuildAndFreezesOriginalParameters() {
        var world = new Ground();
        var original = PlanCompiler.compile(world, new PlanCompiler.Request(
            new UUID(0, 1), 4, new UUID(0, 2), "minecraft:overworld", new UUID(0, 3), new UUID(0, 4),
            FIELD, new PlanCompiler.Settings(HouseTemplates.Type.STARTER_HOUSE, BlockRotation.CLOCKWISE_90,
                1, -1, 0, PlanCompiler.Mode.FOUNDATION, 4, true), new BlockPos(-2, 64, 0), 1000));
        var targets = apply(original, world);
        var obs = original.ops().stream().filter(op -> op.target().isOf(Blocks.COBBLESTONE)).findFirst().orElseThrow();
        world.put(obs.pos(), Blocks.DIRT.getDefaultState());
        var remaining = new JsonArray();
        for (var entry : original.plan().getAsJsonArray("ops")) {
            var op = entry.getAsJsonObject();
            if (opPos(op).equals(obs.pos())) remaining.add(op);
        }
        var revised = PlanCompiler.recompare(world, original.plan(), remaining, targets, Map.of(), 2000);
        var document = revised.document();
        assertEquals(5, document.get("revision").getAsInt());
        assertEquals(2000 + PlanCompiler.PREVIEW_MILLIS, document.get("expiresAt").getAsLong());
        for (String field : java.util.List.of("planId", "worldId", "ownerUuid", "botUuid", "dimension", "selection",
            "groundY", "mode", "template", "fillDepthLimit", "clipTrees", "supplyChest")) {
            assertEquals(original.plan().get(field), document.get(field), field);
        }
        var ops = document.getAsJsonArray("ops");
        assertEquals(0, document.getAsJsonArray("conflicts").size());
        assertEquals(2, ops.size());
        assertEquals(obs.pos(), opPos(ops.get(0).getAsJsonObject()));
        assertEquals(obs.pos(), opPos(ops.get(1).getAsJsonObject()));
        assertEquals("cut", ops.get(0).getAsJsonObject().get("kind").getAsString());
        assertEquals("build", ops.get(1).getAsJsonObject().get("kind").getAsString());
        assertNull(PlanCompiler.firstSiteConflict(world, document, ops, revised.targets(), revised.protectedBaseline()));
        var unhashed = document.deepCopy();
        String hash = unhashed.remove("planHash").getAsString();
        assertEquals(hash, PlanCompiler.sha256(unhashed));
    }

    @Test
    void recompareRecoversFinalDriftWithNoRemainingOperationsAndRefreshesMaterials() {
        var world = new Ground();
        var original = compile(world);
        var targets = apply(original, world);
        var missing = original.ops().stream().filter(op -> op.target().isOf(Blocks.COBBLESTONE))
            .limit(3).map(PlanCompiler.Operation::pos).toList();
        missing.forEach(pos -> world.put(pos, Blocks.AIR.getDefaultState()));
        world.cobblestoneStock = 1;
        var revised = PlanCompiler.recompare(world, original.plan(), new JsonArray(), targets, Map.of(), 2000);
        var doc = revised.document();
        var ops = doc.getAsJsonArray("ops");
        assertEquals(0, doc.getAsJsonArray("conflicts").size());
        assertEquals(Set.copyOf(missing), ops.asList().stream().map(op -> opPos(op.getAsJsonObject()))
            .collect(java.util.stream.Collectors.toSet()));
        assertEquals(3, ops.size());
        var materials = doc.getAsJsonObject("materials");
        assertEquals(3, materials.getAsJsonObject("required").get("minecraft:cobblestone").getAsInt());
        assertEquals(1, materials.getAsJsonObject("available").get("minecraft:cobblestone").getAsInt());
        assertEquals(2, materials.getAsJsonObject("deficit").get("minecraft:cobblestone").getAsInt());
        assertNull(PlanCompiler.firstSiteConflict(world, doc, ops, revised.targets(), revised.protectedBaseline()));
    }

    @Test
    void recompareFlagsProtectedBuildAndOutOfRangeRemovalAttachment() {
        var world = new Ground();
        var original = compile(world);
        var target = original.ops().stream().filter(op -> op.target().isOf(Blocks.COBBLESTONE)).findFirst().orElseThrow().pos();
        world.put(target, Blocks.CHEST.getDefaultState());
        BlockPos edge = new BlockPos(FIELD.minX(), 64, 6);
        world.put(edge, Blocks.DIRT.getDefaultState()).put(edge.west(),
            Blocks.WALL_TORCH.getDefaultState().with(Properties.HORIZONTAL_FACING, Direction.WEST));
        var revised = PlanCompiler.recompare(world, original.plan(), original.plan().getAsJsonArray("ops"), targetStates(original),
            Map.of(), 2000);
        var doc = revised.document();
        assertEquals(original.plan().get("selection"), doc.get("selection"));
        var conflicts = doc.getAsJsonArray("conflicts").asList().stream().map(element -> element.getAsJsonObject()).toList();
        assertTrue(conflicts.stream().anyMatch(conflict ->
            conflict.get("kind").getAsString().equals("protected") && opPos(conflict).equals(target)));
        assertTrue(conflicts.stream().anyMatch(conflict ->
            conflict.get("kind").getAsString().equals("outside_attachment") && opPos(conflict).equals(edge.west())));
        for (var entry : doc.getAsJsonArray("ops")) {
            var pos = opPos(entry.getAsJsonObject());
            assertTrue(FIELD.contains(pos));
            assertNotEquals(target, pos);
        }
    }

    @Test
    void recompareRefusesToReplaceAnAlreadyCorrectHalfOfADoor() {
        var world = new Ground();
        var original = compile(world);
        var targets = apply(original, world);
        BlockPos upper = original.door().up();
        world.put(upper, Blocks.AIR.getDefaultState());
        var revised = PlanCompiler.recompare(world, original.plan(), new JsonArray(), targets, Map.of(), 2000);
        assertTrue(revised.document().getAsJsonArray("conflicts").asList().stream()
            .anyMatch(element -> element.getAsJsonObject().get("kind").getAsString().equals("incomplete_multiblock")));
        assertTrue(revised.document().getAsJsonArray("ops").asList().stream()
            .noneMatch(element -> opPos(element.getAsJsonObject()).equals(original.door())));
    }

    @Test
    void recompareRejectsANewTreeAboveTheFrozenVerticalBounds() {
        var world = new Ground();
        var original = compile(world);
        int maxY = original.plan().getAsJsonObject("selection").get("maxY").getAsInt();
        var upper = new BlockPos(1, maxY, 1);
        world.put(upper, Blocks.OAK_LOG.getDefaultState())
            .put(upper.up(), Blocks.OAK_LOG.getDefaultState())
            .put(upper.up(2), Blocks.OAK_LEAVES.getDefaultState().with(Properties.PERSISTENT, false));
        var revised = PlanCompiler.recompare(world, original.plan(), original.plan().getAsJsonArray("ops"),
            targetStates(original), Map.of(), 2000);
        var document = revised.document();
        assertEquals(original.plan().get("selection"), document.get("selection"));
        assertTrue(document.getAsJsonArray("conflicts").asList().stream()
            .anyMatch(element -> element.getAsJsonObject().get("kind").getAsString().equals("cross_boundary_tree")));
        assertTrue(document.getAsJsonArray("ops").asList().stream()
            .noneMatch(element -> opPos(element.getAsJsonObject()).getY() > maxY));
    }

    @Test
    void recompareReusesOnlyOriginalTemporaryAccessForCompletedRoofRepair() {
        var world = new Ground();
        var original = compile(world);
        var targets = apply(original, world);
        var roof = original.ops().stream().filter(op -> op.phase().equals("roof")).findFirst().orElseThrow().pos();
        world.put(roof, Blocks.AIR.getDefaultState());
        var revised = PlanCompiler.recompare(world, original.plan(), new JsonArray(), targets, Map.of(), 2000);
        var document = revised.document();
        assertEquals(0, document.getAsJsonArray("conflicts").size());
        var ops = document.getAsJsonArray("ops").asList().stream().map(element -> element.getAsJsonObject()).toList();
        assertEquals(List.of(roof), ops.stream().filter(op -> !op.get("kind").getAsString().equals("scaffold"))
            .map(PlanCompilerTest::opPos).toList());
        assertEquals(original.ops().stream().filter(op -> op.kind().equals("scaffold")).map(PlanCompiler.Operation::pos).toList(),
            ops.stream().filter(op -> op.get("kind").getAsString().equals("scaffold")).map(PlanCompilerTest::opPos).toList());
        assertNull(PlanCompiler.firstSiteConflict(world, document, document.getAsJsonArray("ops"),
            revised.targets(), revised.protectedBaseline()));
    }

    private static BlockPos opPos(JsonObject operation) {
        var pos = operation.getAsJsonObject("pos");
        return new BlockPos(pos.get("x").getAsInt(), pos.get("y").getAsInt(), pos.get("z").getAsInt());
    }

    private static Map<BlockPos, String> apply(PlanCompiler.Result plan, Ground world) {
        plan.ops().forEach(op -> world.put(op.pos(), op.target()));
        return targetStates(plan);
    }

    private static Map<BlockPos, String> targetStates(PlanCompiler.Result plan) {
        var targets = new HashMap<BlockPos, String>();
        plan.ops().forEach(op -> targets.put(op.pos(), PlanCompiler.stateName(op.target())));
        return targets;
    }

    private static void verifyExpectations(PlanCompiler.Result result) {
        var cells = new HashMap<BlockPos, BlockState>();
        for (var op : result.ops()) {
            assertEquals(cells.getOrDefault(op.pos(), Blocks.AIR.getDefaultState()), op.expect());
            cells.put(op.pos(), op.target());
        }
    }

    private static void assertConflict(PlanCompiler.Result result, PlanCompiler.ConflictKind kind) {
        assertFalse(result.valid());
        assertTrue(result.conflicts().stream().anyMatch(conflict -> conflict.kind() == kind),
            () -> "Missing " + kind + " in " + result.conflicts());
    }

    private static PlanCompiler.Result compile(Ground ground) {
        return compile(ground, FIELD, HouseTemplates.Type.STARTER_HOUSE, BlockRotation.NONE,
            PlanCompiler.Mode.SELECTION, false);
    }

    private static PlanCompiler.Result compile(Ground ground, PlanCompiler.Area area, HouseTemplates.Type house,
                                               BlockRotation rotation, PlanCompiler.Mode mode, boolean clipTrees) {
        return PlanCompiler.compile(ground, new PlanCompiler.Request(
            new UUID(0, 1), 1, new UUID(0, 2), "minecraft:overworld", new UUID(0, 3), new UUID(0, 4),
            area, new PlanCompiler.Settings(house, rotation, 0, 0, 0, mode, 6, clipTrees),
            new BlockPos(-2, 64, 0), 1_700_000_000_000L));
    }

    private static final class Ground implements PlanCompiler.WorldView {
        private final Map<BlockPos, BlockState> terrain = new HashMap<>();
        private int cobblestoneStock = 10;

        Ground put(BlockPos pos, BlockState state) {
            terrain.put(pos, state);
            return this;
        }

        @Override
        public BlockState state(BlockPos pos) {
            return terrain.getOrDefault(pos, pos.getY() <= 63 ? Blocks.DIRT.getDefaultState() : Blocks.AIR.getDefaultState());
        }

        @Override
        public int top(int x, int z) {
            for (int y = 80; y >= minY(); y--) {
                if (!state(new BlockPos(x, y, z)).isAir()) {
                    return y;
                }
            }
            return minY();
        }

        @Override
        public int minY() {
            return -64;
        }

        @Override
        public int maxY() {
            return 319;
        }

        @Override
        public Map<String, Integer> materials(BlockPos pos) {
            return Map.of("minecraft:cobblestone", cobblestoneStock);
        }
    }
}
