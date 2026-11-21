import { setTimeout as delay } from 'node:timers/promises';
import type { DoctorRepair, DoctorRepairId } from '../../shared/doctor';
import type { QqChannelService } from '../channels/qq/qq-channel-service';
import type { TelegramChannelService } from '../channels/telegram/telegram-channel-service';
import type { WeChatChannel } from '../channels/wechat/wechat-channel';
import type { SpeechInputService } from '../voice/speech-input-service';
import type { VoiceService } from '../voice/voice-service';
import type { VaultKnowledgeService } from '../knowledge/vault-index';
import type { MinecraftDedicatedServer } from '../minecraft/dedicated-server';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const DOCTOR_REPAIR_RULES: Record<DoctorRepairId, { codes: readonly string[]; interval: number }> = {
  wechat: { codes: ['wechat.stopped', 'wechat.stale', 'wechat.degraded'], interval: HOUR_MS },
  qq: { codes: ['qq.offline'], interval: HOUR_MS },
  telegram: { codes: ['telegram.offline'], interval: HOUR_MS },
  asr: { codes: ['asr.worker'], interval: HOUR_MS },
  knowledge: { codes: ['knowledge.indexRepeatedFailures'], interval: HOUR_MS },
  minecraft: { codes: ['minecraft.gaveUp'], interval: 2 * HOUR_MS },
};

interface RepairAttempt {
  observed?(): boolean;
  eligible(): boolean | Promise<boolean>;
  /** Skipped if the service was paused, became healthy, or access changed before the action. */
  run(allowed: () => boolean): Promise<'skipped' | 'failed' | 'recovered'>;
}

export type DoctorRepairActions = Partial<Record<DoctorRepairId, RepairAttempt>>;

export const canAttemptRepair = (id: DoctorRepairId, history: readonly DoctorRepair[], at: number): boolean => {
  const previous = history.filter(entry => entry.id === id);
  const last = previous.at(-1);
  return (!last || (at - Date.parse(last.at) >= DOCTOR_REPAIR_RULES[id].interval &&
    (!last.circuitUntil || Date.parse(last.circuitUntil) <= at)))
    && previous.filter(entry => at - Date.parse(entry.at) < DAY_MS).length < 3;
};

export function finishRepair(history: readonly DoctorRepair[], attempt: DoctorRepair, result: 'failed' | 'recovered',
  at: Date, heldForMorning: boolean): DoctorRepair {
  const previous = history.filter(entry => entry.id === attempt.id && entry.at !== attempt.at).at(-1);
  const consecutiveFailure = previous?.result === 'failed' && previous.circuitUntil === null;
  return { ...attempt, result, finishedAt: at.toISOString(), heldForMorning,
    circuitUntil: result === 'failed' && consecutiveFailure ? new Date(at.getTime() + DAY_MS).toISOString() : null };
}

const reconnect = async (start: () => Promise<boolean> | boolean, verified: () => boolean, allowed: () => boolean) => {
  if (!allowed() || !await start()) return 'skipped';
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (verified()) return 'recovered';
    if (!allowed()) break;
    await delay(500);
  }
  return 'failed';
};

export function doctorRepairActions(services: {
  wechat(): WeChatChannel | undefined;
  qq: QqChannelService;
  telegram: TelegramChannelService;
  speech: SpeechInputService;
  voice: VoiceService;
  knowledge: VaultKnowledgeService;
  minecraft: MinecraftDedicatedServer;
}): DoctorRepairActions {
  const { wechat, qq, telegram, speech, voice, knowledge, minecraft } = services;
  const voiceIdle = () => !['speaking', 'loading'].includes(voice.status().state);
  const canIndex = () => {
    const status = knowledge.status();
    return status.vaultName !== null && status.autoIndex && !status.indexing &&
      status.embeddingStatus !== 'missing' && status.consecutiveIndexFailures >= 2;
  };
  return {
    wechat: {
      eligible: () => wechat()?.canRestartListener() ?? false,
      run: async allowed => wechat()?.restartListener(allowed) ?? 'skipped',
    },
    qq: {
      eligible: () => qq.canReconnect(),
      run: allowed => reconnect(() => qq.reconnect(allowed), () => qq.status().connection === 'online', allowed),
    },
    telegram: {
      eligible: () => telegram.canReconnect(),
      run: allowed => reconnect(() => telegram.reconnect(), () => telegram.status().connection === 'online', allowed),
    },
    asr: {
      eligible: () => voiceIdle() && speech.canRestartWorker(),
      run: allowed => speech.restartWorker(() => allowed() && voiceIdle()),
    },
    knowledge: {
      eligible: canIndex,
      run: async allowed => {
        if (!allowed() || !canIndex()) return 'skipped';
        const status = await knowledge.reindex();
        return status.vaultName !== null && status.lastIndexedAt && !status.lastError && !status.consecutiveIndexFailures ? 'recovered' : 'failed';
      },
    },
    minecraft: {
      observed: () => minecraft.getState().status === 'gave_up',
      eligible: () => minecraft.getState().status === 'gave_up',
      run: allowed => minecraft.restartAfterGiveUp(allowed),
    },
  };
}
