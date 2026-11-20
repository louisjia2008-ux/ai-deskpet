package dev.deskpet.minecraft.wand;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import eu.pb4.polymer.virtualentity.api.ElementHolder;
import eu.pb4.polymer.virtualentity.api.attachment.ManualAttachment;
import eu.pb4.polymer.virtualentity.api.elements.AbstractElement;
import eu.pb4.polymer.virtualentity.api.elements.BlockDisplayElement;
import eu.pb4.polymer.virtualentity.api.elements.TextDisplayElement;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.entity.decoration.Brightness;
import net.minecraft.entity.decoration.DisplayEntity;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.Text;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.joml.Vector3f;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class WandPreview extends ElementHolder {
    enum Layer {
        BUILD("建筑", Blocks.LIGHT_BLUE_STAINED_GLASS.getDefaultState()),
        CLEAR("将挖掉", Blocks.ORANGE_STAINED_GLASS.getDefaultState()),
        FILL("将填平", Blocks.LIME_STAINED_GLASS.getDefaultState()),
        PROTECTED("受保护", Blocks.YELLOW_STAINED_GLASS.getDefaultState()),
        CONFLICT("冲突", Blocks.RED_STAINED_GLASS.getDefaultState());

        final String label;
        final BlockState marker;

        Layer(String label, BlockState marker) {
            this.label = label;
            this.marker = marker;
        }
    }

    private record Marker(BlockState actual, Layer layer) {}
    private static final int FULL_DISPLAY_UNTIL = 96;
    private static final int MAX_EDGE_ENTITIES = 384;
    private static final float EDGE_WIDTH = 0.045f;

    private WandPreview(Vec3d origin) {
        this.currentPos = origin;
    }

    static WandPreview show(ServerPlayerEntity owner, PlanCompiler.Result result, EnumSet<Layer> enabled) {
        Vec3d origin = Vec3d.of(owner.getBlockPos());
        WandPreview view = new WandPreview(origin);
        Map<BlockPos, Marker> markers = new LinkedHashMap<>();
        for (var op : result.ops()) {
            Layer layer = operationLayer(op.kind());
            if (enabled.contains(layer) && !op.phase().equals("remove_scaffold")) {
                BlockState state = layer == Layer.BUILD && !TerrainRules.id(op.target()).equals("water")
                    ? op.target() : layer.marker;
                markers.put(op.pos(), new Marker(state, layer));
            }
        }
        if (enabled.contains(Layer.PROTECTED)) {
            result.protectedCells().forEach(pos -> markers.put(pos, new Marker(Layer.PROTECTED.marker, Layer.PROTECTED)));
        }
        if (enabled.contains(Layer.CONFLICT)) {
            result.conflicts().forEach(conflict -> markers.put(conflict.pos(), new Marker(Layer.CONFLICT.marker, Layer.CONFLICT)));
        }

        view.drawMarkers(markers);

        if (result.door() != null && enabled.contains(Layer.BUILD)) {
            TextDisplayElement door = new TextDisplayElement();
            door.setBillboardMode(DisplayEntity.BillboardMode.CENTER);
            door.setText(Text.literal("入口 " + result.doorFacing().asString().toUpperCase(java.util.Locale.ROOT)));
            door.setShadow(true);
            Vec3d at = Vec3d.ofBottomCenter(result.door()).add(result.doorFacing().getOffsetX() * 0.7, 1.15,
                result.doorFacing().getOffsetZ() * 0.7);
            view.addAt(door, at);
        }
        view.showTo(owner);
        return view;
    }

    static WandPreview showComparison(ServerPlayerEntity owner, JsonObject comparison) {
        var view = new WandPreview(Vec3d.of(owner.getBlockPos()));
        var diff = comparison.getAsJsonObject("diff");
        // Different offsets keep categories visible when one cell has both a new and an unchanged operation.
        view.addDiff(diff.getAsJsonArray("added"), Blocks.LIME_STAINED_GLASS.getDefaultState(), 0.04f, 144);
        view.addDiff(diff.getAsJsonArray("removed"), Blocks.MAGENTA_STAINED_GLASS.getDefaultState(), 0.36f, 96);
        view.addDiff(diff.getAsJsonArray("unchanged"), Blocks.LIGHT_BLUE_STAINED_GLASS.getDefaultState(), 0.68f, 96);
        var conflicts = comparison.getAsJsonObject("plan").getAsJsonArray("conflicts");
        for (int index = 0; index < Math.min(48, conflicts.size()); index++) {
            view.addGlow(position(conflicts.get(index).getAsJsonObject()), false);
        }
        view.showTo(owner);
        return view;
    }

    static WandPreview showProgress(ServerPlayerEntity owner, BlockPos blockage, boolean death, JsonArray remaining) {
        var view = new WandPreview(Vec3d.of(owner.getBlockPos()));
        Map<BlockPos, Marker> markers = new LinkedHashMap<>();
        for (var entry : remaining) {
            var op = entry.getAsJsonObject();
            Layer layer = operationLayer(op.get("kind").getAsString());
            var pos = position(op);
            if (!pos.equals(blockage)) markers.putIfAbsent(pos, new Marker(layer.marker, layer));
        }
        view.drawMarkers(markers);
        if (blockage != null) view.addGlow(blockage, death);
        view.showTo(owner);
        return view;
    }

    static BlockPos position(JsonObject entry) {
        var pos = entry.getAsJsonObject("pos");
        return new BlockPos(pos.get("x").getAsInt(), pos.get("y").getAsInt(), pos.get("z").getAsInt());
    }

    private static Layer operationLayer(String kind) {
        return switch (kind) {
            case "build", "furnish" -> Layer.BUILD;
            case "fill", "scaffold" -> Layer.FILL;
            default -> Layer.CLEAR;
        };
    }

    private void showTo(ServerPlayerEntity owner) {
        // Manual tracking sends entity packets only to the authorized viewer.
        Vec3d origin = getPos();
        new ManualAttachment(this, owner.getWorld(), () -> origin).startWatching(owner);
    }

    private void addDiff(JsonArray operations, BlockState color, float x, int limit) {
        var positions = operations.asList().stream().map(op -> position(op.getAsJsonObject())).distinct().toList();
        int count = Math.min(limit, positions.size());
        for (int index = 0; index < count; index++) {
            addDisplay(positions.get(index * positions.size() / count), color, x, 0.06f, 0.06f, 0.28f, 0.88f, 0.88f);
        }
    }

    private void addGlow(BlockPos pos, boolean death) {
        var marker = new BlockDisplayElement((death ? Blocks.PURPLE_STAINED_GLASS : Blocks.RED_STAINED_GLASS).getDefaultState());
        marker.setTranslation(new Vector3f(-0.014f, -0.014f, -0.014f));
        marker.setScale(new Vector3f(1.028f, 1.028f, 1.028f));
        marker.setGlowing(true);
        marker.setGlowColorOverride(death ? 0xB460FF : 0xFF3030);
        marker.setBrightness(new Brightness(15, 15));
        addAt(marker, Vec3d.of(pos));
    }

    private void drawMarkers(Map<BlockPos, Marker> markers) {
        if (markers.size() <= FULL_DISPLAY_UNTIL) {
            markers.forEach((pos, marker) -> {
                float inset = marker.layer() == Layer.BUILD || marker.layer() == Layer.FILL ? 0.02f : -0.012f;
                float size = 1 - 2 * inset;
                addDisplay(pos, marker.actual(), inset, inset, inset, size, size, size);
            });
            return;
        }
        List<Map.Entry<BlockPos, Marker>> boundaries = new ArrayList<>();
        markers.entrySet().stream().filter(entry -> entry.getValue().layer() == Layer.CONFLICT).forEach(boundaries::add);
        markers.entrySet().stream().filter(entry -> entry.getValue().layer() != Layer.CONFLICT)
            .filter(entry -> !enclosed(markers, entry.getKey())).forEach(boundaries::add);
        int count = Math.min(MAX_EDGE_ENTITIES / 12, boundaries.size());
        for (int index = 0; index < count; index++) {
            var entry = boundaries.get(index * boundaries.size() / count);
            addOutline(entry.getKey(), entry.getValue().layer().marker);
        }
    }

    private static boolean enclosed(Map<BlockPos, Marker> markers, BlockPos pos) {
        for (Direction direction : Direction.values()) {
            if (!markers.containsKey(pos.offset(direction))) {
                return false;
            }
        }
        return true;
    }

    private void addOutline(BlockPos pos, BlockState state) {
        for (int a = 0; a <= 1; a++) {
            for (int b = 0; b <= 1; b++) {
                float low = a - EDGE_WIDTH / 2, high = b - EDGE_WIDTH / 2;
                addDisplay(pos, state, -EDGE_WIDTH / 2, low, high, 1 + EDGE_WIDTH, EDGE_WIDTH, EDGE_WIDTH);
                addDisplay(pos, state, low, -EDGE_WIDTH / 2, high, EDGE_WIDTH, 1 + EDGE_WIDTH, EDGE_WIDTH);
                addDisplay(pos, state, low, high, -EDGE_WIDTH / 2, EDGE_WIDTH, EDGE_WIDTH, 1 + EDGE_WIDTH);
            }
        }
    }

    private void addDisplay(BlockPos pos, BlockState state, float x, float y, float z, float sx, float sy, float sz) {
        BlockDisplayElement marker = new BlockDisplayElement(state);
        marker.setTranslation(new Vector3f(x, y, z));
        marker.setScale(new Vector3f(sx, sy, sz));
        addAt(marker, Vec3d.of(pos));
    }

    private void addAt(AbstractElement element, Vec3d at) {
        element.setOffset(at.subtract(getPos()));
        addElementWithoutUpdates(element);
    }
}
