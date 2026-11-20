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
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.TreeSet;
import java.util.UUID;

final class WandMenu extends SimpleGui {
    private static final int MATERIALS_PAGE_SIZE = 5;
    private final WandInteractions.Selection selection;
    private int materialsPage;
    private int ticks;
    private WandInteractions.Progress lastStatus;
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
        var server = selection.world.getServer();
        server.execute(() -> {
            if (selection.menu == this) {
                selection.clearDisplay();
            }
        });
    }

    @Override
    public void onTick() {
        if (++ticks % 20 == 0) {
            if (selection.isManagement()) {
                if (selection.comparison != null) {
                    if (!expired && isExpired(selection.comparisonPlan())) render();
                } else if (!selection.historyPage && !Objects.equals(selection.progress(), lastStatus)) {
                    render();
                }
            } else if (selection.result != null && !expired && isExpired(selection.result.plan())) {
                render();
            }
        }
    }

    private void render() {
        if (selection.isManagement()) {
            for (int slot = 0; slot < 54; slot++) clearSlot(slot);
            if (selection.historyPage) {
                renderHistory();
                title("施工历史");
            } else if (selection.comparison != null) {
                renderComparison();
                title("重新比对");
            } else {
                renderStatus();
                title("施工中");
            }
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

        expired = isExpired(result.plan());
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
        var auth = WandInteractions.authorization();
        if (auth.isOwner(selection.owner)) {
            item(47, Items.CLOCK, "施工中", List.of(), () -> {
                selection.showManagement(auth.active(selection.owner));
                render();
            });
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
        UUID id = selection.managing;
        var auth = WandInteractions.authorization();
        lastStatus = selection.progress();
        if (isOpen()) selection.showProgress(lastStatus);
        item(4, Items.CLOCK, "施工状态", lastStatus == null ? List.of(Text.literal("当前没有施工计划")) : lore(lastStatus.lines()), null);
        String status = lastStatus == null ? "" : lastStatus.status();
        boolean working = status.equals("confirmed") || status.equals("running");
        boolean paused = status.equals("paused");
        control(46, Items.YELLOW_CONCRETE, "暂停", working, () -> action(auth.pause(selection.owner, id)));
        control(47, Items.LIME_CONCRETE, "继续", paused, () -> action(auth.resume(selection.owner, id)));
        control(48, Items.SPYGLASS, "重新比对", paused, this::recompare);
        control(49, Items.GLASS, "显示剩余工作 · " + (selection.showRemaining ? "开" : "关"), working || paused, () -> {
            selection.showRemaining = !selection.showRemaining;
            render();
        });
        item(51, Items.WRITABLE_BOOK, "历史记录", List.of(), () -> {
            selection.historyPage = true;
            selection.clearDisplay();
            render();
        });
        control(53, Items.RED_CONCRETE, "取消施工", working || paused, () -> {
            String message = auth.cancel(selection.owner, id);
            if (id.equals(auth.active(selection.owner))) {
                action(message);
            } else {
                WandInteractions.message(selection.owner, message);
                selection.invalidate();
                selection.close();
            }
        });
    }

    private void renderHistory() {
        var entries = WandInteractions.authorization().history(selection.owner);
        item(4, Items.WRITABLE_BOOK, "历史记录", List.of(Text.literal(entries.isEmpty() ? "暂无记录" : "最近 " + entries.size() + " 份已结束计划")), null);
        for (int index = 0; index < entries.size(); index++) {
            var entry = entries.get(index);
            item(9 + index, Items.PAPER, entry.title(), lore(entry.lines()), null);
        }
        item(53, Items.ARROW, "返回施工状态", List.of(), () -> {
            selection.historyPage = false;
            render();
        });
    }

    private void renderComparison() {
        var plan = selection.comparisonPlan();
        var diff = selection.comparison.getAsJsonObject("diff");
        int added = diff.getAsJsonArray("added").size();
        int removed = diff.getAsJsonArray("removed").size();
        int unchanged = diff.getAsJsonArray("unchanged").size();
        item(4, Items.MAP, "重新比对 · 版本 " + plan.get("revision").getAsInt(),
            List.of(Text.literal("新增 " + added + " · 取消 " + removed + " · 不变 " + unchanged)), null);
        item(10, Items.LIME_STAINED_GLASS, "新增 · " + added, List.of(Text.literal("确认后授权这些操作")), null);
        item(11, Items.MAGENTA_STAINED_GLASS, "取消 · " + removed, List.of(), null);
        item(12, Items.LIGHT_BLUE_STAINED_GLASS, "不变 · " + unchanged, List.of(), null);
        renderMaterials(plan.getAsJsonObject("materials"));
        expired = isExpired(plan);
        var conflicts = plan.getAsJsonArray("conflicts");
        if (expired) {
            item(45, Items.BARRIER, "预览已过期", List.of(Text.literal("请重新比对")), null);
        } else if (!conflicts.isEmpty()) {
            var lines = conflicts.asList().stream().limit(12).map(conflict -> {
                var data = conflict.getAsJsonObject();
                var kind = PlanCompiler.ConflictKind.valueOf(data.get("kind").getAsString().toUpperCase(Locale.ROOT));
                return kind.label + " " + WandInteractions.label(WandPreview.position(data));
            }).toList();
            item(45, Items.BARRIER, "有冲突，不能确认", lore(lines), null);
        } else {
            item(45, Items.EMERALD_BLOCK, "确认新版", List.of(), this::confirmComparison);
        }
        item(49, Items.SPYGLASS, "重新比对", List.of(), this::recompare);
        item(53, Items.ARROW, "返回施工状态", List.of(), () -> {
            selection.showManagement(selection.managing);
            render();
        });
    }

    private void recompare() {
        var result = WandInteractions.authorization().recompare(selection.owner, selection.managing);
        if (result.has("error")) {
            action(result.get("error").getAsString());
            return;
        }
        if (!result.has("plan")) return;
        selection.comparison = result;
        materialsPage = 0;
        selection.refreshDisplay();
        render();
    }

    private void confirmComparison() {
        UUID token = UUID.fromString(selection.comparison.get("previewId").getAsString());
        int version = selection.comparisonPlan().get("revision").getAsInt();
        var message = WandInteractions.authorization().confirm(selection.owner, token);
        var status = selection.progress();
        if (status != null && status.revision() == version && !status.status().equals("paused")) {
            selection.showManagement(selection.managing);
        }
        action(message);
    }

    private void confirm() {
        UUID id = UUID.fromString(selection.result.plan().get("planId").getAsString());
        var auth = WandInteractions.authorization();
        var message = auth.confirm(selection.owner, id);
        if (id.equals(auth.active(selection.owner))) {
            selection.showManagement(id);
        }
        action(message);
    }

    private void action(String message) {
        WandInteractions.message(selection.owner, message);
        render();
    }

    void refresh() {
        render();
        if (!selection.isManagement() || selection.comparison != null) selection.refreshDisplay();
    }

    private void title(String label) {
        if (!getTitle().getString().equals(label)) setTitle(Text.literal(label));
    }

    private boolean isExpired(JsonObject plan) {
        return plan.get("expiresAt").getAsLong() <= System.currentTimeMillis();
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

    private static List<Text> lore(List<String> lines) {
        return lines.stream().map(Text::literal).map(Text.class::cast).toList();
    }

    private void control(int slot, Item icon, String caption, boolean enabled, Runnable action) {
        item(slot, enabled ? icon : Items.BARRIER, caption, enabled ? List.of() : List.of(Text.literal("当前状态不可用")),
            enabled ? action : null);
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
