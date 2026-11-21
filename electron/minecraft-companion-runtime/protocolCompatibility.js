/* global require, module, structuredClone */
'use strict';

const TARGET_VERSION = '1.21.8';
const bedWakeBots = new WeakSet();

function installMinecraftBedWakeCompatibility(bot) {
  if (!bot || bot.version !== TARGET_VERSION
    || bot.supportFeature?.('entityActionUsesStringMapper') !== true
    || typeof bot.wake !== 'function' || typeof bot._client?.write !== 'function') return false;
  if (bedWakeBots.has(bot)) return true;
  const originalWake = bot.wake;
  // Mineflayer 4.37.1's bed plugin still sends the legacy numeric action 2.
  // Vanilla 1.21.8 maps that value to stop_sprinting; its supported mapper
  // encodes leave_bed as 0. Preserve the plugin's actual sleep/wake listeners.
  bot.wake = async function compatibleWake() {
    if (this !== undefined && this !== bot) throw new Error('wake belongs to another bot');
    if (bot.version !== TARGET_VERSION
      || bot.supportFeature?.('entityActionUsesStringMapper') !== true) return originalWake.call(bot);
    if (!bot.isSleeping) throw new Error('already awake');
    bot._client.write('entity_action', {
      entityId: bot.entity.id, actionId: 'leave_bed', jumpBoost: 0,
    });
  };
  bedWakeBots.add(bot);
  return true;
}

function correctedEntityMetadataProtocol(version, protocol) {
  if (version !== TARGET_VERSION) return null;
  const fields = protocol?.types?.entityMetadataEntry?.[1]
    ?.find((field) => field.name === 'value')?.type?.[1]?.fields;
  const chicken = fields?.chicken_variant;
  // Match the installed minecraft-data 3.110.0 defect exactly. A future
  // corrected schema, or a caller's different encoding, needs no replacement.
  if (!Array.isArray(chicken) || chicken[0] !== 'registryEntryHolder'
    || chicken[1]?.baseName !== 'variantId'
    || chicken[1]?.otherwise?.name !== 'variantData'
    || chicken[1]?.otherwise?.type !== 'string') return null;
  const corrected = structuredClone(protocol);
  corrected.types.entityMetadataEntry[1].find((field) => field.name === 'value')
    .type[1].fields.chicken_variant = 'varint';
  return corrected;
}

function compileInboundProtocol(protocol, state) {
  // This is the same compiler setup as minecraft-protocol 1.66.2's official
  // serializer. Compile our owned copy: its customPackets merge mutates the
  // shared minecraft-data schema, and its cache does not key customPackets.
  const { ProtoDefCompiler } = require('protodef').Compiler;
  const compiler = new ProtoDefCompiler();
  compiler.addTypes(require('minecraft-protocol/src/datatypes/compiler-minecraft'));
  compiler.addProtocol(protocol, [state, 'toClient']);
  require('prismarine-nbt').addTypesToCompiler('big', compiler);
  return compiler.compileProtoDefSync();
}

function withMinecraftProtocolCompatibility(options) {
  if (options.version && options.version !== TARGET_VERSION) return options;
  const minecraftData = require('minecraft-data');
  if (options.version && !correctedEntityMetadataProtocol(options.version,
    minecraftData(options.version)?.protocol)) return options;
  const BaseClient = options.Client || require('minecraft-protocol').Client;
  // Client is the supported custom-client extension. setSerializer is an
  // internal hook in pinned minecraft-protocol 1.66.2; regression tests cover
  // its live parser replacement and negotiated full-version transitions.
  class CompatibleClient extends BaseClient {
    setSerializer(state) {
      super.setSerializer(state);
      if (this.isServer || state !== 'play') return;
      const corrected = correctedEntityMetadataProtocol(this.version,
        minecraftData(this.version)?.protocol);
      if (corrected) this.deserializer.proto = compileInboundProtocol(corrected, state);
    }
  }
  return { ...options, Client: CompatibleClient };
}

function flattenReason(value) {
  if (typeof value === 'string') {
    try { return flattenReason(JSON.parse(value)); } catch { return value.slice(0, 2000); }
  }
  if (Array.isArray(value)) return value.map(flattenReason).join('').slice(0, 2000);
  if (value && typeof value === 'object') {
    return [value.text || value.translate || '', ...(value.extra || []), ...(value.with || [])]
      .map(flattenReason).join(' ').trim().slice(0, 2000);
  }
  return '';
}

function supportsPlayerLoaded(bot) {
  // minecraft-data has no dedicated supportFeature for this acknowledgement.
  // Gate on the resolved version's actual PLAY packet map and empty payload,
  // so legacy clients never serialize an unknown packet or guess a version.
  const types = bot.registry?.protocol?.play?.toServer?.types;
  const payload = types?.packet_player_loaded;
  const packetFields = types?.packet?.[1];
  if (payload?.[0] !== 'container' || !Array.isArray(payload[1]) || payload[1].length !== 0
    || !Array.isArray(packetFields)) return false;
  const names = packetFields.find((field) => field.name === 'name')?.type?.[1]?.mappings;
  const parameters = packetFields.find((field) => field.name === 'params')?.type?.[1]?.fields;
  return Object.values(names || {}).includes('player_loaded') && parameters?.player_loaded === 'packet_player_loaded';
}

async function acknowledgePlayerLoaded(bot, isCurrent = () => true) {
  if (!supportsPlayerLoaded(bot)) return false;
  await bot.waitForChunksToLoad();
  if (!isCurrent()) return false;
  if (bot._client?.state !== 'play' || typeof bot._client.write !== 'function') {
    throw new Error('Minecraft 世界加载确认时连接已不可写');
  }
  bot._client.write('player_loaded', {});
  return true;
}

module.exports = { withMinecraftProtocolCompatibility, correctedEntityMetadataProtocol,
  installMinecraftBedWakeCompatibility, acknowledgePlayerLoaded, flattenReason };
