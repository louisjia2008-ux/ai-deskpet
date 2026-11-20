package dev.deskpet.minecraft.wand;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import net.minecraft.block.BarrelBlock;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.ChestBlock;
import net.minecraft.block.DoorBlock;
import net.minecraft.block.FenceGateBlock;
import net.minecraft.block.TrapdoorBlock;
import net.minecraft.block.entity.ChestBlockEntity;
import net.minecraft.block.enums.ChestType;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.state.property.Properties;
import net.minecraft.state.property.Property;
import net.minecraft.util.BlockRotation;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.world.GameRules;
import net.minecraft.world.Heightmap;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.Predicate;

public final class PlanCompiler {
    static final int MAX_WIDTH = 48;
    static final int DEFAULT_FILL_DEPTH = 6;
    static final int MAX_FILL_DEPTH = 16;
    static final long PREVIEW_MILLIS = 600_000;
    private static final int INSPECTION_BAND = 8;
    private static final Gson JSON = new GsonBuilder().disableHtmlEscaping().serializeNulls().create();
    private static final BlockState AIR = Blocks.AIR.getDefaultState();
    private static final BlockState DIRT = Blocks.DIRT.getDefaultState();
    private static final List<Block> FILL_BLOCKS = List.of(Blocks.DIRT, Blocks.COBBLESTONE,
        Blocks.COBBLED_DEEPSLATE, Blocks.ANDESITE, Blocks.DIORITE, Blocks.GRANITE, Blocks.TUFF, Blocks.CALCITE);

    enum Mode {
        FOUNDATION("建筑地基与走道"), SELECTION("整个选区");

        final String label;

        Mode(String label) {
            this.label = label;
        }
    }

    interface WorldView {
        BlockState state(BlockPos pos);
        int top(int x, int z);
        int minY();
        int maxY();
        Map<String, Integer> materials(BlockPos pos);
        default boolean randomTicksEnabled() { return false; }
    }

    record Area(int minX, int maxX, int minZ, int maxZ) {
        static Area between(BlockPos a, BlockPos b) {
            return new Area(Math.min(a.getX(), b.getX()), Math.max(a.getX(), b.getX()),
                Math.min(a.getZ(), b.getZ()), Math.max(a.getZ(), b.getZ()));
        }

        int width() {
            return maxX - minX + 1;
        }

        int length() {
            return maxZ - minZ + 1;
        }

        boolean contains(BlockPos pos) {
            return pos.getX() >= minX && pos.getX() <= maxX && pos.getZ() >= minZ && pos.getZ() <= maxZ;
        }

        Area expanded(int padding) {
            return new Area(minX - padding, maxX + padding, minZ - padding, maxZ + padding);
        }

        JsonObject selection(int minY, int maxY) {
            JsonObject json = new JsonObject();
            json.addProperty("minX", minX);
            json.addProperty("maxX", maxX);
            json.addProperty("minY", minY);
            json.addProperty("maxY", maxY);
            json.addProperty("minZ", minZ);
            json.addProperty("maxZ", maxZ);
            return json;
        }
    }

    record Settings(HouseTemplates.Type house, BlockRotation rotation, int shiftX, int shiftZ,
                    int groundOffset, Mode mode, int fillDepth, boolean clipTrees) {
        static Settings defaults() {
            return new Settings(HouseTemplates.Type.STARTER_HOUSE, BlockRotation.NONE, 0, 0, 0,
                Mode.FOUNDATION, DEFAULT_FILL_DEPTH, false);
        }
    }

    record Request(UUID planId, int revision, UUID worldId, String dimension, UUID ownerUuid,
                   UUID botUuid, Area area, Settings settings, BlockPos supplyChest, long now) {}

    enum ConflictKind {
        TEMPLATE_TOO_LARGE("选区放不下这个房型"),
        VERTICAL_LIMIT("超出世界高度范围"),
        PROTECTED("受保护方块挡住施工"),
        CROSS_BOUNDARY_TREE("树超出选区"),
        ADJACENT_FLUID("挖方贴着水或岩浆"),
        FALLING_COLUMN("沙或沙砾柱超出范围"),
        OUTSIDE_ATTACHMENT("框外有附着的方块"),
        FILL_TOO_DEEP("超过填坑深度上限"),
        UNSUPPORTED_FOUNDATION("地基含不可填入的方块");

        final String label;

        ConflictKind(String label) {
            this.label = label;
        }
    }

    record Conflict(ConflictKind kind, BlockPos pos) {}
    record Operation(BlockPos pos, BlockState expect, BlockState target, String kind, String phase) {}

    record Result(JsonObject plan, List<Operation> ops, Set<BlockPos> protectedCells,
                  List<Conflict> conflicts, BlockPos door, Direction doorFacing, int groundY,
                  int width, int length, int shiftX, int shiftZ) {
        boolean valid() {
            return conflicts.isEmpty();
        }
    }

    private record Placement(HouseTemplates.Template template, BlockPos anchor, Area footprint,
                             Area affected, int shiftX, int shiftZ, int tileX, int tileZ) {}

    private record Tree(boolean natural, boolean crossBoundary) {}

    private record SelectionBounds(Area area, int minY, int maxY) {
        static SelectionBounds read(JsonObject document) {
            var selection = document.getAsJsonObject("selection");
            var area = new Area(selection.get("minX").getAsInt(), selection.get("maxX").getAsInt(),
                selection.get("minZ").getAsInt(), selection.get("maxZ").getAsInt());
            return new SelectionBounds(area, selection.get("minY").getAsInt(), selection.get("maxY").getAsInt());
        }

        boolean contains(BlockPos pos) {
            return area.contains(pos) && pos.getY() >= minY && pos.getY() <= maxY;
        }
    }

    private PlanCompiler() {}

    static WorldView view(ServerWorld world) {
        return new WorldView() {
            @Override
            public BlockState state(BlockPos pos) {
                return world.getBlockState(pos);
            }

            @Override
            public int top(int x, int z) {
                return world.getTopY(Heightmap.Type.WORLD_SURFACE, x, z) - 1;
            }

            @Override
            public int minY() {
                return world.getBottomY();
            }

            @Override
            public int maxY() {
                return world.getTopYInclusive();
            }

            @Override
            public boolean randomTicksEnabled() {
                return world.getGameRules().getInt(GameRules.RANDOM_TICK_SPEED) > 0;
            }

            @Override
            public Map<String, Integer> materials(BlockPos pos) {
                if (pos == null) {
                    return Map.of();
                }
                BlockState state = world.getBlockState(pos);
                if (!(state.getBlock() instanceof ChestBlock)) {
                    return Map.of();
                }
                Map<String, Integer> result = new TreeMap<>();
                countChest(world, pos, result);
                if (state.get(ChestBlock.CHEST_TYPE) != ChestType.SINGLE) {
                    countChest(world, pos.offset(ChestBlock.getFacing(state)), result);
                }
                return result;
            }
        };
    }

    private static void countChest(ServerWorld world, BlockPos pos, Map<String, Integer> result) {
        if (world.getBlockEntity(pos) instanceof ChestBlockEntity chest && chest.getLootTable() == null) {
            for (int slot = 0; slot < chest.size(); slot++) {
                var stack = chest.getStack(slot);
                if (!stack.isEmpty()) {
                    result.merge(Registries.ITEM.getId(stack.getItem()).toString(), stack.getCount(), Integer::sum);
                }
            }
        }
    }

    static Result compile(WorldView world, Request request) {
        Area area = request.area();
        Settings settings = request.settings();
        if (area.width() < 1 || area.width() > MAX_WIDTH || area.length() < 1 || area.length() > MAX_WIDTH ||
            settings.fillDepth() < 1 || settings.fillDepth() > MAX_FILL_DEPTH) {
            throw new IllegalArgumentException("Invalid selection or fill depth");
        }
        int groundY = groundHeight(world, area) + settings.groundOffset();
        Placement placement = placement(area, settings, groundY);
        Area footprint = placement.footprint();
        Set<Conflict> conflicts = new LinkedHashSet<>();
        if (footprint.width() + 2 > area.width() || footprint.length() + 2 > area.length()) {
            conflicts.add(new Conflict(ConflictKind.TEMPLATE_TOO_LARGE, placement.anchor()));
        }

        int roof = groundY + placement.template().height() - 1;
        if (groundY <= world.minY() || roof > world.maxY()) {
            conflicts.add(new Conflict(ConflictKind.VERTICAL_LIMIT, placement.anchor()));
        }
        int minY = Math.clamp(groundY - settings.fillDepth() - 1, world.minY(), world.maxY());
        int maxY = Math.clamp(Math.max(roof, highest(world, area)), minY, world.maxY());
        BlockPos door = placement.template().door() == null ? null :
            placement.anchor().add(HouseTemplates.rotate(placement.template().door(), placement.template().width(),
                placement.template().length(), settings.rotation()));
        JsonObject selection = area.selection(minY, maxY);
        List<Operation> ops = new ArrayList<>();
        Set<BlockPos> protectedCells = new LinkedHashSet<>();
        Map<BlockPos, Tree> trees = new HashMap<>();
        List<Operation> clears = new ArrayList<>();
        if (conflicts.isEmpty()) {
            inspect(world, request, placement, groundY, minY, maxY, trees, protectedCells, conflicts, clears);
            clears.sort(Comparator.comparingInt((Operation op) -> op.pos().getY()).reversed()
                .thenComparingInt(op -> op.pos().getX()).thenComparingInt(op -> op.pos().getZ()));
            ops.addAll(clears);
            for (int x = placement.affected().minX(); x <= placement.affected().maxX(); x++) {
                for (int z = placement.affected().minZ(); z <= placement.affected().maxZ(); z++) {
                    findFill(world, x, z, groundY, settings.fillDepth(), ops, conflicts);
                }
            }
            useExcavatedFill(ops, clears);
            addBuild(world, request, placement, clears, protectedCells, ops);
        }

        JsonObject plan = json(request, placement, door, groundY, selection, ops, protectedCells,
            List.copyOf(conflicts), snapshotHash(world, selection), world.materials(request.supplyChest()));
        Direction facing = door == null ? null : settings.rotation().rotate(Direction.NORTH);
        return new Result(plan, List.copyOf(ops), java.util.Collections.unmodifiableSet(protectedCells),
            List.copyOf(conflicts), door, facing, groundY, footprint.width(), footprint.length(),
            placement.shiftX(), placement.shiftZ());
    }

    private static int groundHeight(WorldView world, Area area) {
        Map<Integer, Integer> heights = new TreeMap<>();
        BlockPos.Mutable pos = new BlockPos.Mutable();
        for (int x = area.minX(); x <= area.maxX(); x++) {
            for (int z = area.minZ(); z <= area.maxZ(); z++) {
                int y = world.top(x, z);
                while (y > world.minY()) {
                    BlockState state = world.state(pos.set(x, y, z));
                    if (!(state.isAir() || TerrainRules.leaves(state) || TerrainRules.log(state) || TerrainRules.plant(state))) {
                        break;
                    }
                    y--;
                }
                heights.merge(y + 1, 1, Integer::sum);
            }
        }
        return heights.entrySet().stream().max(Comparator
            .<Map.Entry<Integer, Integer>>comparingInt(Map.Entry::getValue)
            .thenComparing(entry -> -entry.getKey())).orElseThrow().getKey();
    }

    private static int highest(WorldView world, Area area) {
        int result = world.minY();
        for (int x = area.minX(); x <= area.maxX(); x++) {
            for (int z = area.minZ(); z <= area.maxZ(); z++) {
                int top = world.top(x, z);
                // The upper bound covers solid terrain, roofs and canopies. A gravity column
                // can't enlarge it, or the outside-column conflict could never be reported.
                while (top > world.minY() && TerrainRules.falling(world.state(new BlockPos(x, top, z)))) {
                    top--;
                }
                result = Math.max(result, top);
            }
        }
        return result;
    }

    private static Placement placement(Area area, Settings settings, int groundY) {
        var template = HouseTemplates.get(settings.house());
        var rotation = settings.rotation();
        boolean turned = HouseTemplates.quarterTurn(rotation);
        int unitWidth = turned ? template.length() : template.width();
        int unitLength = turned ? template.width() : template.length();
        int tileX = template.farm() ? Math.max(1, (area.width() - 2) / unitWidth) : 1;
        int tileZ = template.farm() ? Math.max(1, (area.length() - 2) / unitLength) : 1;
        int width = unitWidth * tileX;
        int length = unitLength * tileZ;
        int slackX = Math.max(0, area.width() - width - 2);
        int slackZ = Math.max(0, area.length() - length - 2);
        int shiftX = Math.clamp(settings.shiftX(), -slackX / 2, slackX - slackX / 2);
        int shiftZ = Math.clamp(settings.shiftZ(), -slackZ / 2, slackZ - slackZ / 2);
        int x = area.minX() + 1 + slackX / 2 + shiftX;
        int z = area.minZ() + 1 + slackZ / 2 + shiftZ;
        Area footprint = new Area(x, x + width - 1, z, z + length - 1);
        Area affected = settings.mode() == Mode.SELECTION ? area : footprint.expanded(1);
        return new Placement(template, new BlockPos(x, groundY, z), footprint, affected, shiftX, shiftZ, tileX, tileZ);
    }

    private static void inspect(WorldView world, Request request, Placement placement, int groundY, int minY, int maxY,
                                Map<BlockPos, Tree> trees, Set<BlockPos> protectedCells, Set<Conflict> conflicts,
                                List<Operation> clears) {
        Area area = request.area();
        Area affected = placement.affected();
        for (int x = area.minX(); x <= area.maxX(); x++) {
            for (int z = area.minZ(); z <= area.maxZ(); z++) {
                int top = Math.min(maxY, world.top(x, z));
                for (int y = minY; y <= top; y++) {
                    BlockPos pos = new BlockPos(x, y, z);
                    BlockState old = world.state(pos);
                    if (old.isAir()) {
                        continue;
                    }
                    boolean removable = TerrainRules.naturalToClear(old);
                    Tree tree = null;
                    if (TerrainRules.log(old) && !old.hasBlockEntity()) {
                        tree = tree(world, pos, request.area(), trees);
                        removable = tree.natural();
                    }
                    boolean clear = y >= groundY && affected.contains(pos);
                    if (!removable) {
                        protectedCells.add(pos);
                        if (clear) {
                            conflicts.add(new Conflict(ConflictKind.PROTECTED, pos));
                        }
                    } else if (clear) {
                        if (!request.settings().clipTrees() &&
                            (tree != null && tree.crossBoundary() || TerrainRules.naturalLeaves(old) &&
                                leafAcrossBorder(world, pos, area))) {
                            conflicts.add(new Conflict(ConflictKind.CROSS_BOUNDARY_TREE, pos));
                        }
                        checkClear(world, pos,
                            neighbor -> area.contains(neighbor) && affected.contains(neighbor) && neighbor.getY() <= maxY,
                            conflicts::add);
                        String kind = TerrainRules.naturalGround(old) ? "cut" : "clear";
                        clears.add(new Operation(pos, old, AIR, kind, "terrain"));
                    }
                }
            }
        }
    }

    private static Tree tree(WorldView world, BlockPos seed, Area area, Map<BlockPos, Tree> cache) {
        Tree known = cache.get(seed);
        if (known != null) {
            return known;
        }
        Area boundary = area.expanded(INSPECTION_BAND);
        Set<BlockPos> logs = new LinkedHashSet<>();
        ArrayDeque<BlockPos> queue = new ArrayDeque<>();
        queue.add(seed);
        logs.add(seed);
        boolean natural = false;
        boolean cross = false;
        while (!queue.isEmpty()) {
            BlockPos pos = queue.removeFirst();
            cross |= !area.contains(pos);
            for (BlockPos adjacent : BlockPos.iterate(pos.add(-1, -1, -1), pos.add(1, 1, 1))) {
                if (adjacent.getY() < world.minY() || adjacent.getY() > world.maxY()) {
                    continue;
                }
                BlockState state = world.state(adjacent);
                if (TerrainRules.log(state) && boundary.contains(adjacent) && logs.add(adjacent.toImmutable())) {
                    queue.add(adjacent.toImmutable());
                } else if (TerrainRules.naturalLeaves(state)) {
                    natural = true;
                    cross |= leafAcrossBorder(world, adjacent, area);
                }
            }
        }
        Tree result = new Tree(natural, cross);
        logs.forEach(pos -> cache.put(pos, result));
        return result;
    }

    private static boolean leafAcrossBorder(WorldView world, BlockPos seed, Area area) {
        if (!area.contains(seed)) {
            return true;
        }
        if (seed.getX() - area.minX() >= 6 && area.maxX() - seed.getX() >= 6 &&
            seed.getZ() - area.minZ() >= 6 && area.maxZ() - seed.getZ() >= 6) {
            return false;
        }
        // Vanilla leaves can connect up to six steps from a supporting log.
        Set<BlockPos> visited = new HashSet<>();
        ArrayDeque<BlockPos> level = new ArrayDeque<>();
        level.add(seed.toImmutable());
        visited.add(seed.toImmutable());
        for (int step = 0; step < 6 && !level.isEmpty(); step++) {
            int count = level.size();
            for (int index = 0; index < count; index++) {
                BlockPos pos = level.removeFirst();
                for (Direction direction : Direction.values()) {
                    BlockPos adjacent = pos.offset(direction);
                    if (!visited.add(adjacent)) {
                        continue;
                    }
                    BlockState state = world.state(adjacent);
                    if (TerrainRules.naturalLeaves(state)) {
                        if (!area.contains(adjacent)) {
                            return true;
                        }
                        level.add(adjacent);
                    }
                }
            }
        }
        return false;
    }

    public static String firstSiteConflict(ServerWorld world, JsonObject document, JsonArray remaining,
                                           Map<BlockPos, String> finalTargets, Map<BlockPos, String> protectedBaseline) {
        return firstSiteConflict(view(world), document, remaining, finalTargets, protectedBaseline);
    }

    static String firstSiteConflict(WorldView world, JsonObject document, JsonArray remaining,
                                    Map<BlockPos, String> finalTargets, Map<BlockPos, String> protectedBaseline) {
        var selection = SelectionBounds.read(document);
        var next = new LinkedHashMap<BlockPos, JsonObject>();
        for (var entry : remaining) {
            var op = entry.getAsJsonObject();
            var coords = op.getAsJsonObject("pos");
            var pos = new BlockPos(coords.get("x").getAsInt(), coords.get("y").getAsInt(), coords.get("z").getAsInt());
            next.putIfAbsent(pos, op);
        }
        Predicate<BlockPos> scheduledRemoval = pos -> next.containsKey(pos) && removesBlock(next.get(pos));
        Map<BlockPos, Tree> trees = new HashMap<>();
        for (var entry : next.entrySet()) {
            BlockPos pos = entry.getKey();
            JsonObject op = entry.getValue();
            if (!selection.contains(pos)) return at("outside_selection", pos);
            if (protectedBaseline.containsKey(pos)) return at("protected_block_changed", pos);
            BlockState actual = world.state(pos);
            String expected = op.get("expect").getAsString();
            if (!matchesExpect(op.get("kind").getAsString(), expected, op.get("target").getAsString(), actual,
                () -> tree(world, pos, selection.area(), trees).natural())) {
                String reason = mismatch(pos, expected, actual);
                return TerrainRules.naturalToClear(actual) || TerrainRules.replaceableForBuild(actual)
                    ? reason : reason + " (protected_block_changed)";
            }
            if (removesBlock(op)) {
                String conflict = removalConflict(world, document, selection, pos, scheduledRemoval, trees);
                if (conflict != null) return conflict;
            }
        }
        for (var target : finalTargets.entrySet()) {
            BlockPos pos = target.getKey();
            if (!next.containsKey(pos)) {
                BlockState actual = world.state(pos);
                if (!matchesFinalTarget(document, pos, target.getValue(), actual, world.randomTicksEnabled())) {
                    return mismatch(pos, target.getValue(), actual);
                }
            }
        }
        for (var entry : protectedBaseline.entrySet()) {
            if (!matchesState(entry.getValue(), world.state(entry.getKey()))) {
                return at("protected_block_changed", entry.getKey());
            }
        }
        return null;
    }

    private static boolean removesBlock(JsonObject op) {
        return op.get("target").getAsString().equals("minecraft:air");
    }

    private static String mismatch(BlockPos pos, String expected, BlockState actual) {
        return at("expected_block_changed", pos) + " expected " + expected + " actual " + stateName(actual);
    }

    public static String removalConflict(ServerWorld world, JsonObject document, BlockPos pos,
                                         Predicate<BlockPos> scheduledRemoval) {
        return removalConflict(view(world), document, SelectionBounds.read(document), pos, scheduledRemoval, new HashMap<>());
    }

    private static String removalConflict(WorldView world, JsonObject document, SelectionBounds selection, BlockPos pos,
                                          Predicate<BlockPos> scheduledRemoval, Map<BlockPos, Tree> trees) {
        BlockState actual = world.state(pos);
        if (!document.has("clipTrees") || !document.get("clipTrees").getAsBoolean()) {
            var area = selection.area();
            if (TerrainRules.log(actual) && tree(world, pos, area, trees).crossBoundary() ||
                TerrainRules.naturalLeaves(actual) && leafAcrossBorder(world, pos, area)) {
                return at("cross_boundary_tree", pos);
            }
        }
        var conflicts = new ArrayList<Conflict>();
        checkClear(world, pos, neighbor -> selection.contains(neighbor) && scheduledRemoval.test(neighbor), conflicts::add);
        if (conflicts.isEmpty()) return null;
        var first = conflicts.getFirst();
        return at(first.kind().name().toLowerCase(Locale.ROOT), first.pos());
    }

    private static String at(String reason, BlockPos pos) {
        return reason + " at " + pos.toShortString();
    }

    public static boolean matchesExpect(ServerWorld world, BlockPos pos, String kind, String expected,
                                        String target, BlockState current) {
        var area = Area.between(pos, pos);
        return matchesExpect(kind, expected, target, current, () -> tree(view(world), pos, area, new HashMap<>()).natural());
    }

    static boolean matchesExpect(String kind, String expected, String target, BlockState current, BooleanSupplier naturalLog) {
        return switch (kind) {
            case "clear", "cut" -> TerrainRules.naturalToClear(current) || TerrainRules.log(current) &&
                // During construction the canopy may already be gone. An exact log from the
                // approved operation preserves the natural-tree check done at compilation.
                (expected.equals(stateName(current)) || naturalLog.getAsBoolean());
            case "fill" -> TerrainRules.replaceableForBuild(current);
            case "build", "furnish", "scaffold" -> matchesState(expected, current) ||
                TerrainRules.replaceableForBuild(current) && defaultReplaceable(expected) ||
                // Prepared dirt can grow grass before the hoe reaches this cell.
                kind.equals("build") && expected.equals("minecraft:dirt") &&
                    "minecraft:farmland[moisture=0]".equals(target) && current.isOf(Blocks.GRASS_BLOCK);
            default -> false;
        };
    }

    private static boolean defaultReplaceable(String state) {
        var block = blockFromState(state);
        return block != null && TerrainRules.replaceableForBuild(block.getDefaultState());
    }

    public static boolean matchesState(String expected, BlockState current) {
        return matchesState(expected, stateName(current));
    }

    public static boolean matchesFinalTarget(JsonObject plan, BlockPos pos, String expected, BlockState current,
                                             boolean randomTicksEnabled) {
        if (matchesState(expected, current)) return true;
        if (!randomTicksEnabled) return false;
        // The action itself still must place the exact authorized target.
        return switch (expected) {
            case "minecraft:dirt" -> current.isOf(Blocks.GRASS_BLOCK) && plan.has("groundY")
                && pos.getY() < plan.get("groundY").getAsInt();
            case "minecraft:farmland[moisture=0]" -> current.isOf(Blocks.FARMLAND);
            case "minecraft:wheat[age=0]" -> current.isOf(Blocks.WHEAT);
            default -> false;
        };
    }

    public static boolean matchesState(String expected, String current) {
        if (expected.equals(current)) return true;
        return hasBenignOpen(blockFromState(current)) &&
            expected.replace("open=true", "open=false").equals(current.replace("open=true", "open=false"));
    }

    public static boolean isOpenToggle(BlockState before, BlockState after) {
        return before.getBlock() == after.getBlock() && hasBenignOpen(before.getBlock()) &&
            before.get(Properties.OPEN) != after.get(Properties.OPEN) &&
            before.with(Properties.OPEN, after.get(Properties.OPEN)) == after;
    }

    private static boolean hasBenignOpen(Block block) {
        return block instanceof DoorBlock || block instanceof TrapdoorBlock || block instanceof FenceGateBlock ||
            block instanceof BarrelBlock;
    }

    private static Block blockFromState(String state) {
        int properties = state.indexOf('[');
        var id = Identifier.tryParse(properties < 0 ? state : state.substring(0, properties));
        return id == null ? null : Registries.BLOCK.getOptionalValue(id).orElse(null);
    }

    private static void checkClear(WorldView world, BlockPos pos, Predicate<BlockPos> plannedRemoval,
                                   Consumer<Conflict> conflict) {
        for (Direction direction : Direction.values()) {
            BlockPos neighbor = pos.offset(direction);
            if (!world.state(neighbor).getFluidState().isEmpty()) {
                conflict.accept(new Conflict(ConflictKind.ADJACENT_FLUID, pos));
            }
        }
        if (!world.state(pos).getFluidState().isEmpty()) {
            conflict.accept(new Conflict(ConflictKind.ADJACENT_FLUID, pos));
        }
        for (BlockPos top = pos.up(); top.getY() <= world.maxY() && TerrainRules.falling(world.state(top)); top = top.up()) {
            if (!plannedRemoval.test(top) || world.state(top).hasBlockEntity()) {
                conflict.accept(new Conflict(ConflictKind.FALLING_COLUMN, top));
                break;
            }
        }
        for (BlockPos neighbor : BlockPos.iterate(pos.add(-1, -1, -1), pos.add(1, 1, 1))) {
            if (!neighbor.equals(pos) && !plannedRemoval.test(neighbor) &&
                TerrainRules.supportedBy(world.state(neighbor), neighbor, pos)) {
                conflict.accept(new Conflict(ConflictKind.OUTSIDE_ATTACHMENT, neighbor.toImmutable()));
            }
        }
    }

    private static void findFill(WorldView world, int x, int z, int groundY, int limit,
                                 List<Operation> ops, Set<Conflict> conflicts) {
        List<Operation> column = new ArrayList<>();
        for (int depth = 1; depth <= limit + 1; depth++) {
            BlockPos pos = new BlockPos(x, groundY - depth, z);
            if (pos.getY() < world.minY()) {
                conflicts.add(new Conflict(ConflictKind.VERTICAL_LIMIT, pos));
                return;
            }
            BlockState old = world.state(pos);
            if (old.isSolid() && old.getFluidState().isEmpty()) {
                ops.addAll(column.reversed());
                return;
            }
            if (!TerrainRules.replaceableForBuild(old)) {
                conflicts.add(new Conflict(ConflictKind.UNSUPPORTED_FOUNDATION, pos));
                return;
            }
            if (depth > limit) {
                conflicts.add(new Conflict(ConflictKind.FILL_TOO_DEEP, pos));
                return;
            }
            column.add(new Operation(pos, old, DIRT, "fill", "terrain"));
        }
    }

    private static void useExcavatedFill(List<Operation> ops, List<Operation> clears) {
        if (ops.size() == clears.size() || clears.isEmpty()) return;
        Map<String, Integer> excavated = new HashMap<>();
        for (Operation clear : clears) {
            String drop = excavationDrop(clear.expect());
            if (drop != null) increment(excavated, drop);
        }
        for (int i = clears.size(); i < ops.size(); i++) {
            Operation fill = ops.get(i);
            for (Block material : FILL_BLOCKS) {
                String id = Registries.BLOCK.getId(material).toString();
                int available = excavated.getOrDefault(id, 0);
                if (available == 0) continue;
                excavated.put(id, available - 1);
                if (material != Blocks.DIRT) {
                    ops.set(i, new Operation(fill.pos(), fill.expect(), material.getDefaultState(), fill.kind(), fill.phase()));
                }
                break;
            }
        }
    }

    private static void addBuild(WorldView world, Request request, Placement placement, List<Operation> clears,
                                 Set<BlockPos> protectedCells, List<Operation> ops) {
        var template = placement.template();
        var rotation = request.settings().rotation();
        boolean turned = HouseTemplates.quarterTurn(rotation);
        int unitWidth = turned ? template.length() : template.width();
        int unitLength = turned ? template.width() : template.length();
        Set<BlockPos> cleared = new HashSet<>();
        for (Operation op : clears) {
            cleared.add(op.pos());
        }
        List<Operation> build = new ArrayList<>();
        for (int x = 0; x < placement.tileX(); x++) {
            for (int z = 0; z < placement.tileZ(); z++) {
                BlockPos anchor = placement.anchor().add(x * unitWidth, 0, z * unitLength);
                for (HouseTemplates.Cell cell : template.cells()) {
                    BlockPos pos = anchor.add(HouseTemplates.rotate(cell.local(), template.width(), template.length(), rotation));
                    BlockState target = cell.state().rotate(rotation);
                    if (!protectedCells.contains(pos)) {
                        BlockState old = cleared.contains(pos) ? AIR : world.state(pos);
                        String phase = phase(template, cell);
                        if (template.farm() && target.isOf(Blocks.FARMLAND)) {
                            // The raised soil encloses the center before water is added.
                            build.add(new Operation(pos, old, DIRT, "build", "foundation"));
                            old = DIRT;
                        }
                        build.add(new Operation(pos, old, target, phase.equals("furnish") ? "furnish" : "build", phase));
                    }
                }
                for (BlockPos local : template.scaffolds()) {
                    BlockPos pos = anchor.add(HouseTemplates.rotate(local, template.width(), template.length(), rotation));
                    if (!protectedCells.contains(pos)) {
                        build.add(new Operation(pos, cleared.contains(pos) ? AIR : world.state(pos), DIRT, "scaffold", "scaffold"));
                        build.add(new Operation(pos, DIRT, AIR, "scaffold", "remove_scaffold"));
                    }
                }
            }
        }
        List<String> phases = template.phases();
        build.sort(Comparator.comparingInt((Operation op) -> {
            int index = phases.indexOf(op.phase());
            return index == -1 ? phases.size() : index;
        }).thenComparingInt(op -> op.phase().equals("remove_scaffold") ? -op.pos().getY() : op.pos().getY())
            .thenComparingInt(op -> template.buildOrder().equals("roof_outside_in") && op.phase().equals("roof")
                ? ring(placement.footprint(), op.pos()) : 0));
        ops.addAll(build);
    }

    private static int ring(Area area, BlockPos pos) {
        return Math.min(Math.min(pos.getX() - area.minX(), area.maxX() - pos.getX()),
            Math.min(pos.getZ() - area.minZ(), area.maxZ() - pos.getZ()));
    }

    private static String phase(HouseTemplates.Template template, HouseTemplates.Cell cell) {
        String id = TerrainRules.id(cell.state());
        if (template.farm()) {
            return switch (id) {
                case "water" -> "irrigate";
                case "farmland" -> "till";
                default -> "sow";
            };
        }
        if (Set.of("torch", "red_bed", "chest", "furnace", "crafting_table").contains(id)) {
            return "furnish";
        }
        if (cell.local().getY() == template.height() - 2) {
            return "roof";
        }
        if (template.type() == HouseTemplates.Type.PORCH_CABIN && cell.local().getY() == 2) {
            return "upper_walls";
        }
        if (template.type() == HouseTemplates.Type.TWO_STOREY_HOUSE) {
            if (id.equals("oak_stairs") && cell.local().getY() == 0) return "stair_base";
            if (cell.local().getY() >= 4) return "upper_walls";
            if (cell.local().getY() == 3 || id.equals("oak_stairs")) return "floor";
        }
        return "walls";
    }

    private static JsonObject json(Request request, Placement placement, BlockPos door, int groundY, JsonObject selection,
                                   List<Operation> ops, Set<BlockPos> protectedCells, List<Conflict> conflicts,
                                   String snapshot, Map<String, Integer> supply) {
        JsonObject plan = new JsonObject();
        plan.addProperty("planId", request.planId().toString());
        plan.addProperty("revision", request.revision());
        plan.addProperty("worldId", request.worldId().toString());
        plan.addProperty("dimension", request.dimension());
        plan.addProperty("ownerUuid", request.ownerUuid().toString());
        plan.addProperty("botUuid", request.botUuid() == null ? null : request.botUuid().toString());
        plan.add("selection", selection);
        JsonObject template = new JsonObject();
        template.addProperty("id", placement.template().type().id);
        template.addProperty("version", placement.template().version());
        template.addProperty("rotation", request.settings().rotation().ordinal() * 90);
        template.add("anchor", position(placement.anchor()));
        template.add("entrance", position(placement.anchor().add(HouseTemplates.rotate(placement.template().entrance(),
            placement.template().width(), placement.template().length(), request.settings().rotation()))));
        template.add("door", position(door));
        plan.add("template", template);
        plan.addProperty("groundY", groundY);
        plan.addProperty("mode", request.settings().mode().name().toLowerCase(Locale.ROOT));
        plan.addProperty("fillDepthLimit", request.settings().fillDepth());
        plan.addProperty("clipTrees", request.settings().clipTrees());
        JsonArray operations = new JsonArray();
        for (int order = 0; order < ops.size(); order++) {
            Operation op = ops.get(order);
            JsonObject object = new JsonObject();
            object.add("pos", position(op.pos()));
            object.addProperty("expect", stateName(op.expect()));
            object.addProperty("target", stateName(op.target()));
            object.addProperty("kind", op.kind());
            object.addProperty("phase", op.phase());
            object.addProperty("order", order);
            operations.add(object);
        }
        plan.add("ops", operations);
        JsonArray protectedPositions = new JsonArray();
        protectedCells.forEach(pos -> protectedPositions.add(position(pos)));
        plan.add("protected", protectedPositions);
        JsonArray rejected = new JsonArray();
        conflicts.forEach(conflict -> {
            JsonObject info = new JsonObject();
            info.addProperty("kind", conflict.kind().name().toLowerCase(Locale.ROOT));
            info.add("pos", position(conflict.pos()));
            rejected.add(info);
        });
        plan.add("conflicts", rejected);
        plan.add("materials", materials(ops, supply, placement));
        plan.add("supplyChest", position(request.supplyChest()));
        plan.addProperty("snapshotHash", snapshot);
        plan.addProperty("expiresAt", request.now() + PREVIEW_MILLIS);
        plan.addProperty("planHash", sha256(plan));
        return plan;
    }

    private static JsonObject materials(List<Operation> ops, Map<String, Integer> supply, Placement placement) {
        Map<String, Integer> required = new TreeMap<>();
        Map<String, Integer> excavated = new TreeMap<>();
        int hoeUses = 0;
        for (Operation op : ops) {
            if (op.kind().equals("cut") || op.kind().equals("clear")) {
                String drop = excavationDrop(op.expect());
                if (drop != null) increment(excavated, drop);
                continue;
            }
            if (op.kind().equals("scaffold")) {
                if (!op.target().isAir()) increment(required, "minecraft:dirt");
                continue;
            }
            String id = TerrainRules.id(op.target());
            if (id.endsWith("_door") && op.target().get(Properties.DOUBLE_BLOCK_HALF).asString().equals("upper") ||
                id.endsWith("_bed") && op.target().get(Properties.BED_PART).asString().equals("head")) {
                continue;
            }
            if (placement.template().farm() && id.equals("farmland")) {
                hoeUses++;
            } else if (placement.template().farm() && id.equals("water")) {
                increment(required, "minecraft:water_bucket");
            } else if (placement.template().farm() && id.equals("wheat")) {
                increment(required, "minecraft:wheat_seeds");
            } else {
                increment(required, Registries.ITEM.getId(op.target().getBlock().asItem()).toString());
            }
        }
        int woodenHoeUses = Items.WOODEN_HOE.getDefaultStack().getMaxDamage();
        if (hoeUses > 0) required.put("minecraft:wooden_hoe", Math.ceilDiv(hoeUses, woodenHoeUses));
        int tilling = hoeUses;
        TreeMap<String, Integer> deficit = new TreeMap<>();
        required.forEach((id, count) -> {
            int supplied = supply.getOrDefault(id, 0);
            if (id.equals("minecraft:wooden_hoe")) {
                int uses = supply.entrySet().stream().filter(item -> item.getKey().endsWith("_hoe"))
                    .mapToInt(item -> Registries.ITEM.get(Identifier.of(item.getKey())).getDefaultStack().getMaxDamage()
                        * item.getValue()).sum();
                int shortage = Math.ceilDiv(Math.max(0, tilling - uses), woodenHoeUses);
                if (shortage > 0) deficit.put(id, shortage);
                return;
            }
            int missing = count - excavated.getOrDefault(id, 0) - supplied;
            if (missing > 0) {
                deficit.put(id, missing);
            }
        });
        JsonObject json = new JsonObject();
        json.add("required", counts(required));
        json.add("excavated", counts(excavated));
        json.add("available", counts(supply));
        json.add("deficit", counts(deficit));
        return json;
    }

    private static String excavationDrop(BlockState state) {
        // Usual drops with a suitable tool. Execution checks the actual inventory.
        String id = TerrainRules.id(state);
        return switch (id) {
            case "stone" -> "minecraft:cobblestone";
            case "deepslate" -> "minecraft:cobbled_deepslate";
            case "grass_block", "podzol", "mycelium" -> "minecraft:dirt";
            case "clay", "snow", "snow_block", "gravel" -> null;
            default -> TerrainRules.naturalGround(state) || TerrainRules.log(state)
                ? Registries.BLOCK.getId(state.getBlock()).toString() : null;
        };
    }

    private static void increment(Map<String, Integer> counts, String id) {
        counts.merge(id, 1, Integer::sum);
    }

    private static JsonObject counts(Map<String, Integer> counts) {
        JsonObject json = new JsonObject();
        counts.forEach(json::addProperty);
        return json;
    }

    private static JsonElement position(BlockPos pos) {
        if (pos == null) {
            return JsonNull.INSTANCE;
        }
        JsonObject json = new JsonObject();
        json.addProperty("x", pos.getX());
        json.addProperty("y", pos.getY());
        json.addProperty("z", pos.getZ());
        return json;
    }

    public static String snapshotHash(ServerWorld world, JsonObject selection) {
        return snapshotHash(view(world), selection);
    }

    private static String snapshotHash(WorldView world, JsonObject selection) {
        int minY = Math.max(world.minY(), selection.get("minY").getAsInt() - 1);
        int maxY = Math.min(world.maxY(), selection.get("maxY").getAsInt() + 1);
        int minX = selection.get("minX").getAsInt() - INSPECTION_BAND;
        int maxX = selection.get("maxX").getAsInt() + INSPECTION_BAND;
        int minZ = selection.get("minZ").getAsInt() - INSPECTION_BAND;
        int maxZ = selection.get("maxZ").getAsInt() + INSPECTION_BAND;
        MessageDigest digest = digest();
        digest.update(canonical(selection).getBytes(StandardCharsets.UTF_8));
        Map<BlockState, byte[]> descriptions = new IdentityHashMap<>();
        BlockPos.Mutable pos = new BlockPos.Mutable();
        for (int y = minY; y <= maxY; y++) {
            for (int x = minX; x <= maxX; x++) {
                for (int z = minZ; z <= maxZ; z++) {
                    BlockState state = world.state(pos.set(x, y, z));
                    digest.update(descriptions.computeIfAbsent(state,
                        value -> ("\n" + stateName(value)).getBytes(StandardCharsets.UTF_8)));
                }
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    public static String stateName(BlockState state) {
        String id = Registries.BLOCK.getId(state.getBlock()).toString();
        return state.getProperties().isEmpty() ? id : id + "[" + state.getProperties().stream()
            .sorted(Comparator.comparing(Property::getName)).map(property -> stateProperty(state, property))
            .collect(java.util.stream.Collectors.joining(",")) + "]";
    }

    private static <T extends Comparable<T>> String stateProperty(BlockState state, Property<T> property) {
        return property.getName() + "=" + property.name(state.get(property));
    }

    public static String canonical(JsonElement json) {
        return JSON.toJson(sorted(json));
    }

    private static JsonElement sorted(JsonElement json) {
        if (json.isJsonArray()) {
            JsonArray result = new JsonArray();
            json.getAsJsonArray().forEach(element -> result.add(sorted(element)));
            return result;
        }
        if (json.isJsonObject()) {
            JsonObject result = new JsonObject();
            json.getAsJsonObject().entrySet().stream().sorted(Map.Entry.comparingByKey())
                .forEach(entry -> result.add(entry.getKey(), sorted(entry.getValue())));
            return result;
        }
        return json;
    }

    public static String sha256(JsonElement json) {
        return HexFormat.of().formatHex(digest().digest(canonical(json).getBytes(StandardCharsets.UTF_8)));
    }

    private static MessageDigest digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException(exception);
        }
    }
}
