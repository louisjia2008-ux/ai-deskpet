import Foundation
import AICore

public enum TaskPlanParseError: Error, Sendable, Equatable {
    case malformedJSON
    case topLevelMustBeObject
    case duplicateField
    case unknownField(String)
    case missingField(String)
    case invalidField(String)
    case forbiddenField(String)
    case payloadTooLarge
}

public enum TaskPlanParser {
    public static func parse(raw: String,
                             limits: PlannerLimits = PlannerLimits()) throws -> RawTaskPlan {
        let normalized = try normalize(raw: raw, limits: limits)
        guard !containsDuplicateObjectKeys(normalized) else {
            throw TaskPlanParseError.duplicateField
        }
        let data = Data(normalized.utf8)
        let rootObject: Any
        do {
            rootObject = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw TaskPlanParseError.malformedJSON
        }
        guard let root = rootObject as? [String: Any] else {
            throw TaskPlanParseError.topLevelMustBeObject
        }
        try validateShape(root)
        do {
            return try JSONDecoder().decode(RawTaskPlan.self, from: data)
        } catch {
            throw TaskPlanParseError.malformedJSON
        }
    }

    public static func normalize(raw: String,
                                 limits: PlannerLimits = PlannerLimits()) throws -> String {
        let visible = ModelResponseSanitizer.sanitize(content: raw).visibleText
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !visible.isEmpty else {
            throw TaskPlanParseError.malformedJSON
        }
        guard visible.utf8.count <= limits.maxPlanPayloadBytes else {
            throw TaskPlanParseError.payloadTooLarge
        }
        if visible.hasPrefix("```") {
            guard visible.hasSuffix("```") else {
                throw TaskPlanParseError.malformedJSON
            }
            let lines = visible.components(separatedBy: .newlines)
            guard lines.count >= 3,
                  let first = lines.first?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                  first == "```json" || first == "```",
                  lines.last?.trimmingCharacters(in: .whitespacesAndNewlines) == "```" else {
                throw TaskPlanParseError.malformedJSON
            }
            let body = lines.dropFirst().dropLast().joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard body.first == "{", body.last == "}" else {
                throw TaskPlanParseError.malformedJSON
            }
            return body
        }
        guard visible.first == "{", visible.last == "}" else {
            throw TaskPlanParseError.malformedJSON
        }
        return visible
    }

    private static func validateShape(_ root: [String: Any]) throws {
        let allowed = Set(["goal_summary", "steps"])
        let forbidden = Set(["reasoning", "analysis", "thought", "internal_rationale", "prompt", "planner_prompt"])
        for key in root.keys {
            if forbidden.contains(key) { throw TaskPlanParseError.forbiddenField(key) }
            if !allowed.contains(key) { throw TaskPlanParseError.unknownField(key) }
        }
        guard let goal = root["goal_summary"] as? String,
              !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw TaskPlanParseError.missingField("goal_summary")
        }
        guard let steps = root["steps"] as? [[String: Any]] else {
            throw TaskPlanParseError.missingField("steps")
        }
        for step in steps {
            try validateStepShape(step)
        }
    }

    private static func validateStepShape(_ step: [String: Any]) throws {
        let allowed = Set(["id", "title", "tool", "arguments", "depends_on", "user_visible_summary"])
        let forbidden = Set([
            "reasoning", "analysis", "thought", "internal_rationale", "approved", "grant",
            "trusted", "token", "risk", "permission", "policy", "tool_id", "call_id",
        ])
        for key in step.keys {
            if forbidden.contains(key) { throw TaskPlanParseError.forbiddenField(key) }
            if !allowed.contains(key) { throw TaskPlanParseError.unknownField(key) }
        }
        guard (step["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
            throw TaskPlanParseError.missingField("title")
        }
        guard (step["tool"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
            throw TaskPlanParseError.missingField("tool")
        }
        if let depends = step["depends_on"], !(depends is [String]) {
            throw TaskPlanParseError.invalidField("depends_on")
        }
        if let arguments = step["arguments"], !(arguments is [String: Any]) {
            throw TaskPlanParseError.invalidField("arguments")
        }
    }

    static func containsDuplicateObjectKeys(_ raw: String) -> Bool {
        var stack: [Set<String>] = []
        var expectingObjectKey: [Bool] = []
        var isString = false
        var escaping = false
        var buffer = ""
        var lastString: String?

        for scalar in raw.unicodeScalars {
            let char = Character(scalar)
            if isString {
                if escaping {
                    buffer.append(char)
                    escaping = false
                } else if char == "\\" {
                    escaping = true
                } else if char == "\"" {
                    isString = false
                    lastString = buffer
                    buffer = ""
                } else {
                    buffer.append(char)
                }
                continue
            }

            switch char {
            case "\"":
                isString = true
                buffer = ""
            case "{":
                stack.append([])
                expectingObjectKey.append(true)
                lastString = nil
            case "}":
                _ = stack.popLast()
                _ = expectingObjectKey.popLast()
                lastString = nil
            case ":":
                guard let key = lastString, expectingObjectKey.last == true else {
                    lastString = nil
                    continue
                }
                let current = stack.count - 1
                if stack[current].contains(key) { return true }
                stack[current].insert(key)
                expectingObjectKey[current] = false
                lastString = nil
            case ",":
                if !expectingObjectKey.isEmpty {
                    expectingObjectKey[expectingObjectKey.count - 1] = true
                }
                lastString = nil
            default:
                if !char.isWhitespace { lastString = nil }
            }
        }
        return false
    }
}

public enum TaskPlanValidator {
    public static func validate(_ raw: RawTaskPlan,
                                snapshot: ToolCatalogSnapshot,
                                createdAt: Date,
                                limits: PlannerLimits = PlannerLimits(),
                                id: TaskPlanID = TaskPlanID(rawValue: "plan-\(UUID().uuidString)")) throws -> ValidatedTaskPlan {
        guard raw.steps.count >= 2 else {
            throw PlanError.planValidationFailed(.tooFewSteps)
        }
        guard raw.steps.count <= limits.maxPlanSteps else {
            throw PlanError.planValidationFailed(.tooManySteps)
        }

        let goal = safePlanText(raw.goalSummary, maxLength: limits.maxGoalSummaryCharacters, fallback: "执行多步骤任务")
        var rawIDs = Set<String>()
        var rawToCanonical: [String: TaskPlanStepID] = [:]
        for (index, rawStep) in raw.steps.enumerated() {
            let canonical = TaskPlanStepID(rawValue: "step_\(index + 1)")
            rawToCanonical[canonical.rawValue] = canonical
            if let rawID = rawStep.id, !rawID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let safeID = AgentPrivacyRedactor.safeIdentifier(rawID, fallback: "")
                guard !safeID.isEmpty else {
                    throw PlanError.planValidationFailed(.duplicateStep)
                }
                guard rawIDs.insert(safeID).inserted else {
                    throw PlanError.planValidationFailed(.duplicateStep)
                }
                rawToCanonical[safeID] = canonical
            }
        }

        var steps: [TaskPlanStep] = []
        var stepRisks: [TaskPlanStepID: ToolRiskLevel] = [:]
        var highestRisk: ToolRiskLevel = .localReadOnlyNoPrivateData
        var containsPrivateData = false
        var fingerprints = Set<String>()

        for (index, rawStep) in raw.steps.enumerated() {
            let stepID = TaskPlanStepID(rawValue: "step_\(index + 1)")
            guard let entry = snapshot.lookup(rawStep.tool) else {
                throw PlanError.unknownTool(rawStep.tool.rawValue)
            }
            guard entry.enabled, entry.manifest.availability == .available else {
                throw PlanError.toolDisabled(entry.manifest.id.rawValue)
            }
            guard isPlannerSupported(entry.manifest.riskLevel) else {
                throw PlanError.unsupportedRisk(entry.manifest.id.rawValue)
            }
            let validation = ToolSchemaValidator.validate(rawStep.arguments,
                                                          against: entry.manifest.inputSchema)
            guard validation.accepted else {
                throw PlanError.invalidArguments(entry.manifest.id.rawValue)
            }
            let dependencies = try rawStep.dependsOn.map { dependency in
                guard let canonical = rawToCanonical[dependency] else {
                    throw PlanError.invalidDependency(dependency)
                }
                guard let dependencyIndex = stepIndex(canonical),
                      dependencyIndex < index + 1 else {
                    throw PlanError.invalidDependency(dependency)
                }
                return canonical
            }
            let title = safePlanText(rawStep.title,
                                     maxLength: limits.maxStepTitleCharacters,
                                     fallback: entry.manifest.displayName)
            let summary = safePlanText(rawStep.userVisibleSummary ?? rawStep.title,
                                       maxLength: limits.maxVisibleSummaryCharacters,
                                       fallback: entry.manifest.userVisibleExecutionSummary)
            let step = TaskPlanStep(id: stepID,
                                    ordinal: index + 1,
                                    title: title,
                                    toolID: entry.manifest.id,
                                    arguments: rawStep.arguments,
                                    dependsOn: dependencies,
                                    userVisibleSummary: summary)
            guard fingerprints.insert(step.fingerprint).inserted else {
                throw PlanError.planValidationFailed(.duplicateFingerprint)
            }
            steps.append(step)
            stepRisks[stepID] = entry.manifest.riskLevel
            highestRisk = max(highestRisk, normalizedRisk(entry.manifest.riskLevel))
            if normalizedRisk(entry.manifest.riskLevel) == .privateDataReadOnly {
                containsPrivateData = true
            }
        }

        try ensureAcyclic(steps)
        let approval = TaskPlanApprovalPolicy.requirement(highestRisk: highestRisk,
                                                          containsPrivateDataRead: containsPrivateData)
        guard approval != .blocked else {
            throw PlanError.planValidationFailed(.approvalPolicyViolation)
        }

        let plan = TaskPlan(
            id: id,
            version: 1,
            goalSummary: goal,
            steps: steps,
            riskSummary: TaskPlanRiskSummary(highestRisk: highestRisk,
                                             containsPrivateDataRead: containsPrivateData,
                                             stepRisks: stepRisks),
            approvalRequirement: approval,
            createdAt: createdAt,
            toolCatalogRevision: catalogRevision(snapshot))
        return ValidatedTaskPlan(plan: plan,
                                 toolCatalogSnapshot: snapshot,
                                 plannerLimits: limits)
    }

    public static func singleToolFallback(from raw: RawTaskPlan) -> AgentToolCallRequest? {
        guard raw.steps.count == 1, let step = raw.steps.first else { return nil }
        return AgentToolCallRequest(callID: "\(step.id ?? "plan_step_1")-\(step.tool.rawValue)",
                                    toolName: step.tool.rawValue,
                                    arguments: step.arguments,
                                    userVisibleSummary: step.userVisibleSummary ?? step.title)
    }

    static func catalogRevision(_ snapshot: ToolCatalogSnapshot) -> String {
        let ids = snapshot.entries.map {
            "\($0.manifest.id.rawValue):\($0.manifest.version):\($0.enabled ? "1" : "0")"
        }.joined(separator: ",")
        return "catalog-\(abs(ids.hashValue))"
    }

    static func normalizedRisk(_ risk: ToolRiskLevel) -> ToolRiskLevel {
        switch risk {
        case .safe:
            return .localReadOnlyNoPrivateData
        case .sensitive:
            return .privateDataReadOnly
        case .highRisk:
            return .destructiveOrSensitiveWrite
        default:
            return risk
        }
    }

    private static func isPlannerSupported(_ risk: ToolRiskLevel) -> Bool {
        switch normalizedRisk(risk) {
        case .localReadOnlyNoPrivateData, .privateDataReadOnly, .externalReadOnly:
            return true
        case .externalSideEffectReversible, .destructiveOrSensitiveWrite, .unknown, .safe, .sensitive, .highRisk:
            return false
        }
    }

    private static func stepIndex(_ stepID: TaskPlanStepID) -> Int? {
        let raw = stepID.rawValue
        guard raw.hasPrefix("step_"),
              let value = Int(raw.dropFirst("step_".count)) else { return nil }
        return value
    }

    private static func safePlanText(_ raw: String, maxLength: Int, fallback: String) -> String {
        let safe = AgentPrivacyRedactor.safeSummary(raw, fallback: fallback)
        if safe.count > maxLength {
            return String(safe.prefix(maxLength))
        }
        return safe
    }

    private static func ensureAcyclic(_ steps: [TaskPlanStep]) throws {
        let ids = Set(steps.map(\.id))
        for step in steps {
            for dependency in step.dependsOn where !ids.contains(dependency) {
                throw PlanError.planValidationFailed(.invalidDependency)
            }
        }
        var visiting = Set<TaskPlanStepID>()
        var visited = Set<TaskPlanStepID>()
        let byID = Dictionary(uniqueKeysWithValues: steps.map { ($0.id, $0) })

        func visit(_ id: TaskPlanStepID) throws {
            if visited.contains(id) { return }
            if visiting.contains(id) {
                throw PlanError.planValidationFailed(.cyclicDependency)
            }
            visiting.insert(id)
            for dependency in byID[id]?.dependsOn ?? [] {
                try visit(dependency)
            }
            visiting.remove(id)
            visited.insert(id)
        }

        for step in steps {
            try visit(step.id)
        }
    }
}

public enum TaskPlanApprovalPolicy {
    public static func requirement(highestRisk: ToolRiskLevel,
                                   containsPrivateDataRead: Bool) -> PlanApprovalRequirement {
        switch TaskPlanValidator.normalizedRisk(highestRisk) {
        case .localReadOnlyNoPrivateData:
            return containsPrivateDataRead ? .userApproval : .none
        case .privateDataReadOnly, .externalReadOnly:
            return .userApproval
        case .externalSideEffectReversible, .destructiveOrSensitiveWrite, .unknown, .safe, .sensitive, .highRisk:
            return .blocked
        }
    }
}
