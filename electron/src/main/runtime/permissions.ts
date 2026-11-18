import type { PermissionDescriptor } from '../../shared';
import type { DomainRepository } from '../domain';
import type { PermissionGrant } from '../domain';

export class PermissionDeniedError extends Error {
  readonly capabilityId: string;

  constructor(capabilityId: string) {
    super(`Permission is required for capability ${capabilityId}.`);
    this.name = 'PermissionDeniedError';
    this.capabilityId = capabilityId;
  }
}

export interface PermissionLease { signal: AbortSignal; assertCurrent(): void; release(): void }

export interface PermissionAudit {
  capabilityId: string;
  action: 'granted' | 'consumed' | 'denied' | 'revoked';
  scope: PermissionGrant['scope'] | null;
  createdAt: string;
}

export class PermissionGate {
  readonly #repository: DomainRepository;
  readonly #sessionGrants = new Map<string, PermissionGrant>();
  readonly #leases = new Map<string, Set<AbortController>>();
  readonly #epochs = new Map<string, number>();
  readonly #blocked = new Set<string>();
  readonly #audit: (entry: PermissionAudit) => void;

  constructor(repository: DomainRepository, audit: (entry: PermissionAudit) => void = () => undefined) {
    this.#repository = repository;
    this.#audit = audit;
  }

  #invalidate(capabilityId: string): void {
    this.#blocked.add(capabilityId);
    this.#epochs.set(capabilityId, (this.#epochs.get(capabilityId) ?? 0) + 1);
    for (const controller of this.#leases.get(capabilityId) ?? []) controller.abort(new PermissionDeniedError(capabilityId));
    this.#leases.delete(capabilityId);
  }

  async grant(
    capabilityId: string,
    scope: PermissionGrant['scope'],
    expiresAt: string | null = null,
    now = new Date(),
  ): Promise<PermissionGrant> {
    this.#invalidate(capabilityId);
    const grant: PermissionGrant = {
      capabilityId,
      scope,
      grantedAt: now.toISOString(),
      expiresAt,
      remainingUses: scope === 'once' ? 1 : null,
    };
    try {
      if (scope === 'always') {
        await this.#repository.transaction((state) => {
          state.persistentPermissionGrants = state.persistentPermissionGrants.filter(
            (item) => item.capabilityId !== capabilityId,
          );
          state.persistentPermissionGrants.push(grant);
        });
        // The newly selected scope replaces the previous choice immediately.
        // Otherwise an old session grant hides this saved grant until restart.
        this.#sessionGrants.delete(capabilityId);
      } else {
        // Switching back to a temporary grant must also remove the saved choice,
        // so it cannot silently become permanent again on the next launch.
        if (this.#repository.read('persistentPermissionGrants').some((item) => item.capabilityId === capabilityId)) {
          await this.#repository.transaction((state) => {
            state.persistentPermissionGrants = state.persistentPermissionGrants.filter((item) => item.capabilityId !== capabilityId);
          });
        }
        this.#sessionGrants.set(capabilityId, grant);
      }
    } catch (error) { this.#blocked.delete(capabilityId); throw error; }
    this.#blocked.delete(capabilityId);
    this.#audit({ capabilityId, action: 'granted', scope, createdAt: now.toISOString() });
    return grant;
  }

  async revoke(capabilityId: string, now = new Date()): Promise<void> {
    this.#invalidate(capabilityId);
    this.#sessionGrants.delete(capabilityId);
    await this.#repository.transaction((state) => {
      state.persistentPermissionGrants = state.persistentPermissionGrants.filter(
        (item) => item.capabilityId !== capabilityId,
      );
    });
    this.#audit({ capabilityId, action: 'revoked', scope: null, createdAt: now.toISOString() });
  }

  assertPersistent(capabilityId: string, now = new Date()): void {
    const grant = this.#repository.read('persistentPermissionGrants').find((v) => v.capabilityId === capabilityId);
    if (this.#blocked.has(capabilityId) || !grant || grant.scope !== 'always' || (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now.getTime())) throw new PermissionDeniedError(capabilityId);
  }

  /** Host revision binds an inline decision to the permission state it reviewed. */
  revision(capabilityId: string): number { return this.#epochs.get(capabilityId) ?? 0; }

  /** A console-approved operation receives its own lease, never a globally consumable grant. */
  authorizeOperation(capabilityId: string, expectedRevision: number, now = new Date()): PermissionLease {
    if (this.revision(capabilityId) !== expectedRevision) throw new PermissionDeniedError(capabilityId);
    const epoch = expectedRevision;
    // This decision is scoped to its operation. It never clears a global revoke
    // (including a revoke whose disk write has not yet completed).
    const controller = new AbortController();
    const active = this.#leases.get(capabilityId) ?? new Set<AbortController>();
    active.add(controller); this.#leases.set(capabilityId, active);
    const expiresAt = now.getTime() + 10 * 60_000;
    this.#audit({ capabilityId, action: 'granted', scope: 'once', createdAt: now.toISOString() });
    this.#audit({ capabilityId, action: 'consumed', scope: 'once', createdAt: now.toISOString() });
    return {
      signal: controller.signal,
      assertCurrent: () => {
        if (controller.signal.aborted || this.revision(capabilityId) !== epoch || Date.now() >= expiresAt) throw new PermissionDeniedError(capabilityId);
      },
      release: () => { active.delete(controller); if (active.size === 0 && this.#leases.get(capabilityId) === active) this.#leases.delete(capabilityId); },
    };
  }

  async consume(capabilityId: string, now = new Date()): Promise<PermissionLease> {
    const sessionGrant = this.#sessionGrants.get(capabilityId);
    const persistentGrant = this.#repository
      .snapshot()
      .persistentPermissionGrants.find((item) => item.capabilityId === capabilityId);
    const grant = sessionGrant ?? persistentGrant;
    const expired = grant?.expiresAt !== null && grant?.expiresAt !== undefined && Date.parse(grant.expiresAt) <= now.getTime();
    if (this.#blocked.has(capabilityId) || grant === undefined || expired || grant.remainingUses === 0) {
      this.#audit({ capabilityId, action: 'denied', scope: grant?.scope ?? null, createdAt: now.toISOString() });
      throw new PermissionDeniedError(capabilityId);
    }
    if (grant.scope === 'once') {
      this.#sessionGrants.delete(capabilityId);
    }
    this.#audit({ capabilityId, action: 'consumed', scope: grant.scope, createdAt: now.toISOString() });
    const epoch = this.#epochs.get(capabilityId) ?? 0;
    const controller = new AbortController();
    const active = this.#leases.get(capabilityId) ?? new Set<AbortController>(); active.add(controller); this.#leases.set(capabilityId, active);
    return { signal: controller.signal, assertCurrent: () => {
      if (this.#blocked.has(capabilityId) || controller.signal.aborted || epoch !== (this.#epochs.get(capabilityId) ?? 0) || (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.now())) throw new PermissionDeniedError(capabilityId);
    }, release: () => { active.delete(controller); if (active.size === 0 && this.#leases.get(capabilityId) === active) this.#leases.delete(capabilityId); } };
  }

  list(descriptors: ReadonlyArray<Omit<PermissionDescriptor, 'state' | 'expiresAt'>>): PermissionDescriptor[] {
    const persistent = this.#repository.read('persistentPermissionGrants');
    return descriptors.map((descriptor) => {
      const session = this.#sessionGrants.get(descriptor.capabilityId);
      const always = persistent.find((item) => item.capabilityId === descriptor.capabilityId);
      const grant = session ?? always;
      return {
        ...descriptor,
        state: grant?.scope === 'always' ? 'always' : grant === undefined ? 'not-requested' : 'session',
        expiresAt: grant?.expiresAt ?? null,
      };
    });
  }
}
