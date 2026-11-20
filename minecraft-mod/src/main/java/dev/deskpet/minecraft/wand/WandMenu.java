package dev.deskpet.minecraft.wand;

import com.google.gson.JsonObject;
import eu.pb4.sgui.api.elements.GuiElementBuilder;
import eu.pb4.sgui.api.gui.SimpleGui;
import net.minecraft.item.Item;
import net.minecraft.item.Items;
import net.minecraft.screen.ScreenHandlerType;
import net.minecraft.text.Text;
import net.minecraft.util.BlockRotation;
import net.minecraft.util.Formatting;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.TreeSet;
import java.util.UUID;

final class WandMenu extends SimpleGui {
    private static final int MATERIALS_PAGE_SIZE = 5;
    private final WandInteractions.Selection selection;
    private int materialsPage;
    private int ticks;
    private String lastStatus;
    private boolean expired;

    WandMenu(WandInteractions.Selection selection) {
        super(ScreenHandlerType.GENERIC_9X6, selection.owner, false);
        this.selection = selection;
        setTitle(Text.literal("标注法杖"));
        setLockPlayerInventory(true);
        render();
    }

    @Override
    public void onClose() {
        selection.clearDisplay();
    }

    @Override
    public void onTick() {
        if (++ticks % 20 == 0) {
            if (selection.managing != null) {
                String status = WandInteractions.authorization().status(selection.owner, selection.managing);
                if (!status.equals(lastStatus)) {
                    render();
                }
            } else if (selection.result != null && !expired && isExpired()) {
                render();
            }
        }
    }

    private void render() {
        if (selection.managing != null) {
            renderStatus();
            return;
        }
        PlanCompiler.Result result = selection.result;
        PlanCompiler.Settings settings = selection.settings;
        long cuts = result.ops().stream().filter(op -> op.kind().equals("cut") || op.kind().equals("clear")).count();
        long fills = result.ops().stream().filter(op -> op.kind().equals("fill")).count();
        var box = result.plan().getAsJsonObject("selection");
        String yRange = box.get("minY").getAsInt() + "–" + box.get("maxY").getAsInt();
        List<Text> summary = new ArrayList<>();
        summary.add(Text.literal("建筑 " + result.width() + "×" + result.length() + " · 高度 " + yRange));
        summary.add(Text.literal("地面 Y " + result.groundY() + " · 挖方 " + cuts + " · 填方 " + fills));
        if (selection.supplyChest != null) {
            summary.add(Text.literal("材料箱 " + WandInteractions.label(selection.supplyChest)));
        }
        if (result.door() != null) {
            summary.add(Text.literal("入口 " + WandInteractions.label(result.door()) + " " + result.doorFacing().asString()));
        }
        item(4, Items.MAP, "选区", summary, null);

        item(10, Items.OAK_PLANKS, "房型 · " + settings.house().label, List.of(), () ->
            recompile(new PlanCompiler.Settings(next(HouseTemplates.Type.values(), settings.house()), settings.rotation(),
                0, 0, settings.groundOffset(), settings.mode(), settings.fillDepth(), settings.clipTrees())));
        item(11, Items.COMPASS, "旋转 · " + settings.rotation().ordinal() * 90 + "°", List.of(), () ->
            recompile(new PlanCompiler.Settings(settings.house(), next(BlockRotation.values(), settings.rotation()),
                settings.shiftX(), settings.shiftZ(), settings.groundOffset(), settings.mode(), settings.fillDepth(), settings.clipTrees())));
        item(12, Items.ARROW, "向西平移", List.of(), () -> move(-1, 0));
        item(13, Items.ARROW, "向北平移", List.of(), () -> move(0, -1));
        item(14, Items.ARROW, "向南平移", List.of(), () -> move(0, 1));
        item(15, Items.ARROW, "向东平移", List.of(), () -> move(1, 0));
        item(19, Items.GRASS_BLOCK, "地面 -1", List.of(), () -> height(-1));
        item(20, Items.GRASS_BLOCK, "地面 +1", List.of(), () -> height(1));
        item(21, Items.IRON_SHOVEL, "模式 · " + settings.mode().label, List.of(), () ->
            recompile(new PlanCompiler.Settings(settings.house(), settings.rotation(), settings.shiftX(), settings.shiftZ(),
                settings.groundOffset(), next(PlanCompiler.Mode.values(), settings.mode()), settings.fillDepth(), settings.clipTrees())));
        item(22, Items.DIRT, "填坑上限 -1 · " + settings.fillDepth(), List.of(), () -> fill(-1));
        item(23, Items.DIRT, "填坑上限 +1 · " + settings.fillDepth(), List.of(), () -> fill(1));
        item(24, settings.clipTrees() ? Items.OAK_LEAVES : Items.OAK_LOG, "跨界树 · " +
            (settings.clipTrees() ? "只砍框内" : "判为冲突"),
            List.of(Text.literal("只砍框内时，接受框外树叶自然凋落")), () ->
                recompile(new PlanCompiler.Settings(settings.house(), settings.rotation(), settings.shiftX(), settings.shiftZ(),
                    settings.groundOffset(), settings.mode(), settings.fillDepth(), !settings.clipTrees())));

        for (WandPreview.Layer layer : WandPreview.Layer.values()) {
            item(28 + layer.ordinal(), layer.marker.getBlock().asItem(),
                layer.label + " · " + (selection.layers.contains(layer) ? "显示" : "隐藏"), List.of(), () -> {
                    if (!selection.layers.remove(layer)) {
                        selection.layers.add(layer);
                    }
                    selection.refreshDisplay();
                    render();
                });
        }
        renderMaterials(result.plan().getAsJsonObject("materials"));

        expired = isExpired();
        if (expired) {
            item(45, Items.BARRIER, "预览已过期", List.of(Text.literal("点击按钮重新预览")), null);
            item(49, Items.SPYGLASS, "重新预览", List.of(), () -> recompile(selection.settings));
        } else {
            clearSlot(49);
            if (!result.valid()) {
                List<Text> conflicts = result.conflicts().stream().limit(12)
                    .map(conflict -> Text.literal(conflict.kind().label + " " + WandInteractions.label(conflict.pos())))
                    .map(Text.class::cast).toList();
                item(45, Items.BARRIER, "有冲突，不能开工", conflicts, null);
            } else if (WandInteractions.authorization().enabled()) {
                item(45, Items.EMERALD_BLOCK, "确认开工", List.of(), this::confirm);
            } else {
                item(45, Items.BARRIER, "确认开工尚未启用", List.of(), null);
            }
        }
        item(51, Items.OAK_SIGN, "撤销上一个角", List.of(), selection::undo);
        item(53, Items.RED_CONCRETE, "取消", List.of(), () -> {
            selection.invalidate();
            selection.close();
        });
    }

    private void renderMaterials(JsonObject materials) {
        JsonObject required = materials.getAsJsonObject("required");
        JsonObject excavated = materials.getAsJsonObject("excavated");
        JsonObject available = materials.getAsJsonObject("available");
        JsonObject deficit = materials.getAsJsonObject("deficit");
        var names = new TreeSet<String>();
        names.addAll(required.keySet());
        names.addAll(excavated.keySet());
        names.addAll(available.keySet());
        var ordered = names.stream().toList();
        int pageCount = Math.max(1, (ordered.size() + MATERIALS_PAGE_SIZE - 1) / MATERIALS_PAGE_SIZE);
        materialsPage = Math.min(materialsPage, pageCount - 1);
        for (int slot = 0; slot < MATERIALS_PAGE_SIZE; slot++) {
            int index = materialsPage * MATERIALS_PAGE_SIZE + slot;
            if (index >= ordered.size()) {
                clearSlot(37 + slot);
                continue;
            }
            String name = ordered.get(index);
            item(37 + slot, count(deficit, name) > 0 ? Items.RED_DYE : Items.LIME_DYE, name,
                List.of(Text.literal("需要 " + count(required, name) + " · 挖方可得 " + count(excavated, name)),
                    Text.literal("材料箱已有 " + count(available, name) + " · 缺口 " + count(deficit, name))), null);
        }
        if (materialsPage > 0) {
            item(36, Items.ARROW, "材料表上一页", List.of(), () -> {
                materialsPage--;
                render();
            });
        } else {
            clearSlot(36);
        }
        if (materialsPage + 1 < pageCount) {
            item(42, Items.ARROW, "材料表下一页", List.of(), () -> {
                materialsPage++;
                render();
            });
        } else {
            clearSlot(42);
        }
    }

    private static int count(JsonObject counts, String key) {
        return counts.has(key) ? counts.getAsJsonPrimitive(key).getAsInt() : 0;
    }

    private void renderStatus() {
        for (int slot = 0; slot < 54; slot++) {
            clearSlot(slot);
        }
        UUID id = selection.managing;
        var auth = WandInteractions.authorization();
        lastStatus = auth.status(selection.owner, id);
        item(4, Items.CLOCK, "施工状态", Arrays.stream(lastStatus.split("\\R")).map(Text::literal)
            .map(Text.class::cast).toList(), null);
        item(46, Items.YELLOW_CONCRETE, "暂停", List.of(), () -> action(auth.pause(selection.owner, id)));
        item(47, Items.LIME_CONCRETE, "继续", List.of(), () -> action(auth.resume(selection.owner, id)));
        item(53, Items.RED_CONCRETE, "取消施工", List.of(), () -> {
            action(auth.cancel(selection.owner, id));
            if (!id.equals(auth.active(selection.owner))) {
                selection.invalidate();
                selection.close();
            }
        });
    }

    private void confirm() {
        UUID id = UUID.fromString(selection.result.plan().get("planId").getAsString());
        var auth = WandInteractions.authorization();
        action(auth.confirm(selection.owner, id));
        if (id.equals(auth.active(selection.owner))) {
            selection.managing = id;
            selection.clearDisplay();
            renderStatus();
        }
    }

    private void action(String message) {
        WandInteractions.message(selection.owner, message);
        render();
    }

    private boolean isExpired() {
        return selection.result.plan().get("expiresAt").getAsLong() <= System.currentTimeMillis();
    }

    private void recompile(PlanCompiler.Settings settings) {
        selection.settings = settings;
        selection.compile();
        selection.refreshDisplay();
        render();
    }

    private void move(int x, int z) {
        var settings = selection.settings;
        recompile(new PlanCompiler.Settings(settings.house(), settings.rotation(), settings.shiftX() + x,
            settings.shiftZ() + z, settings.groundOffset(), settings.mode(), settings.fillDepth(), settings.clipTrees()));
    }

    private void height(int adjustment) {
        var settings = selection.settings;
        int offset = settings.groundOffset() + adjustment;
        if (selection.result.groundY() + adjustment <= selection.world.getBottomY() ||
            selection.result.groundY() + adjustment > selection.world.getTopYInclusive()) {
            return;
        }
        recompile(new PlanCompiler.Settings(settings.house(), settings.rotation(), settings.shiftX(),
            settings.shiftZ(), offset, settings.mode(), settings.fillDepth(), settings.clipTrees()));
    }

    private void fill(int adjustment) {
        var settings = selection.settings;
        int fillDepth = Math.clamp(settings.fillDepth() + adjustment, 1, PlanCompiler.MAX_FILL_DEPTH);
        recompile(new PlanCompiler.Settings(settings.house(), settings.rotation(), settings.shiftX(), settings.shiftZ(),
            settings.groundOffset(), settings.mode(), fillDepth, settings.clipTrees()));
    }

    private static <E extends Enum<E>> E next(E[] values, E current) {
        return values[(current.ordinal() + 1) % values.length];
    }

    private void item(int slot, Item icon, String caption, List<Text> lore, Runnable action) {
        var builder = new GuiElementBuilder(icon)
            .setName(Text.literal(caption).styled(style -> style.withItalic(false)))
            .setLore(lore.stream().map(line -> line.copy().formatted(Formatting.GRAY)
                .styled(style -> style.withItalic(false))).map(Text.class::cast).toList());
        if (action != null) {
            builder.setCallback((index, type, click, gui) -> action.run());
        }
        setSlot(slot, builder.build());
    }
}
