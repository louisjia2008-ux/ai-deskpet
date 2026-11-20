package dev.deskpet.minecraft;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;
import java.util.function.BiConsumer;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.network.RegistryByteBuf;
import net.minecraft.network.codec.PacketCodec;
import net.minecraft.network.packet.CustomPayload;
import net.minecraft.server.network.ServerPlayerEntity;

public final class PlanChannel {
    public static final int PROTOCOL = 1;
    private static final int MAX_PACKET_BYTES = 32 * 1024;
    private static final Set<ServerPlayerEntity> READY = Collections.newSetFromMap(new IdentityHashMap<>());
    private static final List<BiConsumer<ServerPlayerEntity, JsonObject>> HANDLERS = new ArrayList<>();

    record Payload(String json) implements CustomPayload {
        private static final Id<Payload> ID = new Id<>(DeskPetMod.id("plan"));
        private static final PacketCodec<RegistryByteBuf, Payload> CODEC = PacketCodec.of(
            (payload, buffer) -> buffer.writeString(payload.json, MAX_PACKET_BYTES),
            buffer -> new Payload(buffer.readString(MAX_PACKET_BYTES))
        );

        @Override
        public Id<Payload> getId() {
            return ID;
        }
    }

    static void register(String version) {
        PayloadTypeRegistry.playS2C().register(Payload.ID, Payload.CODEC);
        PayloadTypeRegistry.playC2S().register(Payload.ID, Payload.CODEC);
        ServerPlayNetworking.registerGlobalReceiver(Payload.ID, (payload, context) -> {
            var player = context.player();
            if (payload.json.getBytes(StandardCharsets.UTF_8).length >= MAX_PACKET_BYTES) return;
            JsonObject message;
            try {
                message = JsonParser.parseString(payload.json).getAsJsonObject();
                if (!message.has("type") || !message.get("type").isJsonPrimitive()
                    || !message.getAsJsonPrimitive("type").isString()) return;
                if (message.get("type").getAsString().equals("hello_ack")) {
                    var worldId = WorldIdentity.get(context.server()).toString();
                    if (message.get("protocol").getAsInt() == PROTOCOL
                        && message.get("worldId").getAsString().equals(worldId) && READY.add(player)) {
                        send(player, handshake("hello_ok", worldId));
                        DeskPetMod.LOGGER.info("Plan channel acknowledged by {}", player.getGameProfile().getId());
                    }
                    return;
                }
            } catch (RuntimeException malformed) {
                return;
            }
            if (isReady(player)) {
                for (var handler : HANDLERS) handler.accept(player, message);
            }
        });
        ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> {
            var hello = handshake("hello", WorldIdentity.get(server).toString());
            hello.addProperty("modVersion", version);
            send(handler.player, hello);
        });
        ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> READY.remove(handler.player));
    }

    public static boolean isReady(ServerPlayerEntity player) {
        return READY.contains(player);
    }

    public static void onMessage(BiConsumer<ServerPlayerEntity, JsonObject> handler) {
        HANDLERS.add(handler);
    }

    public static void send(ServerPlayerEntity player, JsonObject message) {
        String json = message.toString();
        // The VarInt length prefix uses at most three bytes for this range.
        if (json.getBytes(StandardCharsets.UTF_8).length > MAX_PACKET_BYTES - 3) {
            throw new IllegalArgumentException("Plan payload exceeds the 32 KiB wire limit");
        }
        ServerPlayNetworking.send(player, new Payload(json));
    }

    private static JsonObject handshake(String type, String worldId) {
        var packet = new JsonObject();
        packet.addProperty("type", type);
        packet.addProperty("protocol", PROTOCOL);
        packet.addProperty("worldId", worldId);
        return packet;
    }
}
