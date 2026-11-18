import Foundation
import AICore

public struct UntrustedAgentDecisionEnvelope: Decodable, Equatable {
    public let schemaVersion: Int?
    public let kind: String?
    public let response: UntrustedResponse?
    public let clarification: UntrustedClarification?
    public let plan: UntrustedPlan?
    public let delegation: UntrustedDelegation?
    public let decline: UntrustedDecline?
    public let noAction: UntrustedNoAction?
}

public struct UntrustedDelegation: Decodable, Equatable {
    public let goal: String?
    public let allowedCapabilities: [String]?
}

public struct UntrustedResponse: Decodable, Equatable {
    public let text: String?
    public let emotion: String?
}

public struct UntrustedClarification: Decodable, Equatable {
    public let question: String?
}

public struct UntrustedPlan: Decodable, Equatable {
    public let goal: String?
    public let steps: [UntrustedPlanStep]?
}

public struct UntrustedPlanStep: Decodable, Equatable {
    public let id: String?
    public let description: String?
    public let capabilityID: String?
    public let arguments: [String: String]?
}

public struct UntrustedDecline: Decodable, Equatable {
    public let reason: String?
}

public struct UntrustedNoAction: Decodable, Equatable {
    public let reason: String?
}

public enum StructuredDecisionValidationError: Error, Equatable, CustomStringConvertible {
    case rejected([String])

    public var description: String {
        switch self {
        case .rejected(let issues): return issues.joined(separator: "; ")
        }
    }
}

public enum StructuredDecisionValidator {
    public static let schemaVersion = 1
    private static let maxStringLength = 2_048
    private static let maxPlanSteps = 4
    private static let maxArgumentValueLength = 512
    private static let forbiddenKeys = Set([
        "approved", "grant", "grants", "capabilitygrant", "trusted", "executable",
        "execute", "token", "capabilitytoken", "authorization", "permissionbypass",
        "shellcommand", "brokerresult", "toolresult", "executionresult"
    ])

    public static func validate(raw: String,
                                availableCapabilities: CapabilityCatalogSnapshot) throws -> AgentDecision {
        guard let data = raw.data(using: .utf8) else {
            throw StructuredDecisionValidationError.rejected(["raw output is not utf8"])
        }
        let rootObject: Any
        do {
            rootObject = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw StructuredDecisionValidationError.rejected(["malformed json"])
        }
        guard let root = rootObject as? [String: Any] else {
            throw StructuredDecisionValidationError.rejected(["top level must be an object"])
        }

        var issues: [String] = []
        validateTopLevelKeys(root, issues: &issues)
        validateForbiddenKeys(rootObject, path: "$", issues: &issues)
        validatePayloadKeys(root, issues: &issues)

        let envelope: UntrustedAgentDecisionEnvelope
        do {
            envelope = try JSONDecoder().decode(UntrustedAgentDecisionEnvelope.self, from: data)
        } catch {
            issues.append("schema decode failed")
            throw StructuredDecisionValidationError.rejected(issues)
        }

        guard envelope.schemaVersion == schemaVersion else {
            issues.append("unsupported schemaVersion")
            throw StructuredDecisionValidationError.rejected(issues)
        }
        guard let kind = envelope.kind, !kind.isEmpty else {
            issues.append("missing kind")
            throw StructuredDecisionValidationError.rejected(issues)
        }

        let presentPayloads = [
            envelope.response != nil ? "response" : nil,
            envelope.clarification != nil ? "clarification" : nil,
            envelope.plan != nil ? "plan" : nil,
            envelope.delegation != nil ? "delegation" : nil,
            envelope.decline != nil ? "decline" : nil,
            envelope.noAction != nil ? "noAction" : nil
        ].compactMap { $0 }
        guard presentPayloads.count == 1 else {
            issues.append("kind must have exactly one matching payload")
            throw StructuredDecisionValidationError.rejected(issues)
        }

        switch kind {
        case "respond":
            guard let response = envelope.response, presentPayloads == ["response"] else {
                throw StructuredDecisionValidationError.rejected(issues + ["kind/payload mismatch"])
            }
            let text = requireString(response.text, field: "response.text", max: maxStringLength, issues: &issues)
            if !issues.isEmpty { throw StructuredDecisionValidationError.rejected(issues) }
            return .respond(ConversationResponseDecision(text: text,
                                                         emotion: PetEmotion(rawValue: response.emotion ?? "") ?? .neutral))
        case "proposePlan":
            guard let plan = envelope.plan, presentPayloads == ["plan"] else {
                throw StructuredDecisionValidationError.rejected(issues + ["kind/payload mismatch"])
            }
            return try validatePlan(plan, availableCapabilities: availableCapabilities, issues: issues)
        case "delegate":
            guard let delegation = envelope.delegation, presentPayloads == ["delegation"] else {
                throw StructuredDecisionValidationError.rejected(issues + ["kind/payload mismatch"])
            }
            return try validateDelegation(delegation, availableCapabilities: availableCapabilities, issues: issues)
        case "askClarification":
            guard let clarification = envelope.clarification, presentPayloads == ["clarification"] else {
                throw StructuredDecisionValidationError.rejected(issues + ["kind/payload mismatch"])
            }
            var local = issues
            let question = requireString(clarification.question, field: "clarification.question",
                                         max: maxStringLength, issues: &local)
            if !local.isEmpty { throw StructuredDecisionValidationError.rejected(local) }
            return .askClarification(ClarificationDecision(question: question))
        case "decline":
            guard let decline = envelope.decline, presentPayloads == ["decline"] else {
                throw StructuredDecisionValidationError.rejected(issues + ["kind/payload mismatch"])
            }
            var local = issues
            let reason = requireString(decline.reason, field: "decline.reason", max: maxStringLength, issues: &local)
            if !local.isEmpty { throw StructuredDecisionValidationError.rejected(local) }
            return .decline(DeclineDecision(reason: reason))
        case "noAction":
            guard let noAction = envelope.noAction, presentPayloads == ["noAction"] else {
                throw StructuredDecisionValidationError.rejected(issues + ["kind/payload mismatch"])
            }
            return .noAction(NoActionDecision(reason: clipped(noAction.reason ?? "")))
        default:
            throw StructuredDecisionValidationError.rejected(issues + ["unsupported kind"])
        }
    }

    private static func validatePlan(_ plan: UntrustedPlan,
                                     availableCapabilities: CapabilityCatalogSnapshot,
                                     issues inherited: [String]) throws -> AgentDecision {
        var issues = inherited
        let goal = requireString(plan.goal, field: "plan.goal", max: maxStringLength, issues: &issues)
        guard let steps = plan.steps else {
            issues.append("missing plan.steps")
            throw StructuredDecisionValidationError.rejected(issues)
        }
        if steps.isEmpty { issues.append("plan.steps is empty") }
        if steps.count > maxPlanSteps { issues.append("excessive plan steps") }

        var seenIDs = Set<String>()
        var safeSteps: [AgentPlanProposalStep] = []
        for step in steps {
            let id = requireString(step.id, field: "step.id", max: 80, issues: &issues)
            if !id.isEmpty, !seenIDs.insert(id).inserted { issues.append("duplicate step ID") }
            let description = requireString(step.description, field: "step.description", max: 256, issues: &issues)
            let capabilityID = requireString(step.capabilityID, field: "step.capabilityID", max: 160, issues: &issues)
            if capabilityID.isEmpty { issues.append("empty capability ID") }
            if !capabilityID.isEmpty, CapabilityCatalog.lookup(capabilityID) == nil {
                issues.append("unknown capability ID")
            }
            if !capabilityID.isEmpty, !availableCapabilities.contains(capabilityID) {
                issues.append("capability not in current catalog")
            }
            let arguments = step.arguments ?? [:]
            validateArguments(arguments, capabilityID: capabilityID, issues: &issues)
            safeSteps.append(AgentPlanProposalStep(id: id, description: description,
                                                   capabilityID: capabilityID, arguments: arguments))
        }
        if !issues.isEmpty { throw StructuredDecisionValidationError.rejected(issues) }
        return .proposePlan(AgentPlanProposal(goal: goal, steps: safeSteps))
    }

    private static let maxDelegationCapabilities = 8

    private static func validateDelegation(_ delegation: UntrustedDelegation,
                                           availableCapabilities: CapabilityCatalogSnapshot,
                                           issues inherited: [String]) throws -> AgentDecision {
        var issues = inherited
        let goal = requireString(delegation.goal, field: "delegation.goal", max: maxStringLength, issues: &issues)
        guard let caps = delegation.allowedCapabilities else {
            issues.append("missing delegation.allowedCapabilities")
            throw StructuredDecisionValidationError.rejected(issues)
        }
        if caps.isEmpty { issues.append("delegation.allowedCapabilities is empty") }
        if caps.count > maxDelegationCapabilities { issues.append("too many delegated capabilities") }
        var safe: [String] = []
        for cap in caps {
            if CapabilityCatalog.lookup(cap) == nil { issues.append("unknown delegated capability"); continue }
            if !availableCapabilities.contains(cap) { issues.append("delegated capability not in catalog"); continue }
            safe.append(cap)
        }
        if !issues.isEmpty { throw StructuredDecisionValidationError.rejected(issues) }
        return .delegate(DelegationDecision(goal: goal, allowedCapabilities: safe))
    }

    private static func validateTopLevelKeys(_ root: [String: Any], issues: inout [String]) {
        let allowed = Set(["schemaVersion", "kind", "response", "clarification", "plan", "delegation", "decline", "noAction",
                           "memoryCandidates", "resultDocument"])
        let unknown = Set(root.keys).subtracting(allowed)
        if !unknown.isEmpty { issues.append("unknown top-level fields: \(unknown.sorted().joined(separator: ","))") }
    }

    private static func validatePayloadKeys(_ root: [String: Any], issues: inout [String]) {
        checkObjectKeys(root["response"], allowed: ["text", "emotion"], name: "response", issues: &issues)
        checkObjectKeys(root["clarification"], allowed: ["question"], name: "clarification", issues: &issues)
        checkObjectKeys(root["delegation"], allowed: ["goal", "allowedCapabilities"], name: "delegation", issues: &issues)
        checkObjectKeys(root["decline"], allowed: ["reason"], name: "decline", issues: &issues)
        checkObjectKeys(root["noAction"], allowed: ["reason"], name: "noAction", issues: &issues)
        guard let plan = root["plan"] as? [String: Any] else { return }
        checkObjectKeys(plan, allowed: ["goal", "steps"], name: "plan", issues: &issues)
        if let steps = plan["steps"] as? [[String: Any]] {
            for step in steps {
                checkObjectKeys(step, allowed: ["id", "description", "capabilityID", "arguments"],
                                name: "plan.step", issues: &issues)
            }
        }
    }

    private static func checkObjectKeys(_ object: Any?, allowed: Set<String>, name: String,
                                        issues: inout [String]) {
        guard let dictionary = object as? [String: Any] else { return }
        let unknown = Set(dictionary.keys).subtracting(allowed)
        if !unknown.isEmpty { issues.append("unknown \(name) fields: \(unknown.sorted().joined(separator: ","))") }
    }

    private static func validateForbiddenKeys(_ object: Any, path: String, issues: inout [String]) {
        if let dictionary = object as? [String: Any] {
            for (key, value) in dictionary {
                if forbiddenKeys.contains(key.lowercased()) { issues.append("forbidden field \(path).\(key)") }
                validateForbiddenKeys(value, path: "\(path).\(key)", issues: &issues)
            }
        } else if let array = object as? [Any] {
            for value in array { validateForbiddenKeys(value, path: "\(path)[]", issues: &issues) }
        }
    }

    private static let maxOpaqueContentLength = 8_192

    private static func validateArguments(_ arguments: [String: String], capabilityID: String, issues: inout [String]) {
        let allowed: Set<String>
        // Keys whose VALUE is a sandboxed workspace path — validated structurally below instead of the
        // blanket "path"-key ban (which would otherwise reject every filesystem tool).
        var pathKeys: Set<String> = []
        // Keys carrying opaque payload (file content): length-capped only, not safety-swept.
        var opaqueKeys: Set<String> = []

        switch capabilityID {
        case "reminders.create", "reminder.local.create":
            allowed = ["title", "resolvedDate", "timezone", "notes"]
            requireArguments(["title", "resolvedDate", "timezone"], in: arguments, issues: &issues)
            validateISO8601Date(arguments["resolvedDate"], issues: &issues)
            validateTimezone(arguments["timezone"], issues: &issues)
        case "calendar.event.create":
            allowed = ["title", "startDate", "endDate", "timezone", "notes"]
            requireArguments(["title", "startDate"], in: arguments, issues: &issues)
            validateISO8601Date(arguments["startDate"], issues: &issues)
            validateISO8601Date(arguments["endDate"], issues: &issues)
            validateTimezone(arguments["timezone"], issues: &issues)
        case "timer.local":
            allowed = ["title", "durationSeconds", "notes"]
            requireArguments(["durationSeconds"], in: arguments, issues: &issues)
            validatePositiveInteger(arguments["durationSeconds"], field: "durationSeconds", issues: &issues)
        case "application.launch":
            allowed = ["appName", "bundleIdentifier"]
            if arguments["appName"] == nil && arguments["bundleIdentifier"] == nil {
                issues.append("missing application identifier")
            }
        case "schedule.create":
            allowed = ["title", "prompt", "scheduleKind", "seconds", "hour", "minute", "date"]
            opaqueKeys = ["prompt"]   // natural-language instruction; not safety-swept, only length-capped
            requireArguments(["title", "prompt", "scheduleKind"], in: arguments, issues: &issues)
            switch arguments["scheduleKind"] {
            case "everySeconds":
                requireArguments(["seconds"], in: arguments, issues: &issues)
                validatePositiveInteger(arguments["seconds"], field: "seconds", issues: &issues)
            case "dailyAt":
                validateHourMinute(arguments["hour"], arguments["minute"], issues: &issues)
            case "oneShot":
                validateISO8601Date(arguments["date"], issues: &issues)
                if (arguments["date"] ?? "").isEmpty { issues.append("missing date") }
            case .some, .none:
                issues.append("invalid scheduleKind")
            }
        case "network.fetch":
            allowed = ["url", "maxBytes"]
            requireArguments(["url"], in: arguments, issues: &issues)
            validateHTTPSURL(arguments["url"], issues: &issues)
            if arguments["maxBytes"] != nil {
                validatePositiveInteger(arguments["maxBytes"], field: "maxBytes", issues: &issues)
            }
        case "network.search":
            allowed = ["query"]
            requireArguments(["query"], in: arguments, issues: &issues)
        case "filesystem.workspace.read":
            allowed = ["path"]
            pathKeys = ["path"]
            requireArguments(["path"], in: arguments, issues: &issues)
            validateWorkspacePath(arguments["path"], issues: &issues)
        case "filesystem.workspace.write":
            allowed = ["path", "content"]
            pathKeys = ["path"]
            opaqueKeys = ["content"]
            requireArguments(["path"], in: arguments, issues: &issues)
            validateWorkspacePath(arguments["path"], issues: &issues)
        default:
            allowed = []
        }
        let unknown = Set(arguments.keys).subtracting(allowed)
        if !unknown.isEmpty { issues.append("unknown capability arguments") }
        for (key, value) in arguments {
            if opaqueKeys.contains(key) {
                if value.count > maxOpaqueContentLength { issues.append("argument value too long") }
                continue
            }
            if !pathKeys.contains(key) {
                if key.localizedCaseInsensitiveContains("path") ||
                    key.localizedCaseInsensitiveContains("command") ||
                    key.localizedCaseInsensitiveContains("executable") {
                    issues.append("dangerous argument key")
                }
            }
            if value.count > maxArgumentValueLength { issues.append("argument value too long") }
            let lowered = value.lowercased()
            if lowered.contains("rm -rf") || lowered.contains("shell.execute") || lowered.contains("/etc/") {
                issues.append("dangerous argument value")
            }
            // Traversal markers stay banned everywhere EXCEPT validated workspace path keys (the
            // structural check above already rejects `..`/absolute/`~` for those).
            if !pathKeys.contains(key), lowered.contains("../") || value.contains("~") {
                issues.append("dangerous argument value")
            }
        }
    }

    private static func validateHTTPSURL(_ value: String?, issues: inout [String]) {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if !FetchTargetValidator.isAcceptable(value) { issues.append("invalid or blocked url") }
    }

    private static func validateWorkspacePath(_ value: String?, issues: inout [String]) {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if WorkspacePathResolver.isStructurallyUnsafe(value) { issues.append("unsafe workspace path") }
    }

    private static func validateISO8601Date(_ value: String?, issues: inout [String]) {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if formatter.date(from: value) != nil { return }
        formatter.formatOptions = [.withInternetDateTime]
        if formatter.date(from: value) == nil { issues.append("invalid resolvedDate") }
    }

    private static func validateTimezone(_ value: String?, issues: inout [String]) {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if TimeZone(identifier: value) == nil { issues.append("invalid timezone") }
    }

    private static func validateHourMinute(_ hour: String?, _ minute: String?, issues: inout [String]) {
        guard let h = hour.flatMap(Int.init), (0...23).contains(h) else { issues.append("invalid hour"); return }
        guard let m = minute.flatMap(Int.init), (0...59).contains(m) else { issues.append("invalid minute"); return }
    }

    private static func validatePositiveInteger(_ value: String?, field: String, issues: inout [String]) {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard let parsed = Int(value), parsed > 0 else {
            issues.append("invalid \(field)")
            return
        }
    }

    private static func requireArguments(_ required: [String], in arguments: [String: String],
                                         issues: inout [String]) {
        for key in required where (arguments[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            issues.append("missing required argument \(key)")
        }
    }

    private static func requireString(_ value: String?, field: String, max: Int, issues: inout [String]) -> String {
        guard let value else {
            issues.append("missing \(field)")
            return ""
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { issues.append("empty \(field)") }
        if value.count > max { issues.append("oversized \(field)") }
        return clipped(trimmed, max: max)
    }

    private static func clipped(_ value: String, max: Int = maxStringLength) -> String {
        value.count <= max ? value : String(value.prefix(max))
    }
}

public struct RawStructuredDecisionProvider: StructuredDecisionProviding {
    public var modelProvider: String
    public var rawOutput: @Sendable (AgentContext, CapabilityCatalogSnapshot) async throws -> String
    public init(modelProvider: String = "raw-json",
                rawOutput: @escaping @Sendable (AgentContext, CapabilityCatalogSnapshot) async throws -> String) {
        self.modelProvider = modelProvider
        self.rawOutput = rawOutput
    }

    public func decide(context: AgentContext,
                       availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        let started = Date()
        let raw = try await rawOutput(context, availableCapabilities)
        do {
            let decision = try StructuredDecisionValidator.validate(raw: raw,
                                                                    availableCapabilities: availableCapabilities)
            let supplements = StructuredDecisionSupplementParser.parse(
                raw: raw,
                toolCatalog: availableCapabilities.toolCatalog)
            return StructuredDecisionResult(decision: decision, decisionSource: .modelStructured,
                                            validationResult: .valid,
                                            memoryCandidates: supplements.memoryCandidates,
                                            resultDocument: supplements.resultDocument,
                                            resultIssues: supplements.resultIssues,
                                            modelProvider: modelProvider,
                                            latency: Date().timeIntervalSince(started))
        } catch let error as StructuredDecisionValidationError {
            let reason = error.description
            return StructuredDecisionResult(
                decision: .respond(ConversationResponseDecision(text: "我不能可靠验证这个操作，先不执行。",
                                                                emotion: .neutral)),
                decisionSource: .deterministicFallback,
                validationResult: .rejected([reason]),
                fallbackReason: reason,
                modelProvider: modelProvider,
                latency: Date().timeIntervalSince(started))
        }
    }
}
