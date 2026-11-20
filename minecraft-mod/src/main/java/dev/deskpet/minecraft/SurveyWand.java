package dev.deskpet.minecraft;

import dev.deskpet.minecraft.wand.WandInteractions;
import eu.pb4.polymer.core.api.item.SimplePolymerItem;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.item.ItemUsageContext;
import net.minecraft.util.ActionResult;
import net.minecraft.util.Hand;
import net.minecraft.util.Identifier;
import net.minecraft.world.World;
import xyz.nucleoid.packettweaker.PacketContext;

public final class SurveyWand extends SimplePolymerItem {
    public SurveyWand(Settings settings) {
        super(settings, Items.STICK);
    }

    @Override
    public Identifier getPolymerItemModel(ItemStack stack, PacketContext context) {
        return Identifier.ofVanilla("blaze_rod");
    }

    @Override
    public ActionResult useOnBlock(ItemUsageContext context) {
        return WandInteractions.useOnBlock(context);
    }

    @Override
    public ActionResult use(World world, PlayerEntity user, Hand hand) {
        return WandInteractions.use(world, user, hand);
    }
}
