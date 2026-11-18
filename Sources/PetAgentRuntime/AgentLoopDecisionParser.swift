import Foundation
import AICore
import PetBrainCore

public enum AgentLoopDecisionParser {
    private static let maxDecisionPayloadCharacters = 16_384

    public static func parse(raw: String,
                             decisionSource: DecisionSource = .modelStructured,
                             modelProvider: String = "json-fallback") throws -> AgentLoopDecisionResult {
        let visible = try normalizeDecisionEnvelope(raw)
        guard let data = visible.data(using: .utf8) else {
            throw AgentLoopDecisionParseError.malformedJSON
        }
        guard !containsDuplicateObjectKeys(visible) else {
            throw AgentLoopDecisionParseError.duplicateField
        }
        let rootObject: Any
        do {
            rootObject = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw AgentLoopDecisionParseError.malformedJSON
        }
        guard let root = rootObject as? [String: Any] else {
            throw AgentLoopDecisionParseError.topLevelMustBeObject
        }
        guard let rawType = root["type"] as? String else {
            throw AgentLoopDecisionParseError.missingType
        }
        switch rawType {
        case "final":
            try rejectUnknownFields(root, allowed: ["type", "text", "finish_reason", "provider_metadata"])
            guard let text = root["text"] as? String else {
                throw AgentLoopDecisionParseError.missingField("text")
            }
            let finishReason = root["finish_reason"] as? String ?? "stop"
            let metadata = stringMetadata(root["provider_metadata"])
            return AgentLoopDecisionResult(
                decision: .finalResponse(AgentFinalResponse(text: text,
                                                            finishReason: finishReason,
                                                            providerMetadata: metadata)),
                decisionSource: decisionSource,
                providerMetadata: metadata,
                modelProvider: modelProvider)

        case "tool_call":
            try rejectUnknownFields(root, allowed: ["type", "call_id", "tool", "arguments", "user_visible_summary"])
            guard let callID = root["call_id"] as? String else {
                throw AgentLoopDecisionParseError.missingField("call_id")
            }
            guard let toolName = root["tool"] as? String else {
                throw AgentLoopDecisionParseError.missingField("tool")
            }
            guard let argumentObject = root["arguments"] as? [String: Any] else {
                throw AgentLoopDecisionParseError.invalidArguments
            }
            let arguments = try AgentJSONValue.fromJSONObject(argumentObject)
            _ = try arguments.stringArguments()
            let summary = root["user_visible_summary"] as? String ?? "正在处理"
            return AgentLoopDecisionResult(
                decision: .toolCall(AgentToolCallRequest(callID: callID,
                                                         toolName: toolName,
                                                         arguments: arguments,
                                                         userVisibleSummary: summary)),
                decisionSource: decisionSource,
                modelProvider: modelProvider)

        case "propose_plan", "plan":
            try rejectUnknownFields(root, allowed: ["type", "goal_summary", "steps"])
            var planObject = root
            planObject.removeValue(forKey: "type")
            let data = try JSONSerialization.data(withJSONObject: planObject)
            guard let raw = String(data: data, encoding: .utf8) else {
                throw AgentLoopDecisionParseError.malformedJSON
            }
            let plan: RawTaskPlan
            do {
                plan = try TaskPlanParser.parse(raw: raw)
            } catch {
                throw AgentLoopDecisionParseError.malformedJSON
            }
            if let request = TaskPlanValidator.singleToolFallback(from: plan) {
                return AgentLoopDecisionResult(decision: .toolCall(request),
                                               decisionSource: decisionSource,
                                               modelProvider: modelProvider)
            }
            return AgentLoopDecisionResult(decision: .proposePlan(plan),
                                           decisionSource: decisionSource,
                                           modelProvider: modelProvider)

        default:
            throw AgentLoopDecisionParseError.unsupportedType(rawType)
        }
    }

    public static func normalizeDecisionEnvelope(_ raw: String) throws -> String {
        let visible = ModelResponseSanitizer.sanitize(content: raw).visibleText
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !visible.isEmpty else {
            throw AgentLoopDecisionParseError.malformedJSON
        }
        guard visible.count <= maxDecisionPayloadCharacters else {
            throw AgentLoopDecisionParseError.payloadTooLarge
        }
        if visible.hasPrefix("```") {
            guard visible.hasSuffix("```") else {
                throw AgentLoopDecisionParseError.malformedJSON
            }
            let lines = visible.components(separatedBy: .newlines)
            guard lines.count >= 3,
                  let first = lines.first?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                  first == "```json" || first == "```",
                  lines.last?.trimmingCharacters(in: .whitespacesAndNewlines) == "```" else {
                throw AgentLoopDecisionParseError.malformedJSON
            }
            let body = lines.dropFirst().dropLast().joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard body.first == "{", body.last == "}" else {
                throw AgentLoopDecisionParseError.malformedJSON
            }
            return body
        }
        guard visible.first == "{", visible.last == "}" else {
            throw AgentLoopDecisionParseError.malformedJSON
        }
        return visible
    }

    private static func rejectUnknownFields(_ root: [String: Any], allowed: Set<String>) throws {
        for key in root.keys where !allowed.contains(key) {
            if ["reasoning", "reasoning_content", "thinking", "thought", "analysis"].contains(key) {
                continue
            }
            throw AgentLoopDecisionParseError.unknownField(key)
        }
    }

    private static func stringMetadata(_ raw: Any?) -> [String: String] {
        guard let raw = raw as? [String: Any] else { return [:] }
        var out: [String: String] = [:]
        for (key, value) in raw {
            if let value = value as? String {
                out[key] = value
            } else if let value = value as? NSNumber {
                out[key] = value.stringValue
            }
        }
        return out
    }

    private static func containsDuplicateObjectKeys(_ raw: String) -> Bool {
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

public struct RawAgentLoopDecisionProvider: AgentLoopDecisionProviding {
    public typealias RawProvider = @Sendable (AgentLoopDecisionContext, CapabilityCatalogSnapshot) async throws -> String
    private let modelProvider: String
    private let rawProvider: RawProvider

    public init(modelProvider: String = "json-fallback", rawProvider: @escaping RawProvider) {
        self.modelProvider = modelProvider
        self.rawProvider = rawProvider
    }

    public func decide(context: AgentLoopDecisionContext,
                       availableCapabilities: CapabilityCatalogSnapshot) async throws -> AgentLoopDecisionResult {
        let raw = try await rawProvider(context, availableCapabilities)
        do {
            return try AgentLoopDecisionParser.parse(raw: raw,
                                                     decisionSource: .modelStructured,
                                                     modelProvider: modelProvider)
        } catch {
            throw AgentLoopRuntimeError.providerResponseMalformed
        }
    }
}

public struct StructuredAgentLoopDecisionAdapter: AgentLoopDecisionProviding {
    private let provider: any StructuredDecisionProviding

    public init(provider: any StructuredDecisionProviding) {
        self.provider = provider
    }

    public func decide(context: AgentLoopDecisionContext,
                       availableCapabilities: CapabilityCatalogSnapshot) async throws -> AgentLoopDecisionResult {
        let result = try await provider.decide(context: context.legacyContext,
                                               availableCapabilities: availableCapabilities)
        return Self.map(result)
    }

    public static func map(_ result: StructuredDecisionResult) -> AgentLoopDecisionResult {
        var metadata = [
            "schemaVersion": "\(result.schemaVersion)",
            "validation": result.validationResult.accepted ? "accepted" : "rejected",
        ]
        if !result.resultIssues.isEmpty {
            metadata["resultValidationIssues"] = "\(result.resultIssues.count)"
        }
        return AgentLoopDecisionResult(decision: mapDecision(result.decision),
                                       decisionSource: result.decisionSource,
                                       providerMetadata: metadata,
                                       memoryCandidates: result.memoryCandidates,
                                       resultDocument: result.resultDocument,
                                       resultIssues: result.resultIssues,
                                       modelProvider: result.modelProvider,
                                       latency: result.latency)
    }

    public static func mapDecision(_ decision: AgentDecision) -> AgentLoopDecision {
        switch decision {
        case .respond(let response):
            return .finalResponse(AgentFinalResponse(text: response.text,
                                                     finishReason: "stop",
                                                     providerMetadata: ["emotion": response.emotion.rawValue]))
        case .proposePlan(let proposal):
            guard let first = proposal.steps.first else {
                return .finalResponse(AgentFinalResponse(text: "", finishReason: "empty_plan"))
            }
            guard proposal.steps.count > 1 else {
                let args = AgentJSONValue.object(first.arguments.mapValues { .string($0) })
                let toolName = first.toolID ?? first.capabilityID
                let callID = "\(first.id)-\(toolName)"
                return .toolCall(AgentToolCallRequest(callID: callID,
                                                      toolName: toolName,
                                                      arguments: args,
                                                      userVisibleSummary: first.description))
            }
            return .proposePlan(RawTaskPlan(
                goalSummary: proposal.goal,
                steps: proposal.steps.map {
                    let toolName = $0.toolID ?? $0.capabilityID
                    return RawTaskPlanStep(id: $0.id,
                                           title: $0.description,
                                           tool: ToolID(rawValue: toolName),
                                           arguments: .object($0.arguments.mapValues { .string($0) }),
                                           dependsOn: [],
                                           userVisibleSummary: $0.description)
                }))
        case .askClarification(let clarification):
            return .finalResponse(AgentFinalResponse(text: clarification.question,
                                                     finishReason: "clarification"))
        case .decline(let decline):
            return .finalResponse(AgentFinalResponse(text: decline.reason,
                                                     finishReason: "decline"))
        case .noAction(let noAction):
            return .finalResponse(AgentFinalResponse(text: noAction.reason,
                                                     finishReason: "no_action"))
        case .delegate(let delegation):
            return .finalResponse(AgentFinalResponse(
                text: "这个请求需要子任务委托，本轮单 Agent 工具闭环先不展开：\(delegation.goal)",
                finishReason: "delegation_not_in_p3_loop"))
        }
    }
}
