import Foundation
import AICore

public struct ToolID: RawRepresentable, Codable, Sendable, Hashable, Comparable, ExpressibleByStringLiteral {
    public var rawValue: String

    public init(rawValue: String) {
        self.rawValue = AgentPrivacyRedactor.safeIdentifier(rawValue, fallback: "unknown_tool")
    }

    public init(stringLiteral value: StringLiteralType) {
        self.init(rawValue: value)
    }

    public static func < (lhs: ToolID, rhs: ToolID) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

public enum ToolCategory: String, Codable, Sendable, Hashable, CaseIterable {
    case utility
    case system
    case location
    case places
    case applications
    case calendar
    case reminders
    case files
    case browser
    case communication
    case developer
    case desktopAutomation
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ToolCategory(rawValue: raw) ?? .unknown
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var displayName: String {
        switch self {
        case .utility: return "实用工具"
        case .system: return "系统"
        case .location: return "位置"
        case .places: return "地点"
        case .applications: return "应用"
        case .calendar: return "日历"
        case .reminders: return "提醒事项"
        case .files: return "文件"
        case .browser: return "浏览器"
        case .communication: return "通讯"
        case .developer: return "开发者"
        case .desktopAutomation: return "桌面自动化"
        case .unknown: return "未知"
        }
    }
}

public enum ToolRiskLevel: Sendable, Codable, Hashable, Comparable {
    case localReadOnlyNoPrivateData
    case privateDataReadOnly
    case externalReadOnly
    case externalSideEffectReversible
    case destructiveOrSensitiveWrite
    case unknown
    @available(*, deprecated, message: "Use P4-A explicit risk levels instead.")
    case safe
    @available(*, deprecated, message: "Use P4-A explicit risk levels instead.")
    case sensitive
    @available(*, deprecated, message: "Use P4-A explicit risk levels instead.")
    case highRisk

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        switch raw {
        case "localReadOnlyNoPrivateData", "p0", "P0", "safe":
            self = .localReadOnlyNoPrivateData
        case "privateDataReadOnly", "p1", "P1", "sensitive":
            self = .privateDataReadOnly
        case "externalReadOnly", "externalReadOnlyData":
            self = .externalReadOnly
        case "externalSideEffectReversible", "p2", "P2":
            self = .externalSideEffectReversible
        case "destructiveOrSensitiveWrite", "p3", "P3", "highRisk":
            self = .destructiveOrSensitiveWrite
        default:
            self = .unknown
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawStorageValue)
    }

    private var rank: Int {
        switch self {
        case .safe, .localReadOnlyNoPrivateData: return 0
        case .sensitive, .privateDataReadOnly: return 1
        case .externalReadOnly: return 2
        case .externalSideEffectReversible: return 3
        case .highRisk, .destructiveOrSensitiveWrite: return 4
        case .unknown: return 5
        }
    }

    public static func < (lhs: ToolRiskLevel, rhs: ToolRiskLevel) -> Bool {
        lhs.rank < rhs.rank
    }

    public var displayName: String {
        switch self {
        case .safe, .localReadOnlyNoPrivateData: return "P0 本地只读"
        case .sensitive, .privateDataReadOnly: return "P1 私人数据只读"
        case .externalReadOnly: return "P3 外部只读"
        case .externalSideEffectReversible: return "P2 可逆外部影响"
        case .highRisk, .destructiveOrSensitiveWrite: return "P3 敏感写入"
        case .unknown: return "未知风险"
        }
    }

    private var rawStorageValue: String {
        switch self {
        case .safe, .localReadOnlyNoPrivateData: return "localReadOnlyNoPrivateData"
        case .sensitive, .privateDataReadOnly: return "privateDataReadOnly"
        case .externalReadOnly: return "externalReadOnly"
        case .externalSideEffectReversible: return "externalSideEffectReversible"
        case .highRisk, .destructiveOrSensitiveWrite: return "destructiveOrSensitiveWrite"
        case .unknown: return "unknown"
        }
    }
}

public enum SystemPermissionKind: String, Codable, Sendable, Hashable {
    case calendarEvents
}

public enum ToolPermissionRequirement: Codable, Sendable, Hashable {
    case none
    case capability(String)
    case systemPermission(SystemPermissionKind)
    case capabilityAndSystemPermission(capabilityID: String, systemPermission: SystemPermissionKind)

    private enum CodingKeys: String, CodingKey {
        case kind
        case capabilityID
        case systemPermission
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "none":
            self = .none
        case "capability":
            self = .capability(try container.decode(String.self, forKey: .capabilityID))
        case "systemPermission":
            self = .systemPermission(try container.decode(SystemPermissionKind.self, forKey: .systemPermission))
        case "capabilityAndSystemPermission":
            self = .capabilityAndSystemPermission(
                capabilityID: try container.decode(String.self, forKey: .capabilityID),
                systemPermission: try container.decode(SystemPermissionKind.self, forKey: .systemPermission))
        default:
            self = .none
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .none:
            try container.encode("none", forKey: .kind)
        case .capability(let capabilityID):
            try container.encode("capability", forKey: .kind)
            try container.encode(capabilityID, forKey: .capabilityID)
        case .systemPermission(let permission):
            try container.encode("systemPermission", forKey: .kind)
            try container.encode(permission, forKey: .systemPermission)
        case .capabilityAndSystemPermission(let capabilityID, let permission):
            try container.encode("capabilityAndSystemPermission", forKey: .kind)
            try container.encode(capabilityID, forKey: .capabilityID)
            try container.encode(permission, forKey: .systemPermission)
        }
    }

    public var capabilityID: String? {
        switch self {
        case .capability(let id), .capabilityAndSystemPermission(let id, _): return id
        case .none, .systemPermission: return nil
        }
    }

    public var capabilityIDs: [String] {
        capabilityID.map { [$0] } ?? []
    }

    public var systemPermission: SystemPermissionKind? {
        switch self {
        case .systemPermission(let permission), .capabilityAndSystemPermission(_, let permission): return permission
        case .none, .capability: return nil
        }
    }
}

public enum ToolAvailability: String, Codable, Sendable, Hashable {
    case available
    case unavailable
}

public struct ToolExecutionCharacteristics: Codable, Sendable, Hashable {
    public var timeoutSeconds: TimeInterval
    public var maxResultBytes: Int

    public init(timeoutSeconds: TimeInterval = 8, maxResultBytes: Int = 16_384) {
        self.timeoutSeconds = max(0.1, timeoutSeconds)
        self.maxResultBytes = max(512, maxResultBytes)
    }
}

public struct ToolOutputContract: Codable, Sendable, Hashable {
    public var description: String
    public var maxItems: Int?
    public var schema: ToolJSONSchema?

    public init(description: String, maxItems: Int? = nil, schema: ToolJSONSchema? = nil) {
        self.description = AgentPrivacyRedactor.safeSummary(description, fallback: "structured result")
        self.maxItems = maxItems
        self.schema = schema
    }
}

public struct ToolManifest: Codable, Sendable, Hashable {
    public var id: ToolID
    public var version: Int
    public var displayName: String
    public var shortDescription: String
    public var category: ToolCategory
    public var riskLevel: ToolRiskLevel
    public var permissionRequirement: ToolPermissionRequirement
    public var inputSchema: ToolJSONSchema
    public var outputContract: ToolOutputContract
    public var executionCharacteristics: ToolExecutionCharacteristics
    public var userVisibleExecutionSummary: String
    public var availability: ToolAvailability

    public init(id: ToolID,
                version: Int = 1,
                displayName: String,
                shortDescription: String,
                category: ToolCategory,
                riskLevel: ToolRiskLevel,
                permissionRequirement: ToolPermissionRequirement,
                inputSchema: ToolJSONSchema,
                outputContract: ToolOutputContract,
                executionCharacteristics: ToolExecutionCharacteristics = ToolExecutionCharacteristics(),
                userVisibleExecutionSummary: String,
                availability: ToolAvailability = .available) {
        self.id = id
        self.version = max(1, version)
        self.displayName = AgentPrivacyRedactor.safeSummary(displayName, fallback: id.rawValue)
        self.shortDescription = AgentPrivacyRedactor.safeText(shortDescription, maxLength: 240).text
        self.category = category
        self.riskLevel = riskLevel
        self.permissionRequirement = permissionRequirement
        self.inputSchema = inputSchema
        self.outputContract = outputContract
        self.executionCharacteristics = executionCharacteristics
        self.userVisibleExecutionSummary = AgentPrivacyRedactor.safeSummary(userVisibleExecutionSummary,
                                                                            fallback: "正在执行工具")
        self.availability = availability
    }
}

public enum ToolJSONSchemaType: String, Codable, Sendable, Hashable {
    case object
    case string
    case number
    case integer
    case boolean
    case array
}

// P18.3 — U-12 NATURALLY_SENDABLE cleanup. The box only carries a single
// immutable `let value: ToolJSONSchema`, and `ToolJSONSchema` is itself
// declared `Sendable, Codable, Hashable`. The previous `@unchecked Sendable`
// was inherited from the recursive `ToolJSONSchema.items: ToolJSONSchemaBox?`
// self-reference; with this manual `Sendable` we drop the unchecked and let
// the Swift 6 compiler verify the property is Sendable.
public final class ToolJSONSchemaBox: Codable, Sendable, Hashable {
    public let value: ToolJSONSchema

    public init(_ value: ToolJSONSchema) {
        self.value = value
    }

    public init(from decoder: Decoder) throws {
        self.value = try ToolJSONSchema(from: decoder)
    }

    public func encode(to encoder: Encoder) throws {
        try value.encode(to: encoder)
    }

    public static func == (lhs: ToolJSONSchemaBox, rhs: ToolJSONSchemaBox) -> Bool {
        lhs.value == rhs.value
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(value)
    }
}

public struct ToolJSONSchema: Codable, Sendable, Hashable {
    public var type: ToolJSONSchemaType
    public var description: String?
    public var properties: [String: ToolJSONSchema]
    public var required: [String]
    public var items: ToolJSONSchemaBox?
    public var enumValues: [AgentJSONValue]?
    public var minimum: Double?
    public var maximum: Double?
    public var minLength: Int?
    public var maxLength: Int?
    public var minItems: Int?
    public var maxItems: Int?
    public var additionalProperties: Bool

    public init(type: ToolJSONSchemaType,
                description: String? = nil,
                properties: [String: ToolJSONSchema] = [:],
                required: [String] = [],
                items: ToolJSONSchema? = nil,
                enumValues: [AgentJSONValue]? = nil,
                minimum: Double? = nil,
                maximum: Double? = nil,
                minLength: Int? = nil,
                maxLength: Int? = nil,
                minItems: Int? = nil,
                maxItems: Int? = nil,
                additionalProperties: Bool = false) {
        self.type = type
        self.description = description.map { AgentPrivacyRedactor.safeText($0, maxLength: 160).text }
        self.properties = properties
        self.required = required.sorted()
        self.items = items.map(ToolJSONSchemaBox.init)
        self.enumValues = enumValues
        self.minimum = minimum
        self.maximum = maximum
        self.minLength = minLength
        self.maxLength = maxLength
        self.minItems = minItems
        self.maxItems = maxItems
        self.additionalProperties = additionalProperties
    }

    public static var strictEmptyObject: ToolJSONSchema {
        ToolJSONSchema(type: .object, properties: [:], required: [], additionalProperties: false)
    }

    public var providerDescription: String {
        switch type {
        case .object:
            if properties.isEmpty { return "strict empty object {}" }
            let fields = properties.keys.sorted().map { key in
                required.contains(key) ? "\(key) required" : "\(key) optional"
            }.joined(separator: ", ")
            return "object{\(fields)} additionalProperties=\(additionalProperties)"
        case .array:
            return "array"
        case .string, .number, .integer, .boolean:
            return type.rawValue
        }
    }
}

public struct ToolSchemaValidationLimits: Sendable, Equatable {
    public var maxPayloadBytes: Int
    public var maxDepth: Int
    public var maxArrayItems: Int

    public init(maxPayloadBytes: Int = 16_384, maxDepth: Int = 12, maxArrayItems: Int = 64) {
        self.maxPayloadBytes = max(128, maxPayloadBytes)
        self.maxDepth = max(1, maxDepth)
        self.maxArrayItems = max(1, maxArrayItems)
    }
}

public struct ToolSchemaValidationIssue: Sendable, Codable, Equatable, Hashable {
    public var path: String
    public var message: String

    public init(path: String, message: String) {
        self.path = path
        self.message = AgentPrivacyRedactor.safeSummary(message, fallback: "invalid")
    }
}

public struct ToolSchemaValidationResult: Sendable, Equatable {
    public var accepted: Bool
    public var issues: [ToolSchemaValidationIssue]

    public init(accepted: Bool, issues: [ToolSchemaValidationIssue] = []) {
        self.accepted = accepted
        self.issues = issues
    }

    public static let accepted = ToolSchemaValidationResult(accepted: true)
}

public enum ToolSchemaValidator {
    public static func validate(_ value: AgentJSONValue,
                                against schema: ToolJSONSchema,
                                limits: ToolSchemaValidationLimits = ToolSchemaValidationLimits()) -> ToolSchemaValidationResult {
        let bytes = value.jsonString.utf8.count
        guard bytes <= limits.maxPayloadBytes else {
            return ToolSchemaValidationResult(accepted: false, issues: [
                ToolSchemaValidationIssue(path: "$", message: "payload too large"),
            ])
        }
        var issues: [ToolSchemaValidationIssue] = []
        validate(value, schema: schema, path: "$", depth: 0, limits: limits, issues: &issues)
        return issues.isEmpty ? .accepted : ToolSchemaValidationResult(accepted: false, issues: issues)
    }

    private static func validate(_ value: AgentJSONValue,
                                 schema: ToolJSONSchema,
                                 path: String,
                                 depth: Int,
                                 limits: ToolSchemaValidationLimits,
                                 issues: inout [ToolSchemaValidationIssue]) {
        guard depth <= limits.maxDepth else {
            issues.append(ToolSchemaValidationIssue(path: path, message: "nesting depth exceeded"))
            return
        }
        if let enumValues = schema.enumValues, !enumValues.contains(value) {
            issues.append(ToolSchemaValidationIssue(path: path, message: "enum mismatch"))
            return
        }
        switch (schema.type, value) {
        case (.object, .object(let object)):
            for key in schema.required where object[key] == nil {
                issues.append(ToolSchemaValidationIssue(path: "\(path).\(key)", message: "required property missing"))
            }
            if !schema.additionalProperties {
                for key in object.keys where schema.properties[key] == nil {
                    issues.append(ToolSchemaValidationIssue(path: "\(path).\(key)", message: "unknown property"))
                }
            }
            for (key, child) in schema.properties where object[key] != nil {
                validate(object[key] ?? .null, schema: child, path: "\(path).\(key)",
                         depth: depth + 1, limits: limits, issues: &issues)
            }
        case (.string, .string(let string)):
            if let min = schema.minLength, string.count < min {
                issues.append(ToolSchemaValidationIssue(path: path, message: "string shorter than minLength"))
            }
            if let max = schema.maxLength, string.count > max {
                issues.append(ToolSchemaValidationIssue(path: path, message: "string longer than maxLength"))
            }
        case (.number, .number(let number)):
            validateNumber(number, schema: schema, path: path, issues: &issues)
        case (.integer, .number(let number)):
            guard number.rounded() == number else {
                issues.append(ToolSchemaValidationIssue(path: path, message: "integer expected"))
                return
            }
            validateNumber(number, schema: schema, path: path, issues: &issues)
        case (.boolean, .bool):
            break
        case (.array, .array(let values)):
            let schemaMax = schema.maxItems ?? limits.maxArrayItems
            if let min = schema.minItems, values.count < min {
                issues.append(ToolSchemaValidationIssue(path: path, message: "array shorter than minItems"))
            }
            if values.count > schemaMax {
                issues.append(ToolSchemaValidationIssue(path: path, message: "array longer than maxItems"))
            }
            if let itemSchema = schema.items?.value {
                for (index, item) in values.prefix(schemaMax).enumerated() {
                    validate(item, schema: itemSchema, path: "\(path)[\(index)]",
                             depth: depth + 1, limits: limits, issues: &issues)
                }
            }
        default:
            issues.append(ToolSchemaValidationIssue(path: path, message: "\(schema.type.rawValue) expected"))
        }
    }

    private static func validateNumber(_ number: Double,
                                       schema: ToolJSONSchema,
                                       path: String,
                                       issues: inout [ToolSchemaValidationIssue]) {
        if let minimum = schema.minimum, number < minimum {
            issues.append(ToolSchemaValidationIssue(path: path, message: "number below minimum"))
        }
        if let maximum = schema.maximum, number > maximum {
            issues.append(ToolSchemaValidationIssue(path: path, message: "number above maximum"))
        }
    }
}

public enum ToolExecutionStatus: String, Codable, Sendable, Hashable {
    case success
    case partial
    case denied
    case failed
    case timedOut
    case cancelled
}

public struct ToolWarning: Codable, Sendable, Hashable {
    public var code: String
    public var message: String

    public init(code: String, message: String) {
        self.code = AgentPrivacyRedactor.safeIdentifier(code, fallback: "warning")
        self.message = AgentPrivacyRedactor.safeSummary(message, fallback: "warning")
    }
}

public struct ToolExecutionMetadata: Codable, Sendable, Hashable {
    public var durationMilliseconds: Int?
    public var itemCount: Int?
    public var truncated: Bool

    public init(durationMilliseconds: Int? = nil, itemCount: Int? = nil, truncated: Bool = false) {
        self.durationMilliseconds = durationMilliseconds
        self.itemCount = itemCount
        self.truncated = truncated
    }
}

public struct ToolExecutionResult: Codable, Sendable, Hashable {
    public var status: ToolExecutionStatus
    public var userSafeSummary: String
    public var structuredData: AgentJSONValue
    public var modelContent: String?
    public var warnings: [ToolWarning]
    public var metadata: ToolExecutionMetadata

    public init(status: ToolExecutionStatus,
                userSafeSummary: String,
                structuredData: AgentJSONValue,
                modelContent: String? = nil,
                warnings: [ToolWarning] = [],
                metadata: ToolExecutionMetadata = ToolExecutionMetadata()) {
        self.status = status
        self.userSafeSummary = AgentPrivacyRedactor.safeSummary(userSafeSummary, fallback: status.rawValue)
        self.structuredData = structuredData.sanitized(maxStringLength: 2_048)
        self.modelContent = modelContent.map { AgentPrivacyRedactor.safeText($0, maxLength: 4_096).text }
        self.warnings = warnings
        self.metadata = metadata
    }

    public func limited(to maxBytes: Int) -> ToolExecutionResult {
        guard structuredData.jsonString.utf8.count > maxBytes else { return self }
        var copy = self
        copy.structuredData = .object([
            "status": .string(status.rawValue),
            "truncated": .bool(true),
        ])
        copy.metadata.truncated = true
        copy.warnings.append(ToolWarning(code: "result_truncated", message: "Tool result exceeded size limit"))
        return copy
    }
}

public enum ToolPlatformError: Error, Sendable, Equatable {
    case unknownTool(String)
    case duplicateRegistration(String)
    case toolDisabled(String)
    case toolUnavailable(String)
    case invalidArguments(String)
    case schemaValidationFailed([ToolSchemaValidationIssue])
    case permissionDenied(String)
    case systemPermissionMissing(String)
    case executionFailed(String)
    case timedOut
    case cancelled
    case resultTooLarge
    case unsupportedProviderSchema(String)
    case internalInvariantViolation(String)
}

public protocol SafeToolLogger: Sendable {
    func record(toolID: ToolID, status: ToolExecutionStatus, metadata: ToolExecutionMetadata) async
}

public struct NoopSafeToolLogger: SafeToolLogger {
    public init() {}
    public func record(toolID: ToolID, status: ToolExecutionStatus, metadata: ToolExecutionMetadata) async {}
}

public struct ToolExecutionContext: Sendable {
    public var taskID: UUID?
    public var runID: UUID?
    public var turnID: UUID
    public var callID: String
    public var toolID: ToolID
    public var locale: Locale
    public var timeZone: TimeZone
    public var clock: RuntimeClock
    public var capabilityToken: CapabilityToken?
    public var permissionAlreadyEvaluated: Bool
    public var deadline: Date?
    public var logger: any SafeToolLogger

    public init(taskID: UUID? = nil,
                runID: UUID? = nil,
                turnID: UUID,
                callID: String,
                toolID: ToolID,
                locale: Locale = .current,
                timeZone: TimeZone = .current,
                clock: RuntimeClock = WallClock(),
                capabilityToken: CapabilityToken? = nil,
                permissionAlreadyEvaluated: Bool = false,
                deadline: Date? = nil,
                logger: any SafeToolLogger = NoopSafeToolLogger()) {
        self.taskID = taskID
        self.runID = runID
        self.turnID = turnID
        self.callID = AgentPrivacyRedactor.safeIdentifier(callID, fallback: "call")
        self.toolID = toolID
        self.locale = locale
        self.timeZone = timeZone
        self.clock = clock
        self.capabilityToken = capabilityToken
        self.permissionAlreadyEvaluated = permissionAlreadyEvaluated
        self.deadline = deadline
        self.logger = logger
    }
}

public protocol AgentTool: Sendable {
    associatedtype Input: Decodable & Sendable
    static var manifest: ToolManifest { get }
    func execute(input: Input, context: ToolExecutionContext) async throws -> ToolExecutionResult
}

public struct EmptyToolInput: Codable, Sendable, Hashable {
    public init() {}
}

public struct AnyAgentTool: Sendable {
    public let manifest: ToolManifest
    private let run: @Sendable (AgentJSONValue, ToolExecutionContext) async throws -> ToolExecutionResult

    public init<T: AgentTool>(_ tool: T) {
        self.manifest = T.manifest
        self.run = { arguments, context in
            let data = try JSONEncoder().encode(arguments)
            let input = try JSONDecoder().decode(T.Input.self, from: data)
            return try await tool.execute(input: input, context: context)
        }
    }

    public func execute(arguments: AgentJSONValue,
                        context: ToolExecutionContext) async throws -> ToolExecutionResult {
        try await run(arguments, context)
    }
}

public struct ToolCatalogEntry: Sendable, Hashable {
    public var manifest: ToolManifest
    public var enabled: Bool

    public init(manifest: ToolManifest, enabled: Bool) {
        self.manifest = manifest
        self.enabled = enabled
    }
}

public struct ToolCatalogSnapshot: Sendable, Equatable, Hashable {
    public var entries: [ToolCatalogEntry]

    public init(entries: [ToolCatalogEntry] = []) {
        self.entries = entries.sorted { lhs, rhs in
            if lhs.manifest.category != rhs.manifest.category {
                return lhs.manifest.category.rawValue < rhs.manifest.category.rawValue
            }
            if lhs.manifest.displayName != rhs.manifest.displayName {
                return lhs.manifest.displayName < rhs.manifest.displayName
            }
            return lhs.manifest.id < rhs.manifest.id
        }
    }

    public static let empty = ToolCatalogSnapshot()

    public var manifests: [ToolManifest] {
        entries.map(\.manifest)
    }

    public func lookup(_ id: ToolID) -> ToolCatalogEntry? {
        entries.first { $0.manifest.id == id }
    }

    public func contains(_ id: String) -> Bool {
        lookup(ToolID(rawValue: id)) != nil
    }

    public func capabilitySnapshot() -> CapabilityCatalogSnapshot {
        let capabilities = entries.compactMap { entry -> Capability? in
            guard let id = entry.manifest.permissionRequirement.capabilityID else { return nil }
            return CapabilityCatalog.lookup(id)
        }
        return CapabilityCatalogSnapshot(capabilities: capabilities, toolCatalog: self)
    }
}

public protocol ToolPolicyStore: Sendable {
    func isToolEnabled(_ toolID: ToolID) async -> Bool
}

public struct AllowAllToolPolicyStore: ToolPolicyStore {
    public init() {}
    public func isToolEnabled(_ toolID: ToolID) async -> Bool { true }
}

public actor InMemoryToolPolicyStore: ToolPolicyStore {
    private var enabled: [ToolID: Bool]

    public init(enabled: [ToolID: Bool] = [:]) {
        self.enabled = enabled
    }

    public func isToolEnabled(_ toolID: ToolID) async -> Bool {
        enabled[toolID] ?? true
    }

    public func setEnabled(_ isEnabled: Bool, for toolID: ToolID) {
        enabled[toolID] = isEnabled
    }
}

public protocol ToolCatalogProviding: Sendable {
    func toolCatalogSnapshot(for policy: AgentPolicy) async -> ToolCatalogSnapshot
}

public protocol ToolPlatformExecuting: Sendable {
    func executeTool(request: AgentToolCallRequest,
                     context: ToolExecutionContext) async -> Result<ToolExecutionResult, ToolPlatformError>
}

public protocol ObservationSanitizing: Sendable {
    func observation(for request: AgentToolCallRequest,
                     result: ToolExecutionResult,
                     maxCharacters: Int) -> AgentToolObservation
}

public struct DefaultObservationSanitizer: ObservationSanitizing {
    public init() {}

    public func observation(for request: AgentToolCallRequest,
                            result: ToolExecutionResult,
                            maxCharacters: Int) -> AgentToolObservation {
        let status: AgentLoopObservationStatus
        switch result.status {
        case .success, .partial:
            status = .success
        case .denied:
            status = .denied
        case .timedOut:
            status = .timeout
        case .failed, .cancelled:
            status = .failed
        }
        let safeSummary = AgentPrivacyRedactor.safeText(result.modelContent ?? result.userSafeSummary,
                                                        maxLength: maxCharacters)
        return AgentToolObservation(callID: request.callID,
                                    toolName: request.toolName,
                                    status: status,
                                    content: result.structuredData,
                                    userSafeSummary: safeSummary.text,
                                    isTruncated: safeSummary.truncated || result.metadata.truncated)
    }
}
