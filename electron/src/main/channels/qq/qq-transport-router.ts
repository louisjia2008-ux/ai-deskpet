import type { QqResolvedReplyImage, QqSendControls, QqTransport, QqTransportCredentials } from './qq-channel-service';
import type { QqAdapterEvents, QqOfficialAdapter, QqSendResult } from './qq-official-adapter';
import type { QqOneBotAdapter } from './qq-onebot-adapter';
import type { QqGatewayEvent } from '../../../shared/qq-channel';

/** Exactly one transport is live, so a revoke always reaches whichever one ran. */
export class QqTransportRouter implements QqTransport {
  #active: QqOfficialAdapter | QqOneBotAdapter | null = null;

  constructor(private readonly official: QqOfficialAdapter, private readonly onebot: QqOneBotAdapter) {}

  get lastError(): string | null { return this.#active?.lastError ?? null; }
  get gatewayEvents(): QqGatewayEvent[] { return this.#active === this.official ? this.official.gatewayEvents : []; }

  async start(credentials: QqTransportCredentials, events: QqAdapterEvents): Promise<void> {
    this.stop();
    const { transport, appId, onebotUrl, secret } = credentials;
    if (transport === 'onebot') { this.#active = this.onebot; await this.onebot.start({ url: onebotUrl, token: secret }, events); }
    else { this.#active = this.official; await this.official.start({ appId, secret }, events); }
  }

  stop(): void { this.official.stop(); this.onebot.stop(); this.#active = null; }

  sendToUser(openId: string, content: string, replyTo?: string, controls?: QqSendControls): Promise<QqSendResult> {
    return this.#active === null ? Promise.resolve({ ok: false, unknown: false, error: 'qq.sendBlocked' })
      : this.#active.sendToUser(openId, content, replyTo, controls);
  }

  sendToGroup(groupId: string, content: string, replyTo?: string, controls?: QqSendControls): Promise<QqSendResult> {
    return this.#active === null ? Promise.resolve({ ok: false, unknown: false, error: 'qq.sendBlocked' })
      : this.#active.sendToGroup(groupId, content, replyTo, controls);
  }

  sendImageToUser(openId: string, image: QqResolvedReplyImage, replyTo?: string, controls?: QqSendControls): Promise<QqSendResult> {
    return this.#active === null ? Promise.resolve({ ok: false, unknown: false, error: 'qq.sendBlocked' })
      : this.#active.sendImageToUser(openId, image, replyTo, controls);
  }

  sendImageToGroup(groupId: string, image: QqResolvedReplyImage, replyTo?: string, controls?: QqSendControls): Promise<QqSendResult> {
    return this.#active === null ? Promise.resolve({ ok: false, unknown: false, error: 'qq.sendBlocked' })
      : this.#active.sendImageToGroup(groupId, image, replyTo, controls);
  }
}
