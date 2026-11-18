import Foundation

// P14.2 — Task Supervisor (R-A-F1 closure).
//
// The pre-existing `pendingPlanApprovals` map on the coordinator is keyed by
// `conversationID`. After Runtime A → Runtime B, the original `CheckedContinuation`
// does NOT survive (we never persist Swift continuation objects; see §16 of
// the P14.2 contract). To rebuild an executable continuation for a durable
// task that was `.waitingForApproval` at the moment Runtime A was killed,
// the supervisor is keyed by `taskID` (the durable identifier).
//
// Architecture:
//
//   TaskSupervisor (actor)
//     pendingApprovals:  [UUID: CheckedContinuation<PlanApprovalDecision, Never>]
//     pendingTimeouts:   [UUID: Task<Void, Never>]
//     recoveryReservations: Set<UUID>      // INV-CONT-04: at most one
//                                          //         active continuation per task
//
//   PetAgentRuntimeCoordinator owns ONE TaskSupervisor and:
//     - replaces `awaitPlanApproval(conversationID:planID:timeout:)` with
//       `awaitPlanApproval(taskID:planID:timeout:)` (keeps the old method as a
//       thin compatibility wrapper that maps conversationID → taskID).
//     - on Runtime B startup, walks every durable `.waitingForApproval` record
//       and calls `awaitPlanApproval(taskID:planID:timeout:)` for each one,
//       which creates a FRESH continuation keyed by taskID.
//     - on `approveActivePlan(taskID:)` / `cancelActivePlan(taskID:)`, the
//       coordinator looks up the continuation by taskID and resumes it.
//
// The supervisor emits a `staleCallbackDropped` audit event when an
// approval/resume attempt targets a task that already had its continuation
// consumed (R-A-F4 integration).

public actor TaskSupervisor {
    private var pendingApprovals: [UUID: CheckedContinuation<PlanApprovalDecision, Never>] = [:]
    private var pendingTimeouts: [UUID: Task<Void, Never>] = [:]
    /// INV-CONT-04: at most one active continuation per durable task.
    /// Used to suppress duplicate recovery scans from creating two
    /// continuations on the same taskID.
    private var recoveryReservations: Set<UUID> = []
    /// INV-CONT-04: at most one recovery continuation at a time.
    private let reservationLock = NSLock()
    /// Optional audit hook (P14.2 §22 integration). The coordinator wires
    /// this up to its existing durable audit log store. nil = no audit.
    private let auditSink: (@Sendable (String, String) async -> Void)?

    public init(auditSink: (@Sendable (String, String) async -> Void)? = nil) {
        self.auditSink = auditSink
    }

    /// Returns the number of currently-pending continuations. Test-only
    /// diagnostic.
    public func pendingCount() -> Int { pendingApprovals.count }

    /// Reserve the right to create a continuation for `taskID`. Returns
    /// `false` when another concurrent recovery scan has already reserved
    /// the same task (INV-CONT-04). The reservation must be released by
    /// either `awaitApproval` (which transfers ownership into the
    /// continuation map) or `drop(taskID:reason:)`.
    @discardableResult
    public func reserveRecovery(taskID: UUID) -> Bool {
        var inserted = false
        reservationLock.lock()
        if !recoveryReservations.contains(taskID) {
            recoveryReservations.insert(taskID)
            inserted = true
        }
        reservationLock.unlock()
        return inserted
    }

    private func releaseReservation(taskID: UUID) {
        reservationLock.lock()
        recoveryReservations.remove(taskID)
        reservationLock.unlock()
    }

    /// Await a plan-mode approval for a durable task. Returns
    /// `.timedOut` after `timeout` seconds. The caller MUST hold a
    /// `reserveRecovery(taskID:)` permit OR be calling from the live
    /// Runtime A flow (not from the recovery scan).
    public func awaitApproval(taskID: UUID,
                              timeout: TimeInterval,
                              clock: @escaping @Sendable () -> Date = { Date() }) async -> PlanApprovalDecision {
        await withCheckedContinuation { (continuation: CheckedContinuation<PlanApprovalDecision, Never>) in
            // INV-CONT-04 — refuse to overwrite a pending continuation.
            // If the caller is racing the supervisor (e.g., a recovery
            // scan plus a live Runtime A flow), the loser observes a
            // short-lived `.declined` rather than orphaning the first
            // continuation. Callers must consult `reserveRecovery` first.
            if self.pendingApprovals[taskID] != nil {
                // Release the loser's reservation so a future recovery
                // attempt can succeed after the winner's continuation
                // resolves.
                self.releaseReservation(taskID: taskID)
                Task {
                    await self.auditSink?("staleCallbackDropped",
                                            "supervisor:duplicateAwaitApproval:\(taskID)")
                }
                continuation.resume(returning: .declined)
                return
            }
            self.pendingApprovals[taskID] = continuation
            // Schedule a timeout task that fires `.timedOut` if no decision
            // arrives within `timeout` seconds. The Task is owned by the
            // supervisor; cancel it on resume or drop.
            let timeoutTask = Task { [weak self] in
                let deadline = clock().addingTimeInterval(max(0, timeout))
                while !Task.isCancelled {
                    if clock() >= deadline {
                        await self?.timeOutIfStillPending(taskID: taskID)
                        return
                    }
                    try? await Task.sleep(nanoseconds: 50_000_000) // 50ms poll
                }
            }
            self.pendingTimeouts[taskID] = timeoutTask
        }
    }

    private func timeOutIfStillPending(taskID: UUID) async {
        guard let pending = pendingApprovals.removeValue(forKey: taskID) else { return }
        pendingTimeouts[taskID]?.cancel()
        pendingTimeouts[taskID] = nil
        releaseReservation(taskID: taskID)
        await auditSink?("staleCallbackDropped", "supervisor:timedOut:\(taskID)")
        pending.resume(returning: .timedOut)
    }

    /// Resume a pending approval with a decision. Returns `true` if a
    /// continuation was found and resumed; `false` if no continuation was
    /// pending (the caller should treat this as a stale callback, R-A-F4).
    @discardableResult
    public func resumeApproval(taskID: UUID,
                               decision: PlanApprovalDecision) async -> Bool {
        guard let pending = pendingApprovals.removeValue(forKey: taskID) else {
            await auditSink?("staleCallbackDropped", "supervisor:resumeNoContinuation:\(taskID)")
            return false
        }
        pendingTimeouts[taskID]?.cancel()
        pendingTimeouts[taskID] = nil
        releaseReservation(taskID: taskID)
        pending.resume(returning: decision)
        return true
    }

    /// Drop a pending approval (e.g., on cancellation). Returns `true`
    /// if a continuation was consumed.
    @discardableResult
    public func drop(taskID: UUID, reason: String = "drop") async -> Bool {
        guard let pending = pendingApprovals.removeValue(forKey: taskID) else { return false }
        pendingTimeouts[taskID]?.cancel()
        pendingTimeouts[taskID] = nil
        releaseReservation(taskID: taskID)
        await auditSink?("staleCallbackDropped", "supervisor:drop:\(reason):\(taskID)")
        pending.resume(returning: .cancelled)
        return true
    }

    /// Test-only: snapshot of reserved taskIDs. INV-CONT-04 must hold.
    public func recoveryReservationsSnapshot() -> Set<UUID> {
        reservationLock.lock()
        defer { reservationLock.unlock() }
        return recoveryReservations
    }
}