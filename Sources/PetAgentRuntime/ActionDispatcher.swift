import Foundation
import AICore
import PetBrainCore

// P5.0 — the boundary between the runtime's decisions and the execution layer (doc §6.3). Actions are
// queued with a priority; a higher-priority user action interrupts pending low-priority ambient/
// proactive actions so the animation queue never piles up. Sensitive actions (requestPermission,
// invokeTool) must pass the PermissionGate before they run — fail closed. Cancelled actions are
// reported cancelled, never completed. A timed-out action surfaces a distinct outcome.
//
// P5.0 drains the queue explicitly (runNext/runAll) rather than running a live preemption loop; a
// background pump is a P5.1 addition. This keeps ordering and interruption deterministic and testable.

public enum ActionPriority: Int, Sendable, Comparable, CaseIterable, Codable {
    case ambient = 0
    case proactiveCompanion = 1
    case assistantResponse = 2
    case userInitiated = 3
    case userCritical = 4
    public static func < (l: Self, r: Self) -> Bool { l.rawValue < r.rawValue }
}

public enum ActionSource: String, Sendable, Equatable, Codable {
    case userInteraction, assistant, proactive, system, runtimeLifecycle
}

public enum DeskPetAction: Sendable, Equatable {
    case speak(String)
    case setExpression(CharacterExpression)
    case playMotion(CharacterMotion)
    case showNotification(title: String, body: String)
    case requestPermission(capabilityID: String, reason: String)
    case invokeTool(identifier: String, arguments: [String: String])
    case wait(seconds: TimeInterval)
    case updatePresence(Bool)

    public var isSensitive: Bool {
        switch self {
        case .requestPermission, .invokeTool: return true
        default: return false
        }
    }

    /// The capability the *action itself* gates on. invokeTool gates inside the ToolRegistry (per the
    /// tool's declared capabilities), so it is nil here.
    public var requiredCapabilityID: String? {
        if case .requestPermission(let capabilityID, _) = self { return capabilityID }
        return nil
    }

    /// Presentation actions of the same kind may be merged so the queue doesn't grow unbounded.
    public var presentationKind: String? {
        switch self {
        case .speak: return "speak"
        case .setExpression: return "expression"
        case .playMotion: return "motion"
        case .updatePresence: return "presence"
        default: return nil
        }
    }
}

public struct ActionEnvelope: Sendable, Equatable, Identifiable {
    public let id: UUID
    public var action: DeskPetAction
    public var priority: ActionPriority
    public var source: ActionSource
    public var correlationID: UUID?
    public var createdAt: Date
    public var timeout: TimeInterval?

    public init(id: UUID, action: DeskPetAction, priority: ActionPriority, source: ActionSource,
                correlationID: UUID? = nil, createdAt: Date, timeout: TimeInterval? = nil) {
        self.id = id
        self.action = action
        self.priority = priority
        self.source = source
        self.correlationID = correlationID
        self.createdAt = createdAt
        self.timeout = timeout
    }
}

public struct ActionResult: Sendable, Equatable {
    public var ok: Bool
    public var detail: String
    public var error: String?
    public init(ok: Bool, detail: String = "", error: String? = nil) {
        self.ok = ok; self.detail = detail; self.error = error
    }
}

public enum ActionOutcome: Sendable, Equatable {
    case completed(id: UUID, detail: String)
    case denied(id: UUID, reason: String)
    case cancelled(id: UUID)
    case timedOut(id: UUID)
    case failed(id: UUID, reason: String)
}

/// Performs a resolved action. The dispatcher gates and orders; the executor only carries out the
/// concrete effect (drive the presentation driver, invoke a tool, etc.).
public protocol ActionExecuting: Sendable {
    func perform(_ action: DeskPetAction, correlationID: UUID?) async -> ActionResult
}

public actor ActionDispatcher {
    private let executor: ActionExecuting
    private let gate: PermissionGate
    private let audit: RuntimeAuditSink
    private let bus: RuntimeEventBus?
    private let clock: RuntimeClock

    private var pending: [ActionEnvelope] = []
    private var cancelled: Set<UUID> = []

    public init(executor: ActionExecuting, gate: PermissionGate, audit: RuntimeAuditSink,
                bus: RuntimeEventBus? = nil, clock: RuntimeClock = WallClock()) {
        self.executor = executor
        self.gate = gate
        self.audit = audit
        self.bus = bus
        self.clock = clock
    }

    public func pendingCount() -> Int { pending.count }
    public func pendingIDs() -> [UUID] { pending.map(\.id) }

    public func enqueue(_ envelope: ActionEnvelope) async {
        // Merge a same-kind presentation action of equal/lower priority instead of appending.
        if let kind = envelope.action.presentationKind,
           let index = pending.firstIndex(where: { $0.action.presentationKind == kind && $0.priority <= envelope.priority }) {
            pending[index] = envelope
        } else {
            pending.append(envelope)
        }

        // A high-priority user action interrupts pending low-priority ambient/proactive actions.
        if envelope.priority >= .userInitiated {
            let interrupted = pending.filter { $0.id != envelope.id && $0.priority <= .proactiveCompanion }
            for victim in interrupted {
                cancelled.insert(victim.id)
                await audit.record(RuntimeAuditEvent(kind: .policySuppression, correlationID: victim.correlationID,
                                                     summary: "interruptedBy=\(envelope.priority)", timestamp: clock.now()))
                await bus?.publish(.actionCancelled(victim.id), correlationID: victim.correlationID)
            }
            pending.removeAll { $0.id != envelope.id && $0.priority <= .proactiveCompanion }
        }

        sortPending()
        await audit.record(RuntimeAuditEvent(kind: .actionQueued, correlationID: envelope.correlationID,
                                             summary: "\(envelope.priority)", timestamp: clock.now()))
        await bus?.publish(.actionQueued(envelope.id), correlationID: envelope.correlationID)
    }

    /// Marks an action cancelled. It stays queued so `runNext` reports it as `.cancelled` (never
    /// `.completed`) when drained.
    public func cancel(_ id: UUID) async {
        cancelled.insert(id)
        await audit.record(RuntimeAuditEvent(kind: .cancellation, correlationID: id, summary: "action", timestamp: clock.now()))
        await bus?.publish(.actionCancelled(id), correlationID: id)
    }

    @discardableResult
    public func runNext() async -> ActionOutcome? {
        guard !pending.isEmpty else { return nil }
        let envelope = pending.removeFirst()

        if cancelled.remove(envelope.id) != nil {
            return .cancelled(id: envelope.id)
        }

        // Gate the action itself (requestPermission). invokeTool is gated inside the ToolRegistry.
        if let capability = envelope.action.requiredCapabilityID {
            await bus?.publish(.permissionRequested(capabilityID: capability, correlationID: envelope.correlationID),
                               correlationID: envelope.correlationID)
            let permission = await gate.evaluate(capabilityID: capability,
                                                 reason: "action:requestPermission",
                                                 correlationID: envelope.correlationID)
            guard permission.isExecutable else {
                let reason = permission.denialReason ?? "permission denied"
                await bus?.publish(.actionFailed(envelope.id, reason: reason), correlationID: envelope.correlationID)
                return .denied(id: envelope.id, reason: reason)
            }
        }

        await bus?.publish(.actionStarted(envelope.id), correlationID: envelope.correlationID)
        await audit.record(RuntimeAuditEvent(kind: .actionStarted, correlationID: envelope.correlationID,
                                             summary: "", timestamp: clock.now()))

        let action = envelope.action
        let correlationID = envelope.correlationID
        let executor = self.executor
        do {
            let result: ActionResult
            if let timeout = envelope.timeout {
                result = try await withTimeout(seconds: timeout) {
                    await executor.perform(action, correlationID: correlationID)
                }
            } else {
                result = await executor.perform(action, correlationID: correlationID)
            }
            if result.ok {
                await bus?.publish(.actionCompleted(envelope.id), correlationID: correlationID)
                await audit.record(RuntimeAuditEvent(kind: .actionCompleted, correlationID: correlationID,
                                                     summary: "", timestamp: clock.now()))
                return .completed(id: envelope.id, detail: result.detail)
            } else {
                let reason = result.error ?? "failed"
                await bus?.publish(.actionFailed(envelope.id, reason: reason), correlationID: correlationID)
                return .failed(id: envelope.id, reason: reason)
            }
        } catch is RuntimeTimeoutError {
            await audit.record(RuntimeAuditEvent(kind: .timeout, correlationID: correlationID,
                                                 summary: "action", timestamp: clock.now()))
            return .timedOut(id: envelope.id)
        } catch is CancellationError {
            return .cancelled(id: envelope.id)
        } catch {
            return .failed(id: envelope.id, reason: "\(error)")
        }
    }

    public func runAll() async -> [ActionOutcome] {
        var outcomes: [ActionOutcome] = []
        while let outcome = await runNext() { outcomes.append(outcome) }
        return outcomes
    }

    private func sortPending() {
        pending.sort { lhs, rhs in
            if lhs.priority != rhs.priority { return lhs.priority > rhs.priority }
            return lhs.createdAt < rhs.createdAt
        }
    }
}
