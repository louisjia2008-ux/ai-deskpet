import { randomUUID } from 'node:crypto';
import type { QqAuthority, QqBinding, QqOutboxItem } from '../../../shared/qq-channel';
import { isProactiveQuiet, proactiveDayKey, proactiveMinuteOfDay } from '../../domain/proactive-policy';
import type { QqChannelStore } from './qq-channel-store';

export interface QqCarePolicy {
  timezone: string;
  quietStart: string;
  quietEnd: string;
  cooldownMinutes: number;
  dailyLimit: number;
  revision: number;
  permissionRevision: number;
  locale: 'zh-CN' | 'en';
}

const copy = {
  'zh-CN': {
    morning: '早呀。今天有什么想慢慢完成的小事吗？',
    afternoon: '下午好，要不要伸个懒腰，喝口水？',
    evening: '晚上好。今天有什么事想和我聊聊吗？',
    manual: '我在呢。想聊聊天，或者要我帮你记点什么吗？',
  },
  en: {
    morning: 'Good morning. Is there anything you’d like to make time for today?',
    afternoon: 'Good afternoon. How about a stretch and a glass of water?',
    evening: 'Good evening. Anything on your mind that you’d like to talk about?',
    manual: 'I’m here. Want to chat or ask me to remember something?',
  },
} as const;
type Slot = Exclude<keyof typeof copy.en, 'manual'>;
function slotNow(time: number, timezone: string): Slot | null {
  const minute = proactiveMinuteOfDay(time, timezone);
  if (minute >= 9 * 60 && minute < 9 * 60 + 15) return 'morning';
  if (minute >= 15 * 60 && minute < 15 * 60 + 15) return 'afternoon';
  if (minute >= 20 * 60 && minute < 20 * 60 + 15) return 'evening';
  return null;
}

interface Dependencies {
  store: QqChannelStore;
  policy(): QqCarePolicy | null;
  authority(): QqAuthority;
  online(): boolean;
  now(): Date;
  flush(): Promise<void>;
}

interface Reservation {
  grantId: string;
  epoch: number;
  slot: Slot | null;
  day: string;
  started: number;
  policy: QqCarePolicy;
}

/** Only the current process can send a freshly reserved greeting. The durable
 * counters suppress duplicate windows across crashes, restarts and DST changes.
 * Its inputs contain no conversation, event, memory, task or model output. */
export class QqPrivateCare {
  readonly #reservations = new Map<string, Reservation>();
  #epoch = 0;
  #changes = 0;
  constructor(private readonly deps: Dependencies) {}

  async setEnabled(expectedBindingId: string, enabled: boolean): Promise<void> {
    this.#epoch++;
    this.#changes++;
    try {
      await this.deps.store.update(draft => {
        const authority = this.deps.authority();
        const binding = draft.binding;
        if (!binding || binding.id !== expectedBindingId || binding.id !== authority.bindingId) throw new Error('qq.authorityRevoked');
        if (enabled) binding.privateCareGrant ??= { id: randomUUID(), authorityId: authority.authorityId };
        else delete binding.privateCareGrant;
      });
    } finally { this.#changes--; }
  }

  #authorizedPolicy(): QqCarePolicy {
    const policy = this.deps.policy();
    if (!this.deps.online()) throw new Error('qq.careOffline');
    if (!policy || this.#changes) throw new Error('qq.careUnavailable');
    if (isProactiveQuiet(policy, this.deps.now().getTime())) throw new Error('qq.careQuiet');
    return policy;
  }

  #grant(binding: QqBinding | null, authority: QqAuthority) {
    const grant = binding?.privateCareGrant;
    if (!binding || !grant || binding.id !== authority.bindingId || grant.authorityId !== authority.authorityId) throw new Error('qq.authorityRevoked');
    return grant;
  }

  async offer(expectedBindingId?: string): Promise<void> {
    const manual = expectedBindingId !== undefined;
    if (!this.deps.store.privateCareGranted || this.#changes) {
      if (manual) throw new Error('qq.careUnavailable');
      return;
    }
    if (!this.deps.online() && !manual) return;
    const policy = this.#authorizedPolicy();
    const time = this.deps.now().getTime();
    const slot = slotNow(time, policy.timezone);
    if (!slot && !manual) return;
    const before = this.deps.store.snapshot();
    if (!before.binding) throw new Error('qq.authorityRevoked');
    const authority = this.deps.authority();
    const grant = this.#grant(before.binding, authority);
    if (manual && authority.bindingId !== expectedBindingId) throw new Error('qq.authorityRevoked');
    const day = proactiveDayKey(time, policy.timezone);
    const id = randomUUID(), reservation: Reservation = { grantId: grant.id, epoch: this.#epoch, slot, day, started: time, policy };
    const createdAt = new Date(time).toISOString();
    const content = copy[policy.locale][slot ?? 'manual'];
    const item: QqOutboxItem = { id, authority, kind: 'care', content, replyTo: null, runId: null, assistantMessageId: null,
      status: 'pending', attempts: 0, createdAt, lastAttemptAt: null, errorCode: null };
    const eligible = (binding: QqBinding): boolean => {
      const usage = binding.privateCareUsage;
      if (!usage) return true;
      if (time < Date.parse(usage.lastAt) + policy.cooldownMinutes * 60_000) return false;
      return usage.day !== day || (usage.count < policy.dailyLimit && (!slot || !usage.slots.includes(slot)));
    };
    if (!eligible(before.binding)) {
      if (manual) throw new Error('qq.careFrequency');
      return;
    }
    this.#reservations.set(id, reservation);
    try {
      const reserved = await this.deps.store.update(draft => {
        this.assertDelivery(item);
        if (!draft.binding) throw new Error('qq.authorityRevoked');
        if (!eligible(draft.binding)) return false;
        if (draft.outbox.length >= 200) {
          const index = draft.outbox.findIndex(row => row.status === 'sent' || row.status === 'discarded');
          if (index < 0) throw new Error('qq.outboxFull');
          draft.outbox.splice(index, 1);
        }
        const previous = draft.binding.privateCareUsage;
        const sameDay = previous?.day === day;
        draft.binding.privateCareUsage = { day, lastAt: createdAt, count: (sameDay ? previous.count : 0) + 1,
          slots: [...(sameDay ? previous.slots : []), ...(slot ? [slot] : [])] };
        draft.outbox.push(item);
        return true;
      });
      if (!reserved) {
        if (manual) throw new Error('qq.careFrequency');
        return;
      }
      await this.deps.flush();
      if (manual) {
        const status = this.deps.store.snapshot().outbox.find(row => row.id === id)?.status;
        if (status === 'unknown') throw new Error('qq.careUnknown');
        if (status !== 'sent') throw new Error('qq.careNotDelivered');
      }
    } finally { this.#reservations.delete(id); }
  }

  assertDelivery(item: QqOutboxItem): void {
    const lease = this.#reservations.get(item.id);
    if (!lease || lease.epoch !== this.#epoch || item.kind !== 'care' || item.replyTo !== null) throw new Error('qq.authorityRevoked');
    const policy = this.#authorizedPolicy(), authority = this.deps.authority(), time = this.deps.now().getTime();
    const grant = this.#grant(this.deps.store.snapshot().binding, authority);
    if (grant.id !== lease.grantId || authority.bindingId !== item.authority.bindingId || authority.senderId !== item.authority.senderId ||
      policy.revision !== lease.policy.revision || policy.permissionRevision !== lease.policy.permissionRevision ||
      time < lease.started || time - lease.started > 90_000 || proactiveDayKey(time, policy.timezone) !== lease.day ||
      (lease.slot !== null && slotNow(time, policy.timezone) !== lease.slot) || item.content !== copy[lease.policy.locale][lease.slot ?? 'manual']) {
      throw new Error('qq.careUnavailable');
    }
  }
}
