package dev.deskpet.minecraft;

import com.mojang.serialization.Codec;
import java.util.UUID;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.world.PersistentState;
import net.minecraft.world.PersistentStateType;

public final class WorldIdentity extends PersistentState {
    private static final Codec<WorldIdentity> CODEC = Codec.STRING.xmap(
        value -> new WorldIdentity(UUID.fromString(value)), state -> state.id.toString()
    ).fieldOf("world_id").codec();
    private static final PersistentStateType<WorldIdentity> TYPE = new PersistentStateType<>(
        "deskpet_world_identity", () -> new WorldIdentity(UUID.randomUUID()), CODEC, null
    );
    private final UUID id;

    private WorldIdentity(UUID id) {
        this.id = id;
    }

    public static UUID get(MinecraftServer server) {
        var state = server.getOverworld().getPersistentStateManager().getOrCreate(TYPE);
        state.markDirty();
        return state.id;
    }

    public static UUID get(ServerWorld world) {
        return get(world.getServer());
    }
}
