package dev.deskpet.minecraft;

import dev.deskpet.minecraft.wand.WandInteractions;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.text.Text;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.util.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class DeskPetMod implements ModInitializer {
    public static final Logger LOGGER = LoggerFactory.getLogger("deskpet");

    public static Identifier id(String path) {
        return Identifier.of("deskpet", path);
    }

    @Override
    public void onInitialize() {
        var key = RegistryKey.of(RegistryKeys.ITEM, id("survey_wand"));
        var settings = new Item.Settings().registryKey(key).maxCount(1)
            .component(DataComponentTypes.CUSTOM_NAME, Text.literal("标注法杖"));
        boolean rawTestItem = DeskPetMod.class.getResource("/deskpet-raw-survey-wand") != null;
        Registry.register(Registries.ITEM, key, rawTestItem ? new Item(settings) : new SurveyWand(settings));
        if (rawTestItem) LOGGER.warn("Test control enabled: survey wand has no Polymer replacement");
        PlanChannel.register(FabricLoader.getInstance().getModContainer("deskpet").orElseThrow()
            .getMetadata().getVersion().getFriendlyString());
        SnapshotCommand.register();
        if (!rawTestItem) WandInteractions.register();
    }
}
