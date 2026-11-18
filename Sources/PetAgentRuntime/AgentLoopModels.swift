import Foundation
import AICore
import PetBrainCore

// P3 bounded single-agent tool loop. These types are runtime-level contracts:
// providers may produce decisions, but only the coordinator/gate/executor can act on them.

public enum AgentJSONValue: Sendable, Equatable, Hashable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([AgentJSONValue])
    case object([String: AgentJSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([AgentJSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: AgentJSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    public var canonicalString: String {
        switch self {
        case .null: return "null"
        case .bool(let value): return value ? "true" : "false"
        case .number(let value):
            if value.rounded() == value { return String(Int64(value)) }
            return String(value)
        case .string(let value): return "\"\(value.replacingOccurrences(of: "\"", with: "\\\""))\""
        case .array(let values): return "[\(values.map(\.canonicalString).joined(separator: ","))]"
        case .object(let values):
            let pairs = values.keys.sorted().map { key in
                AgentJSONValue.string(key).canonicalString + ":" + (values[key]?.canonicalString ?? "null")
            }
            return "{" + pairs.joined(separator: ",") + "}"
        }
    }

    public static func fromJSONObject(_ object: Any) throws -> AgentJSONValue {
        switch object {
        case is NSNull:
            return .null
        case let value as Bool:
            return .bool(value)
        case let value as Int:
            return .number(Double(value))
        case let value as Double:
            return .number(value)
        case let value as String:
            return .string(value)
        case let value as [Any]:
            return .array(try value.map { try fromJSONObject($0) })
        case let value as [String: Any]:
            var out: [String: AgentJSONValue] = [:]
            for (key, value) in value {
                out[key] = try fromJSONObject(value)
            }
            return .object(out)
        default:
            throw AgentLoopRuntimeError.invalidToolArguments
        }
    }

    public func stringArguments() throws -> [String: String] {
        guard case .object(let object) = self else {
            throw AgentLoopRuntimeError.invalidToolArguments
        }
        var out: [String: String] = [:]
        for (key, value) in object {
            switch value {
            case .null:
                continue
            case .string(let raw):
                out[key] = raw
            case .bool(let raw):
                out[key] = raw ? "true" : "false"
            case .number(let raw):
                out[key] = raw.rounded() == raw ? String(Int64(raw)) : String(raw)
            case .array, .object:
                throw AgentLoopRuntimeError.invalidToolArguments
            }
        }
        return out
    }

    public var jsonString: String {
        let encoder = JSONEncoder()
        if #available(macOS 10.13, *) {
            encoder.outputFormatting = [.sortedKeys]
        }
        guard let data = try? encoder.encode(self),
              let string = String(data: data, encoding: .utf8) else {
            return canonicalString
        }
        return string
    }

    public func sanitized(maxStringLength: Int = 2_048) -> AgentJSONValue {
        switch self {
        case .null, .bool, .number:
            return self
        case .string(let value):
            return .string(AgentPrivacyRedactor.safeText(value, maxLength: maxStringLength).text)
        case .array(let values):
            return .array(values.map { $0.sanitized(maxStringLength: maxStringLength) })
        case .object(let values):
            var sanitized: [String: AgentJSONValue] = [:]
            for (key, value) in values {
                if AgentPrivacyRedactor.isSensitiveKey(key) {
                    sanitized[key] = .string("[redacted]")
                } else if AgentPrivacyRedactor.isPathKey(key) {
                    sanitized[key] = .string("[redacted-path]")
                } else {
                    sanitized[key] = value.sanitized(maxStringLength: maxStringLength)
                }
            }
            return .object(sanitized)
        }
    }
}

public struct AgentFinalResponse: Sendable, Equatable {
    public var text: String
    public var finishReason: String
    public var providerMetadata: [String: String]

    public init(text: String, finishReason: String = "stop", providerMetadata: [String: String] = [:]) {
        let safe = AgentPrivacyRedactor.safeText(text, maxLength: 8_000)
        self.text = safe.text
        self.finishReason = AgentPrivacyRedactor.safeSummary(finishReason, fallback: "stop")
        self.providerMetadata = AgentPrivacyRedactor.safeMetadata(providerMetadata)
    }
}

public struct AgentToolCallRequest: Sendable, Equatable {
    public var callID: String
    public var toolName: String
    public var arguments: AgentJSONValue
    public var userVisibleSummary: String

    public init(callID: String, toolName: String, arguments: AgentJSONValue,
                userVisibleSummary: String) {
        self.callID = AgentPrivacyRedactor.safeIdentifier(callID, fallback: "call")
        self.toolName = AgentPrivacyRedactor.safeIdentifier(toolName, fallback: "unknown")
        self.arguments = arguments
        self.userVisibleSummary = AgentPrivacyRedactor.safeSummary(userVisibleSummary,
                                                                   fallback: "正在处理")
    }

    public var fingerprint: String {
        "\(toolName)|\(arguments.canonicalString)"
    }
}

public enum AgentLoopDecision: Sendable, Equatable {
    case finalResponse(AgentFinalResponse)
    case toolCall(AgentToolCallRequest)
    case proposePlan(RawTaskPlan)
}

public enum AgentLoopObservationStatus: String, Sendable, Codable, Equatable {
    case success
    case denied
    case failed
    case timeout
}

public struct AgentToolObservation: Sendable, Equatable {
    public var callID: String
    public var toolName: String
    public var status: AgentLoopObservationStatus
    public var content: AgentJSONValue
    public var userSafeSummary: String
    public var isTruncated: Bool

    public init(callID: String, toolName: String, status: AgentLoopObservationStatus,
                content: AgentJSONValue, userSafeSummary: String, isTruncated: Bool = false) {
        self.callID = AgentPrivacyRedactor.safeIdentifier(callID, fallback: "call")
        self.toolName = AgentPrivacyRedactor.safeIdentifier(toolName, fallback: "unknown")
        self.status = status
        self.content = content.sanitized()
        self.userSafeSummary = AgentPrivacyRedactor.safeSummary(userSafeSummary, fallback: status.rawValue)
        self.isTruncated = isTruncated
    }

    public var legacyObservation: ToolObservation {
        ToolObservation(stepID: callID, capabilityID: toolName,
                        ok: status == .success, summary: userSafeSummary)
    }
}

public enum AgentLoopStopReason: String, Sendable, Codable, Equatable {
    case completed
    case cancelled
    case modelTimeout
    case toolTimeout
    case iterationLimit
    case toolCallLimit
    case repeatedToolCall
    case malformedDecision
    case permissionDenied
    case providerFailure
    case toolFailure
}

public enum AgentLoopState: Sendable, Equatable {
    case idle
    case preparing
    case requestingModel(iteration: Int)
    case awaitingToolApproval(toolName: String)
    case executingTool(toolName: String)
    case toolObserved(AgentToolObservation)
    case feedingObservation(iteration: Int)
    case finishing
    case completed(AgentLoopStopReason)
    case cancelled
    case failed(AgentLoopStopReason)

    public var userVisibleStatus: String? {
        switch self {
        case .idle, .toolObserved, .completed, .cancelled, .failed:
            return nil
        case .preparing:
            return "正在准备"
        case .requestingModel:
            return "正在思考"
        case .awaitingToolApproval:
            return "等待权限确认"
        case .executingTool(let toolName):
            return AgentPrivacyRedactor.safeSummary(Self.defaultToolSummary(toolName),
                                                    fallback: "正在处理")
        case .feedingObservation:
            return "正在读取结果"
        case .finishing:
            return "正在整理回复"
        }
    }

    public var ledgerLabel: String {
        switch self {
        case .idle: return "idle"
        case .preparing: return "preparing"
        case .requestingModel(let iteration): return "requestingModel:\(iteration)"
        case .awaitingToolApproval(let tool): return "awaitingToolApproval:\(tool)"
        case .executingTool(let tool): return "executingTool:\(tool)"
        case .toolObserved(let observation): return "toolObserved:\(observation.toolName):\(observation.status.rawValue)"
        case .feedingObservation(let iteration): return "feedingObservation:\(iteration)"
        case .finishing: return "finishing"
        case .completed(let reason): return "completed:\(reason.rawValue)"
        case .cancelled: return "cancelled"
        case .failed(let reason): return "failed:\(reason.rawValue)"
        }
    }

    private static func defaultToolSummary(_ toolName: String) -> String {
        switch toolName {
        case "state.read", "runtime.status": return "正在读取当前应用状态"
        case "get_current_datetime": return "正在获取本地日期和时间…"
        case "calendar.events.read": return "正在查询日历"
        case "reminders.read": return "正在读取提醒"
        case "timer.local": return "正在设置计时器"
        default: return "正在执行工具"
        }
    }
}

public struct AgentLoopLimits: Sendable, Equatable {
    public var maxIterations: Int
    public var maxToolCalls: Int
    public var maxConsecutiveParseRepairs: Int
    public var maxRepeatedIdenticalToolCalls: Int
    public var turnDeadline: TimeInterval
    public var modelRequestTimeout: TimeInterval
    public var toolExecutionTimeout: TimeInterval
    public var streamIdleTimeout: TimeInterval
    public var decisionRepairTimeout: TimeInterval
    public var maxObservationCharacters: Int

    public init(maxIterations: Int = 4, maxToolCalls: Int = 3,
                maxConsecutiveParseRepairs: Int = 1,
                maxRepeatedIdenticalToolCalls: Int = 1,
                turnDeadline: TimeInterval = 60,
                modelRequestTimeout: TimeInterval = 30,
                toolExecutionTimeout: TimeInterval = 8,
                streamIdleTimeout: TimeInterval = 10,
                decisionRepairTimeout: TimeInterval = 10,
                maxObservationCharacters: Int = 2_048) {
        self.maxIterations = max(1, maxIterations)
        self.maxToolCalls = max(0, maxToolCalls)
        self.maxConsecutiveParseRepairs = max(0, maxConsecutiveParseRepairs)
        self.maxRepeatedIdenticalToolCalls = max(0, maxRepeatedIdenticalToolCalls)
        self.turnDeadline = max(0.1, turnDeadline)
        self.modelRequestTimeout = min(max(0.1, modelRequestTimeout), max(0.1, self.turnDeadline - 0.1))
        self.toolExecutionTimeout = min(max(0.1, toolExecutionTimeout), max(0.1, self.turnDeadline - 0.1))
        self.streamIdleTimeout = min(max(0.1, streamIdleTimeout), max(0.1, self.turnDeadline - 0.1))
        self.decisionRepairTimeout = min(max(0.1, decisionRepairTimeout), max(0.1, self.turnDeadline - 0.1))
        self.maxObservationCharacters = max(128, maxObservationCharacters)
    }

    public static func forPolicy(_ policy: AgentPolicy) -> AgentLoopLimits {
        AgentLoopLimits(maxIterations: min(4, max(1, policy.maxIterations)),
                        maxToolCalls: min(3, max(0, policy.maxToolCalls)),
                        turnDeadline: min(60, max(0.1, policy.maxWallClock)))
    }
}

public struct AgentLoopDecisionContext: Sendable, Equatable {
    public var agentContext: AgentContext
    public var observations: [AgentToolObservation]
    public var toolCalls: [AgentToolCallRequest]
    public var iteration: Int
    public var repairAttempt: Int

    public init(agentContext: AgentContext, observations: [AgentToolObservation] = [],
                toolCalls: [AgentToolCallRequest] = [],
                iteration: Int = 0, repairAttempt: Int = 0) {
        self.agentContext = agentContext
        self.observations = observations
        self.toolCalls = toolCalls
        self.iteration = iteration
        self.repairAttempt = repairAttempt
    }

    public var legacyContext: AgentContext {
        var context = agentContext
        context.observations = observations.map(\.legacyObservation)
        return context
    }
}

public struct AgentLoopDecisionResult: Sendable, Equatable {
    public var decision: AgentLoopDecision
    public var decisionSource: DecisionSource
    public var providerMetadata: [String: String]
    public var memoryCandidates: [MemoryCandidate]
    public var resultDocument: AgentResultDocument?
    public var resultIssues: [AgentResultValidationIssue]
    public var modelProvider: String
    public var latency: TimeInterval

    public init(decision: AgentLoopDecision, decisionSource: DecisionSource,
                providerMetadata: [String: String] = [:],
                memoryCandidates: [MemoryCandidate] = [],
                resultDocument: AgentResultDocument? = nil,
                resultIssues: [AgentResultValidationIssue] = [],
                modelProvider: String = "local", latency: TimeInterval = 0) {
        self.decision = decision
        self.decisionSource = decisionSource
        self.providerMetadata = AgentPrivacyRedactor.safeMetadata(providerMetadata)
        self.memoryCandidates = memoryCandidates
        self.resultDocument = resultDocument
        self.resultIssues = resultIssues
        self.modelProvider = AgentPrivacyRedactor.safeSummary(modelProvider, fallback: "local")
        self.latency = latency
    }
}

public protocol AgentLoopDecisionProviding: Sendable {
    func decide(context: AgentLoopDecisionContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> AgentLoopDecisionResult
}

public enum AgentLoopRuntimeError: Error, Equatable, Sendable {
    case providerUnavailable
    case providerRequestFailed
    case providerResponseMalformed
    case decisionParseFailed
    case unknownTool
    case invalidToolArguments
    case permissionDenied
    case systemPermissionMissing
    case toolExecutionFailed
    case toolExecutionTimedOut
    case loopLimitReached
    case cancelled
}

public enum AgentLoopDecisionParseError: Error, Equatable, Sendable, CustomStringConvertible {
    case malformedJSON
    case topLevelMustBeObject
    case missingType
    case unsupportedType(String)
    case missingField(String)
    case invalidField(String)
    case invalidArguments
    case unknownField(String)
    case duplicateField
    case payloadTooLarge

    public var description: String {
        switch self {
        case .malformedJSON: return "malformed json"
        case .topLevelMustBeObject: return "top level must be object"
        case .missingType: return "missing type"
        case .unsupportedType(let type): return "unsupported type \(type)"
        case .missingField(let field): return "missing \(field)"
        case .invalidField(let field): return "invalid \(field)"
        case .invalidArguments: return "invalid arguments"
        case .unknownField(let field): return "unknown field \(field)"
        case .duplicateField: return "duplicate field"
        case .payloadTooLarge: return "payload too large"
        }
    }
}

public enum AgentPrivacyRedactor {
    private static let sensitiveKeyFragments = [
        "password", "passwd", "token", "api_key", "apikey", "api-key", "authorization",
        "secret", "keychain", "bearer", "credential"
    ]
    private static let nonSecretStatusKeys: Set<String> = [
        "authorizationstate",
        "systemauthorizationstatus",
    ]
    private static let pathKeyFragments = ["path", "file", "directory", "folder"]

    public static func isSensitiveKey(_ key: String) -> Bool {
        let lowered = key.lowercased()
        if nonSecretStatusKeys.contains(lowered) { return false }
        return sensitiveKeyFragments.contains { lowered.contains($0) }
    }

    public static func isPathKey(_ key: String) -> Bool {
        let lowered = key.lowercased()
        return pathKeyFragments.contains { lowered.contains($0) }
    }

    public static func safeIdentifier(_ raw: String, fallback: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 160,
              trimmed.range(of: #"^[A-Za-z0-9._:-]+$"#, options: .regularExpression) != nil else {
            return fallback
        }
        return trimmed
    }

    public static func safeSummary(_ raw: String, fallback: String) -> String {
        let safe = safeText(raw, maxLength: 80).text
        let lowered = safe.lowercased()
        let forbidden = ["reasoning", "thinking", "analysis", "推理", "思维链", "分析用户", "根据我的推理"]
        if safe.isEmpty || forbidden.contains(where: { lowered.contains($0) || safe.contains($0) }) {
            return fallback
        }
        return safe
    }

    public static func safeText(_ raw: String, maxLength: Int) -> (text: String, truncated: Bool) {
        let sanitized = ModelResponseSanitizer.sanitize(content: raw).visibleText
        var text = sanitized
        text = replace(pattern: #"(?i)bearer\s+[A-Za-z0-9._~+/=-]{8,}"#, in: text, with: "Bearer [redacted]")
        text = replace(pattern: #"(?i)(sk|ak|pk|rk)-[A-Za-z0-9_-]{12,}"#, in: text, with: "[redacted-secret]")
        text = replace(pattern: #"[A-Za-z0-9_-]{32,}"#, in: text, with: "[redacted-token]")
        text = replace(pattern: #"/Users/[^\s,;:]+"#, in: text, with: "[redacted-path]")
        text = replace(pattern: #"/Volumes/[^\s,;:]+"#, in: text, with: "[redacted-path]")
        text = replace(pattern: #"/private/[^\s,;:]+"#, in: text, with: "[redacted-path]")
        text = replace(pattern: #"/tmp/[^\s,;:]+"#, in: text, with: "[redacted-path]")
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.count > maxLength {
            return (String(text.prefix(maxLength)), true)
        }
        return (text, false)
    }

    public static func safeMetadata(_ raw: [String: String]) -> [String: String] {
        var metadata: [String: String] = [:]
        for (key, value) in raw where !isSensitiveKey(key) && !isPathKey(key) {
            let safeKey = safeIdentifier(key, fallback: "")
            guard !safeKey.isEmpty else { continue }
            metadata[safeKey] = safeSummary(value, fallback: "redacted")
        }
        return metadata
    }

    private static func replace(pattern: String, in input: String, with replacement: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return input }
        let range = NSRange(input.startIndex..<input.endIndex, in: input)
        return regex.stringByReplacingMatches(in: input, range: range, withTemplate: replacement)
    }
}
