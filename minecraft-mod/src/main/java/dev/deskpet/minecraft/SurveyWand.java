package dev.deskpet.minecraft;

import eu.pb4.polymer.core.api.item.SimplePolymerItem;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.util.Identifier;
import xyz.nucleoid.packettweaker.PacketContext;

public final class SurveyWand extends SimplePolymerItem {
    public SurveyWand(Settings settings) {
        super(settings, Items.STICK);
    }

    @Override
    public Identifier getPolymerItemModel(ItemStack stack, PacketContext context) {
        return Identifier.ofVanilla("blaze_rod");
    }
}
