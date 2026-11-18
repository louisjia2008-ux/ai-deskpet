import Foundation

public enum ToolRiskClass: String, Codable, Sendable, Hashable, Comparable, CaseIterable {
    case readOnly
    case draftOnly
    case externalWrite
    case highRisk

    private var rank: Int {
        switch self {
        case .readOnly: return 0
        case .draftOnly: return 1
        case .externalWrite: return 2
        case .highRisk: return 3
        }
    }

    public static func < (lhs: ToolRiskClass, rhs: ToolRiskClass) -> Bool {
        lhs.rank < rhs.rank
    }
}

public extension ToolRiskLevel {
    var p6RiskClass: ToolRiskClass {
        switch self {
        case .safe, .localReadOnlyNoPrivateData, .privateDataReadOnly, .externalReadOnly, .sensitive:
            return .readOnly
        case .externalSideEffectReversible:
            return .externalWrite
        case .highRisk, .destructiveOrSensitiveWrite, .unknown:
            return .highRisk
        }
    }
}

public struct ToolInvocationApprovalGrant: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var taskID: UUID
    public var runID: UUID
    public var toolCallID: String
    public var toolID: ToolID
    public var normalizedArgumentHash: String
    public var grantedAt: Date
    public var expiresAt: Date
    public var oneTimeUse: Bool
    public var consumedAt: Date?

    public init(id: UUID = UUID(),
                taskID: UUID,
                runID: UUID,
                toolCallID: String,
                toolID: ToolID,
                normalizedArgumentHash: String,
                grantedAt: Date,
                expiresAt: Date,
                oneTimeUse: Bool = true,
                consumedAt: Date? = nil) {
        self.id = id
        self.taskID = taskID
        self.runID = runID
        self.toolCallID = AgentEventRedactor.safeIdentifier(toolCallID)
        self.toolID = toolID
        self.normalizedArgumentHash = normalizedArgumentHash
        self.grantedAt = grantedAt
        self.expiresAt = expiresAt
        self.oneTimeUse = oneTimeUse
        self.consumedAt = consumedAt
    }
}

public enum ToolApprovalDecision: Sendable, Equatable {
    case granted(ToolInvocationApprovalGrant)
    case denied(String)
}

public actor ToolInvocationApprovalStore {
    private var grants: [UUID: ToolInvocationApprovalGrant] = [:]
    private let clock: RuntimeClock

    public init(clock: RuntimeClock = WallClock()) {
        self.clock = clock
    }

    public func grant(taskID: UUID,
                      runID: UUID,
                      toolCallID: String,
                      toolID: ToolID,
                      arguments: AgentJSONValue,
                      ttl: TimeInterval = 5 * 60,
                      oneTimeUse: Bool = true) -> ToolInvocationApprovalGrant {
        let now = clock.now()
        let grant = ToolInvocationApprovalGrant(
            taskID: taskID,
            runID: runID,
            toolCallID: toolCallID,
            toolID: toolID,
            normalizedArgumentHash: Self.argumentHash(arguments),
            grantedAt: now,
            expiresAt: now.addingTimeInterval(max(1, ttl)),
            oneTimeUse: oneTimeUse)
        grants[grant.id] = grant
        return grant
    }

    public func consume(grantID: UUID,
                        taskID: UUID,
                        runID: UUID,
                        toolCallID: String,
                        toolID: ToolID,
                        arguments: AgentJSONValue) -> ToolApprovalDecision {
        let now = clock.now()
        guard var grant = grants[grantID] else { return .denied("approval not found") }
        guard grant.consumedAt == nil else { return .denied("approval already consumed") }
        guard grant.expiresAt >= now else { return .denied("approval expired") }
        guard grant.taskID == taskID else { return .denied("taskID mismatch") }
        guard grant.runID == runID else { return .denied("runID mismatch") }
        guard grant.toolCallID == AgentEventRedactor.safeIdentifier(toolCallID) else { return .denied("toolCallID mismatch") }
        guard grant.toolID == toolID else { return .denied("toolID mismatch") }
        guard grant.normalizedArgumentHash == Self.argumentHash(arguments) else { return .denied("argument hash mismatch") }
        if grant.oneTimeUse {
            grant.consumedAt = now
            grants[grantID] = grant
        }
        return .granted(grant)
    }

    public func count() -> Int { grants.count }

    public static func argumentHash(_ arguments: AgentJSONValue) -> String {
        stableHash(arguments.canonicalString)
    }

    private static func stableHash(_ value: String) -> String {
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in value.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 1_099_511_628_211
        }
        return String(hash, radix: 16)
    }
}
