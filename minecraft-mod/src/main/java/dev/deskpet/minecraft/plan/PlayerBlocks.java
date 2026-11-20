package dev.deskpet.minecraft.plan;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.serialization.Codec;
import com.mojang.serialization.codecs.RecordCodecBuilder;
import dev.deskpet.minecraft.DeskPetMod;
import dev.deskpet.minecraft.PlanChannel;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.ChunkPos;
import net.minecraft.world.PersistentState;
import net.minecraft.world.PersistentStateType;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class PlayerBlocks extends PersistentState {
    private static final int MAX_CHUNKS = 8192;
    private static final int MAX_PER_CHUNK = 2048;
    private static final int MAX_CELLS = 262_144;
    private static final int SYNC_RADIUS = 3;
    private static final Codec<Map<Long, List<Integer>>> CHUNKS =
        Codec.unboundedMap(Codec.STRING.xmap(Long::parseLong, String::valueOf), Codec.INT.listOf());
    private static final Codec<PlayerBlocks> CODEC = RecordCodecBuilder.create(instance -> instance.group(
        CHUNKS.fieldOf("chunks").forGetter(PlayerBlocks::encode),
        Codec.BOOL.fieldOf("overflow").forGetter(store -> store.overflow)
    ).apply(instance, PlayerBlocks::new));
    private static final PersistentStateType<PlayerBlocks> TYPE =
        new PersistentStateType<>("deskpet_player_blocks", () -> new PlayerBlocks(Map.of(), false), CODEC, null);

    private final Map<Long, Set<Integer>> chunks = new HashMap<>();
    private boolean overflow;
    private int size;
    private long revision;
    private long nextWarning = System.nanoTime();

    private PlayerBlocks(Map<Long, List<Integer>> saved, boolean overflow) {
        saved.forEach((chunk, cells) -> chunks.put(chunk, new HashSet<>(cells)));
        size = chunks.values().stream().mapToInt(Set::size).sum();
        this.overflow = overflow;
    }

    private Map<Long, List<Integer>> encode() {
        var result = new HashMap<Long, List<Integer>>();
        chunks.forEach((chunk, cells) -> result.put(chunk, List.copyOf(cells)));
        return result;
    }

    public static PlayerBlocks get(ServerWorld world) {
        return world.getPersistentStateManager().getOrCreate(TYPE);
    }

    private static int cell(BlockPos pos) {
        return pos.getY() * 256 + (pos.getZ() & 15) * 16 + (pos.getX() & 15);
    }

    public void add(BlockPos pos) {
        if (overflow) return;
        long chunk = new ChunkPos(pos).toLong();
        var cells = chunks.get(chunk);
        if (cells != null && cells.contains(cell(pos))) return;
        if (size >= MAX_CELLS || (cells == null && chunks.size() >= MAX_CHUNKS)
            || (cells != null && cells.size() >= MAX_PER_CHUNK)) {
            overflow = true;
            changed();
            DeskPetMod.LOGGER.warn("Player block protection capacity reached; automatic block destruction is disabled in this dimension");
        } else {
            chunks.computeIfAbsent(chunk, ignored -> new HashSet<>()).add(cell(pos));
            size++;
            changed();
        }
    }

    public void remove(BlockPos pos) {
        long chunk = new ChunkPos(pos).toLong();
        var cells = chunks.get(chunk);
        if (cells != null && cells.remove(cell(pos))) {
            if (cells.isEmpty()) chunks.remove(chunk);
            size--;
            changed();
        }
    }

    private void changed() {
        revision++;
        markDirty();
    }

    public boolean contains(BlockPos pos) {
        var cells = chunks.get(new ChunkPos(pos).toLong());
        return overflow || (cells != null && cells.contains(cell(pos)));
    }

    public boolean deny(BlockPos pos, String action) {
        if (!contains(pos)) return false;
        long now = System.nanoTime();
        if (now - nextWarning >= 0) {
            DeskPetMod.LOGGER.info("Player block protection rejected {} at {}", action, pos.toShortString());
            nextWarning = now + 1_000_000_000L;
        }
        return true;
    }

    record Sync(ServerWorld world, ChunkPos center, long revision) {}

    Sync sync(ServerPlayerEntity player, Sync previous) {
        var world = player.getWorld();
        var center = player.getChunkPos();
        var current = new Sync(world, center, revision);
        if (current.equals(previous)) return previous;
        var message = new JsonObject();
        message.addProperty("dimension", world.getRegistryKey().getValue().toString());
        message.addProperty("type", "player_blocks_reset");
        message.addProperty("overflow", overflow);
        PlanChannel.send(player, message);
        if (overflow) return current;
        for (int x = center.x - SYNC_RADIUS; x <= center.x + SYNC_RADIUS; x++) {
            for (int z = center.z - SYNC_RADIUS; z <= center.z + SYNC_RADIUS; z++) {
                var cells = chunks.get(ChunkPos.toLong(x, z));
                if (cells == null) continue;
                var packet = new JsonObject();
                packet.addProperty("type", "player_blocks_chunk");
                packet.addProperty("dimension", world.getRegistryKey().getValue().toString());
                packet.addProperty("x", x);
                packet.addProperty("z", z);
                var encoded = new JsonArray();
                cells.forEach(encoded::add);
                packet.add("cells", encoded);
                PlanChannel.send(player, packet);
            }
        }
        return current;
    }
}
