package dev.deskpet.minecraft.wand;

import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.registry.Registries;
import net.minecraft.state.property.Properties;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;

import java.util.Set;

final class TerrainRules {
    private static final Set<String> NATURAL_GROUND = Set.of(
        "dirt", "coarse_dirt", "rooted_dirt", "grass_block", "podzol", "mycelium", "mud",
        "stone", "granite", "diorite", "andesite", "deepslate", "tuff", "calcite", "dripstone_block",
        "sand", "red_sand", "gravel", "sandstone", "red_sandstone", "clay", "snow", "snow_block"
    );
    private static final Set<String> NATURAL_PLANTS = Set.of(
        "short_grass", "tall_grass", "fern", "large_fern", "dead_bush", "bush", "firefly_bush",
        "short_dry_grass", "tall_dry_grass", "dandelion", "poppy", "blue_orchid", "allium",
        "azure_bluet", "red_tulip", "orange_tulip", "white_tulip", "pink_tulip", "oxeye_daisy",
        "cornflower", "lily_of_the_valley", "wither_rose", "torchflower", "pink_petals", "wildflowers",
        "sunflower", "lilac", "rose_bush", "peony", "open_eyeblossom", "closed_eyeblossom", "leaf_litter"
    );

    private TerrainRules() {}

    static String id(BlockState state) {
        return Registries.BLOCK.getId(state.getBlock()).getPath();
    }

    static boolean naturalGround(BlockState state) {
        return isVanilla(state) && NATURAL_GROUND.contains(id(state));
    }

    static boolean plant(BlockState state) {
        return isVanilla(state) && NATURAL_PLANTS.contains(id(state));
    }

    static boolean naturalToClear(BlockState state) {
        return !state.hasBlockEntity() && (naturalGround(state) || plant(state) || naturalLeaves(state));
    }

    static boolean replaceableForBuild(BlockState state) {
        return state.getFluidState().isEmpty() &&
            (state.isAir() || state.isOf(Blocks.SNOW) || plant(state) && state.isReplaceable());
    }

    static boolean log(BlockState state) {
        String id = id(state);
        return isVanilla(state) && id.endsWith("_log") && !id.startsWith("stripped_");
    }

    static boolean leaves(BlockState state) {
        return isVanilla(state) && state.contains(Properties.PERSISTENT) && id(state).endsWith("_leaves");
    }

    private static boolean isVanilla(BlockState state) {
        return Registries.BLOCK.getId(state.getBlock()).getNamespace().equals("minecraft");
    }

    static boolean naturalLeaves(BlockState state) {
        return leaves(state) && !state.get(Properties.PERSISTENT);
    }

    static boolean falling(BlockState state) {
        return switch (id(state)) {
            case "sand", "red_sand", "gravel", "suspicious_sand", "suspicious_gravel" -> true;
            default -> false;
        };
    }

    static boolean supportedBy(BlockState attached, BlockPos attachedPos, BlockPos support) {
        if (attached.isAir()) {
            return false;
        }
        String id = id(attached);
        Direction facing = attached.getOrEmpty(Properties.HORIZONTAL_FACING).orElse(Direction.NORTH);
        if (attached.contains(Properties.BLOCK_FACE)) {
            return switch (attached.get(Properties.BLOCK_FACE)) {
                case FLOOR -> support.equals(attachedPos.down());
                case CEILING -> support.equals(attachedPos.up());
                case WALL -> support.equals(attachedPos.offset(facing.getOpposite()));
            };
        }
        if (id.startsWith("wall_") || id.contains("_wall_") || id.equals("ladder")) {
            return support.equals(attachedPos.offset(facing.getOpposite()));
        }
        if (id.equals("vine")) {
            Direction direction = Direction.fromVector(support.getX() - attachedPos.getX(),
                support.getY() - attachedPos.getY(), support.getZ() - attachedPos.getZ(), null);
            return direction != null && switch (direction) {
                case UP -> attached.get(Properties.UP);
                case NORTH -> attached.get(Properties.NORTH);
                case SOUTH -> attached.get(Properties.SOUTH);
                case EAST -> attached.get(Properties.EAST);
                case WEST -> attached.get(Properties.WEST);
                default -> false;
            };
        }
        if (support.equals(attachedPos.down())) {
            return plant(attached) || id.endsWith("_sapling") || id.endsWith("_mushroom") ||
                id.endsWith("_orchid") || id.endsWith("_fungus") || id.endsWith("_roots") ||
                id.endsWith("_sign") || id.endsWith("_carpet") || id.endsWith("rail") ||
                id.endsWith("_door") || id.endsWith("torch") || Set.of("redstone_wire", "wheat", "carrots",
                    "potatoes", "beetroots", "bamboo", "bamboo_sapling", "sugar_cane", "cactus",
                    "sweet_berry_bush", "nether_wart", "melon_stem", "pumpkin_stem").contains(id);
        }
        if (id.equals("sugar_cane")) {
            return support.getY() == attachedPos.getY() - 1 &&
                Math.abs(support.getX() - attachedPos.getX()) + Math.abs(support.getZ() - attachedPos.getZ()) == 1;
        }
        return false;
    }

    static Direction facing(BlockState state) {
        return state.getOrEmpty(Properties.HORIZONTAL_FACING).orElse(Direction.NORTH);
    }
}
