import Foundation
import AICore

// P14-D — Goal and Acceptance Criteria.
//
// A Goal is the user-intended outcome. AcceptanceCriteria are typed
// machine-checkable (or explicitly human-checkable) conditions proving the
// Goal is satisfied. A task is considered completed only when ALL required
// acceptance criteria are satisfied (or a clearly-modeled manual override).
// LLM text alone is NEVER sufficient to complete a task (INV-DUR-09).
//
// The categories here are bounded to what current real workflows support
// (P14 §11.2).

public enum AcceptanceCriterionKind: String, Codable, Sendable, Hashable, CaseIterable {
    case runtimeInvariant         // e.g. "no crash", "ledger non-empty"
    case toolOutcome              // e.g. "tool X returned Y"
    case artifactExists           // e.g. "user-visible artifact persisted"
    case stateCondition           // e.g. "task state is .completed"
    case userApproval             // user must approve the result
    case userConfirmation         // user must confirm the result is correct
}

// MARK: - Goal model

public struct Goal: Codable, Sendable, Hashable, Identifiable {
    public var schemaVersion: Int
    public var id: UUID
    public var taskID: UUID
    public var objective: String           // user-readable statement of the goal
    public var acceptanceCriteria: [AcceptanceCriterion]
    public var createdAt: Date
    public var updatedAt: Date

    public init(schemaVersion: Int = 1,
                id: UUID = UUID(),
                taskID: UUID,
                objective: String,
                acceptanceCriteria: [AcceptanceCriterion] = [],
                createdAt: Date = Date(),
                updatedAt: Date = Date()) {
        self.schemaVersion = max(1, schemaVersion)
        self.id = id
        self.taskID = taskID
        self.objective = AgentPrivacyRedactor.safeText(objective, maxLength: 1024).text
        self.acceptanceCriteria = acceptanceCriteria.sorted { $0.criterionID < $1.criterionID }
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// Required criteria — without these, the goal cannot complete.
    public var requiredCriteria: [AcceptanceCriterion] {
        acceptanceCriteria.filter { $0.required }
    }
}

// MARK: - Acceptance criterion

public struct AcceptanceCriterion: Codable, Sendable, Hashable, Identifiable {
    public var criterionID: String            // stable, app-defined identifier
    public var kind: AcceptanceCriterionKind
    public var description: String
    public var required: Bool                  // false = optional enhancement
    public var satisfied: Bool                 // runtime-updated
    public var satisfiedAt: Date?
    public var satisfiedByEvidenceID: String? // optional trace link
    public var satisfier: String?              // "tool:X", "user", "runtime"

    public var id: String { criterionID }

    public init(criterionID: String,
                kind: AcceptanceCriterionKind,
                description: String,
                required: Bool = true,
                satisfied: Bool = false,
                satisfiedAt: Date? = nil,
                satisfiedByEvidenceID: String? = nil,
                satisfier: String? = nil) {
        self.criterionID = AgentEventRedactor.safeIdentifier(criterionID)
        self.kind = kind
        self.description = AgentPrivacyRedactor.safeText(description, maxLength: 512).text
        self.required = required
        self.satisfied = satisfied
        self.satisfiedAt = satisfiedAt
        self.satisfiedByEvidenceID = satisfiedByEvidenceID
        self.satisfier = satisfier
    }

    /// Mark this criterion as satisfied. Idempotent — once satisfied, it
    /// stays satisfied (criterion invalidation is an explicit transition).
    public mutating func satisfy(evidenceID: String? = nil, satisfier: String? = nil) {
        if satisfied { return }
        satisfied = true
        satisfiedAt = Date()
        satisfiedByEvidenceID = evidenceID
        self.satisfier = satisfier
    }

    /// Explicit invalidation (e.g. retry may erase a previously-satisfied
    /// criterion when its underpinning evidence was rolled back).
    public mutating func invalidate() {
        satisfied = false
        satisfiedAt = nil
        satisfiedByEvidenceID = nil
        satisfier = nil
    }
}

// MARK: - Evaluator

public struct AcceptanceEvaluator: Sendable {
    public init() {}

    /// Evaluate whether the task may transition to `.completed`. The runtime
    /// MUST consult this before any model-final-response shortcut.
    public func mayComplete(goal: Goal) -> AcceptanceEvaluation {
        let unsatisfied = goal.requiredCriteria.filter { !$0.satisfied }
        if unsatisfied.isEmpty {
            return .allSatisfied
        }
        // If only user-approval / user-confirmation remain, that is waiting
        // state — not failure.
        let userOnly = unsatisfied.allSatisfy { $0.kind == .userApproval || $0.kind == .userConfirmation }
        if userOnly {
            return .waitingForUser(missing: unsatisfied)
        }
        return .unsatisfied(missing: unsatisfied)
    }

    /// Evaluate after a model reports "done" — even if the model produced a
    /// plausible final response, completion requires satisfied criteria.
    /// Returns false unless ALL required criteria are met.
    public func modelReportsCompletionButCriteriaIncomplete(goal: Goal) -> Bool {
        !goal.requiredCriteria.allSatisfy { $0.satisfied }
    }
}

public enum AcceptanceEvaluation: Sendable, Equatable, Hashable {
    case allSatisfied
    case waitingForUser(missing: [AcceptanceCriterion])
    case unsatisfied(missing: [AcceptanceCriterion])

    public var isTerminalEligible: Bool {
        if case .allSatisfied = self { return true }
        return false
    }
}

// MARK: - Goal store

public actor GoalStore {
    private let baseDirectory: URL
    private let fileManager: FileManager
    private var goals: [UUID: Goal] = [:]   // keyed by goal.id

    public init(baseDirectory: URL, fileManager: FileManager = .default) {
        self.baseDirectory = baseDirectory
        self.fileManager = fileManager
    }

    public static func defaultStore() -> GoalStore {
        let base = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("DeskPet", isDirectory: true)
            .appendingPathComponent("Goals", isDirectory: true)
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("DeskPet-Goals")
        return GoalStore(baseDirectory: base)
    }

    public func load() async {
        try? fileManager.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        guard let entries = try? fileManager.contentsOfDirectory(at: baseDirectory,
                                                                 includingPropertiesForKeys: nil) else {
            return
        }
        for url in entries where url.pathExtension == "json" {
            // D3: sealed-aware read (keyless-sealed files skipped, kept).
            guard let data = try? Data(contentsOf: url),
                  let plain = try? SealedStore.openForRead(data),
                  let goal = try? Self.decoder.decode(Goal.self, from: plain) else {
                continue
            }
            goals[goal.id] = goal
        }
    }

    public func upsert(_ goal: Goal) async {
        goals[goal.id] = goal
        let url = baseDirectory.appendingPathComponent("\(goal.id.uuidString).json")
        do {
            // D3: sealed when keyed (keyless-sealed overwrite refused).
            let data = try SealedStore.sealForWrite(Self.encoder.encode(goal), url: url)
            try data.write(to: url, options: [.atomic])
        } catch {
            // Persistence failure is logged but does not break the in-memory store.
        }
    }

    public func goal(id: UUID) -> Goal? { goals[id] }
    public func goals(forTask taskID: UUID) -> [Goal] {
        goals.values.filter { $0.taskID == taskID }
    }
    public func allGoals() -> [Goal] {
        goals.values.sorted { $0.createdAt < $1.createdAt }
    }

    public func satisfy(criterionID: String,
                        goalID: UUID,
                        evidenceID: String? = nil,
                        satisfier: String? = nil) async -> Goal? {
        guard var goal = goals[goalID] else { return nil }
        for index in goal.acceptanceCriteria.indices {
            if goal.acceptanceCriteria[index].criterionID == criterionID {
                goal.acceptanceCriteria[index].satisfy(evidenceID: evidenceID,
                                                       satisfier: satisfier)
            }
        }
        goal.updatedAt = Date()
        await upsert(goal)
        return goal
    }

    public func invalidate(criterionID: String, goalID: UUID) async -> Goal? {
        guard var goal = goals[goalID] else { return nil }
        for index in goal.acceptanceCriteria.indices {
            if goal.acceptanceCriteria[index].criterionID == criterionID {
                goal.acceptanceCriteria[index].invalidate()
            }
        }
        goal.updatedAt = Date()
        await upsert(goal)
        return goal
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys]
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}
