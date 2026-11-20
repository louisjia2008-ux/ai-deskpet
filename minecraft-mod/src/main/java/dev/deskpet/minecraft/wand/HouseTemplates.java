package dev.deskpet.minecraft.wand;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.block.BlockState;
import net.minecraft.nbt.NbtCompound;
import net.minecraft.nbt.NbtHelper;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.NbtList;
import net.minecraft.nbt.NbtSizeTracker;
import net.minecraft.registry.Registries;
import net.minecraft.util.BlockRotation;
import net.minecraft.util.math.BlockPos;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;

final class HouseTemplates {
    enum Type {
        STARTER_HOUSE("生存小屋", "starter_house"),
        PORCH_CABIN("门廊木屋", "porch_cabin"),
        TWO_STOREY_HOUSE("双层石木房", "two_storey_house"),
        WHEAT_FIELD("小麦田", "wheat_field");

        final String label;
        final String id;

        Type(String label, String id) {
            this.label = label;
            this.id = id;
        }
    }

    record Cell(BlockPos local, BlockState state) {}
    record Template(Type type, int version, int width, int height, int length, BlockPos entrance,
                    BlockPos door, List<Cell> cells, List<BlockPos> scaffolds, List<String> phases,
                    String buildOrder) {
        boolean farm() {
            return type == Type.WHEAT_FIELD;
        }
    }

    private static final Set<String> HOUSE_BLOCKS = Set.of(
        "cobblestone", "oak_planks", "oak_log", "glass", "oak_door", "oak_stairs", "oak_slab",
        "torch", "red_bed", "chest", "furnace", "crafting_table"
    );
    private static final Set<String> FARM_BLOCKS = Set.of("farmland", "wheat", "water");
    private static List<Template> templates;

    private HouseTemplates() {}

    static Template get(Type type) {
        if (templates == null) {
            templates = Arrays.stream(Type.values()).map(HouseTemplates::read).toList();
        }
        return templates.get(type.ordinal());
    }

    private static Template read(Type type) {
        String base = "/data/deskpet/";
        try (InputStream structure = resource(base + "structure/" + type.id + ".nbt");
             InputStreamReader metadataReader = new InputStreamReader(
                 resource(base + "house/" + type.id + ".json"), StandardCharsets.UTF_8)) {
            JsonObject metadata = JsonParser.parseReader(metadataReader).getAsJsonObject();
            NbtCompound nbt = NbtIo.readCompressed(structure, NbtSizeTracker.of(1_000_000));
            NbtList size = nbt.getListOrEmpty("size");
            List<BlockState> palette = new ArrayList<>();
            for (var tag : nbt.getListOrEmpty("palette")) {
                BlockState state = NbtHelper.toBlockState(Registries.BLOCK, (NbtCompound) tag);
                String id = Registries.BLOCK.getId(state.getBlock()).getPath();
                Set<String> allowed = type == Type.WHEAT_FIELD ? FARM_BLOCKS : HOUSE_BLOCKS;
                if (!allowed.contains(id)) {
                    throw new IOException("Unsupported template block " + id);
                }
                palette.add(state);
            }
            List<Cell> cells = new ArrayList<>();
            for (var tag : nbt.getListOrEmpty("blocks")) {
                NbtCompound entry = (NbtCompound) tag;
                NbtList pos = entry.getListOrEmpty("pos");
                BlockPos local = new BlockPos(pos.getInt(0, 0), pos.getInt(1, 0), pos.getInt(2, 0));
                cells.add(new Cell(local, palette.get(entry.getInt("state", -1))));
            }
            List<BlockPos> scaffolds = new ArrayList<>();
            metadata.getAsJsonArray("scaffold").forEach(pos -> scaffolds.add(position(pos.getAsJsonArray())));
            List<String> phases = new ArrayList<>();
            metadata.getAsJsonArray("phases").forEach(phase -> phases.add(phase.getAsString()));
            return new Template(type, metadata.get("version").getAsInt(), size.getInt(0, 0), size.getInt(1, 0),
                size.getInt(2, 0), position(metadata.getAsJsonArray("entrance")),
                metadata.get("door").isJsonNull() ? null : position(metadata.getAsJsonArray("door")),
                List.copyOf(cells), List.copyOf(scaffolds), List.copyOf(phases),
                metadata.get("buildOrder").getAsString());
        } catch (IOException | RuntimeException exception) {
            throw new IllegalStateException("Could not read house template " + type.id, exception);
        }
    }

    private static BlockPos position(com.google.gson.JsonArray array) {
        return new BlockPos(array.get(0).getAsInt(), array.get(1).getAsInt(), array.get(2).getAsInt());
    }

    private static InputStream resource(String path) throws IOException {
        InputStream stream = HouseTemplates.class.getResourceAsStream(path);
        if (stream == null) {
            throw new IOException("Missing resource " + path);
        }
        return stream;
    }

    static boolean quarterTurn(BlockRotation rotation) {
        return rotation == BlockRotation.CLOCKWISE_90 || rotation == BlockRotation.COUNTERCLOCKWISE_90;
    }

    static BlockPos rotate(BlockPos local, int width, int length, BlockRotation rotation) {
        int x = local.getX();
        int y = local.getY();
        int z = local.getZ();
        return switch (rotation) {
            case NONE -> local;
            case CLOCKWISE_90 -> new BlockPos(length - 1 - z, y, x);
            case CLOCKWISE_180 -> new BlockPos(width - 1 - x, y, length - 1 - z);
            case COUNTERCLOCKWISE_90 -> new BlockPos(z, y, width - 1 - x);
        };
    }
}
