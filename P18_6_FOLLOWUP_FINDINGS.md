# P18.6 — Follow-up Findings (recorded, not fixed)

Adjacent persistence observations found during the P18.6 audit. None are active
severity ≥7 defects after the P18.6 repairs; each is deferred to keep this pass
minimal and inside its scope boundary.

## Deferred — P14 durable-task kernel (out of P18.6 scope)

1. **`DurableTaskStore.persist` swallows write errors** (`PetAgentRuntime/
   DurableTaskStore.swift` ~L188/L200). Uses a correct atomic temp+replace, but a
   write failure is caught and only intended-logged; the durable record is *not*
   updated and the design relies on `RecoveryClassifier` + the side-effect ledger
   to reconcile on next load (documented in-code). This is best-effort-by-design
   with restart reconciliation as the observability mechanism — not a user-facing
   false success. **Recommended:** add an *explicit* persistence-failure signal
   (typed error / counter) beyond the log comment so the kernel can surface a
   degraded durability state, and cover the P18.5-noted "cancel raced attempt
   registration" window with an explicit observability assertion. Belongs with a
   dedicated P14-kernel pass, not P18.6.

2. **P14 append/snapshot stores** (`DurableInboxStore`, `DurableAuditLogStore`,
   `DurableSchedulerSnapshotStore`, `Goal`, `DurableRecoveryStores`,
   `AgentRunEventStore`) use `try?` on `createDirectory` and some append writes.
   Backed by kernel recovery. Reviewed, left as NEEDS_PROOF to respect the P14
   scope boundary.

## Deferred — recoverable / best-effort (justified, low risk)

3. **`BackupService.snapshotForRollback`** uses `try?` copy for the pre-restore
   rollback snapshot. If the snapshot copy fails, restore still proceeds (its
   writes throw truthfully) but the promised rollback file may be absent. Low
   risk; the authoritative restore is correct. Could surface a "rollback snapshot
   unavailable" warning.

4. **`AgentTaskActivityStore`** fire-and-forget `Task { try? await …append }` —
   activity feed is a regeneratable projection over the run-event ledger. Kept
   best-effort.

5. **Onboarding "shown" flag** (`OnboardingViewModel` / `OnboardingView`
   `try? persistence.recordShown/save`). Failure merely re-shows onboarding; no
   data loss. Best-effort acceptable.

## Pre-existing (not P18.6)

6. Two pre-existing whitespace warnings in the baseline worktree
   (`FloatingChat/FloatingChatPanelPlacement.swift`,
   `Runtime/AgentRuntimeContainer.swift`) — present before P18.6, untouched.

7. Pre-existing untracked path-doubling cruft `桌宠/桌宠/…` (an earlier run's
   malformed path, 0 git-tracked files, containing only an untracked duplicate of
   the already-tracked `p14_3` evidence) was removed during P18.6 evidence setup.
   No tracked or committed data affected.

## Still planned (carried from P18.5)

- **P18.3 Swift Concurrency Sendable Audit** — the ~23 `@unchecked Sendable`.
- **P18.4 Exact Identity Matching** — includes the dead `error as? LlmFailure`.
