import Foundation
import AICore

public enum AgentResultStatus: String, Codable, Sendable, Hashable, CaseIterable {
    case loading
    case partial
    case completed
    case failed
}

public enum AgentResultEventKind: String, Codable, Sendable, Hashable, CaseIterable {
    case snapshot
    case patch
}

public struct AgentResultDocument: Codable, Sendable, Hashable, Identifiable {
    public var schemaVersion: Int
    public var id: String
    public var taskID: UUID
    public var runID: UUID
    public var revision: Int?
    public var title: String
    public var summary: String
    public var status: AgentResultStatus
    public var generatedAt: Date
    public var lastUpdatedAt: Date
    public var freshness: String?
    public var sections: [AgentResultSection]
    public var sources: [AgentResultSource]
    public var actions: [AgentResultAction]
    public var metadata: [String: String]

    public init(schemaVersion: Int = 1,
                id: String,
                taskID: UUID,
                runID: UUID,
                revision: Int? = 0,
                title: String,
                summary: String,
                status: AgentResultStatus,
                generatedAt: Date,
                lastUpdatedAt: Date? = nil,
                freshness: String? = nil,
                sections: [AgentResultSection],
                sources: [AgentResultSource] = [],
                actions: [AgentResultAction] = [],
                metadata: [String: String] = [:]) {
        self.schemaVersion = schemaVersion
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.taskID = taskID
        self.runID = runID
        self.revision = revision.map { max(0, $0) }
        self.title = AgentPrivacyRedactor.safeSummary(title, fallback: "结果")
        self.summary = AgentPrivacyRedactor.safeText(summary, maxLength: 1_000).text
        self.status = status
        self.generatedAt = generatedAt
        self.lastUpdatedAt = lastUpdatedAt ?? generatedAt
        self.freshness = freshness.map { AgentPrivacyRedactor.safeText($0, maxLength: 160).text }
        self.sections = sections
        self.sources = sources
        self.actions = actions
        self.metadata = AgentPrivacyRedactor.safeMetadata(metadata)
    }

    public var currentRevision: Int {
        max(0, revision ?? 0)
    }
}

public struct AgentResultSection: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String?
    public var state: AgentResultComponentState?
    public var accessibility: AgentResultAccessibility?
    public var component: AgentResultComponent

    public init(id: String,
                title: String? = nil,
                state: AgentResultComponentState? = nil,
                accessibility: AgentResultAccessibility? = nil,
                component: AgentResultComponent) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.title = title.map { AgentPrivacyRedactor.safeSummary($0, fallback: "分区") }
        self.state = state
        self.accessibility = accessibility
        self.component = component
    }
}

public enum AgentResultComponent: Codable, Sendable, Hashable {
    case text(TextComponent)
    case status(StatusComponent)
    case progress(ProgressComponent)
    case keyValue(KeyValueComponent)
    case list(ListComponent)
    case choiceList(ChoiceListComponent)
    case table(TableComponent)
    case comparisonList(ComparisonListComponent)
    case cardGrid(CardGridComponent)
    case comparisonCards(ComparisonCardsComponent)
    case timeline(TimelineComponent)
    case form(FormComponent)
    case confirmation(ConfirmationComponent)
    case map(MapComponent)
    case chart(ChartComponent)
    case artifact(ArtifactComponent)
    case sourceList(SourceListComponent)
    case actionRow(ActionRowComponent)
    case errorRecovery(ErrorRecoveryComponent)
    case emptyState(EmptyStateComponent)

    private enum CodingKeys: String, CodingKey { case type, payload }
    private enum ComponentType: String, Codable {
        case text, status, progress, keyValue, list, choiceList, table, comparisonList, cardGrid,
             comparisonCards, timeline, form, confirmation, map, chart, artifact, sourceList,
             actionRow, errorRecovery, emptyState
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(ComponentType.self, forKey: .type)
        switch type {
        case .text: self = .text(try container.decode(TextComponent.self, forKey: .payload))
        case .status: self = .status(try container.decode(StatusComponent.self, forKey: .payload))
        case .progress: self = .progress(try container.decode(ProgressComponent.self, forKey: .payload))
        case .keyValue: self = .keyValue(try container.decode(KeyValueComponent.self, forKey: .payload))
        case .list: self = .list(try container.decode(ListComponent.self, forKey: .payload))
        case .choiceList: self = .choiceList(try container.decode(ChoiceListComponent.self, forKey: .payload))
        case .table: self = .table(try container.decode(TableComponent.self, forKey: .payload))
        case .comparisonList: self = .comparisonList(try container.decode(ComparisonListComponent.self, forKey: .payload))
        case .cardGrid: self = .cardGrid(try container.decode(CardGridComponent.self, forKey: .payload))
        case .comparisonCards: self = .comparisonCards(try container.decode(ComparisonCardsComponent.self, forKey: .payload))
        case .timeline: self = .timeline(try container.decode(TimelineComponent.self, forKey: .payload))
        case .form: self = .form(try container.decode(FormComponent.self, forKey: .payload))
        case .confirmation: self = .confirmation(try container.decode(ConfirmationComponent.self, forKey: .payload))
        case .map: self = .map(try container.decode(MapComponent.self, forKey: .payload))
        case .chart: self = .chart(try container.decode(ChartComponent.self, forKey: .payload))
        case .artifact: self = .artifact(try container.decode(ArtifactComponent.self, forKey: .payload))
        case .sourceList: self = .sourceList(try container.decode(SourceListComponent.self, forKey: .payload))
        case .actionRow: self = .actionRow(try container.decode(ActionRowComponent.self, forKey: .payload))
        case .errorRecovery: self = .errorRecovery(try container.decode(ErrorRecoveryComponent.self, forKey: .payload))
        case .emptyState: self = .emptyState(try container.decode(EmptyStateComponent.self, forKey: .payload))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let payload):
            try container.encode(ComponentType.text, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .status(let payload):
            try container.encode(ComponentType.status, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .progress(let payload):
            try container.encode(ComponentType.progress, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .keyValue(let payload):
            try container.encode(ComponentType.keyValue, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .list(let payload):
            try container.encode(ComponentType.list, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .choiceList(let payload):
            try container.encode(ComponentType.choiceList, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .table(let payload):
            try container.encode(ComponentType.table, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .comparisonList(let payload):
            try container.encode(ComponentType.comparisonList, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .cardGrid(let payload):
            try container.encode(ComponentType.cardGrid, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .comparisonCards(let payload):
            try container.encode(ComponentType.comparisonCards, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .timeline(let payload):
            try container.encode(ComponentType.timeline, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .form(let payload):
            try container.encode(ComponentType.form, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .confirmation(let payload):
            try container.encode(ComponentType.confirmation, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .map(let payload):
            try container.encode(ComponentType.map, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .chart(let payload):
            try container.encode(ComponentType.chart, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .artifact(let payload):
            try container.encode(ComponentType.artifact, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .sourceList(let payload):
            try container.encode(ComponentType.sourceList, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .actionRow(let payload):
            try container.encode(ComponentType.actionRow, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .errorRecovery(let payload):
            try container.encode(ComponentType.errorRecovery, forKey: .type)
            try container.encode(payload, forKey: .payload)
        case .emptyState(let payload):
            try container.encode(ComponentType.emptyState, forKey: .type)
            try container.encode(payload, forKey: .payload)
        }
    }
}

public enum AgentResultComponentStateKind: String, Codable, Sendable, Hashable, CaseIterable {
    case pending
    case streaming
    case unverified
    case verifying
    case verified
    case resolved
    case collapsed
    case disabled
}

public struct AgentResultComponentState: Codable, Sendable, Hashable {
    public var kind: AgentResultComponentStateKind
    public var summary: String?
    public var selectedID: String?

    public init(kind: AgentResultComponentStateKind,
                summary: String? = nil,
                selectedID: String? = nil) {
        self.kind = kind
        self.summary = summary.map { AgentPrivacyRedactor.safeText($0, maxLength: 400).text }
        self.selectedID = selectedID.map(AgentEventRedactor.safeIdentifier)
    }
}

public struct AgentResultAccessibility: Codable, Sendable, Hashable {
    public var label: String?
    public var hint: String?

    public init(label: String? = nil, hint: String? = nil) {
        self.label = label.map { AgentPrivacyRedactor.safeSummary($0, fallback: "结果组件") }
        self.hint = hint.map { AgentPrivacyRedactor.safeText($0, maxLength: 240).text }
    }
}

public struct TextComponent: Codable, Sendable, Hashable {
    public var text: String
    public init(_ text: String) { self.text = AgentPrivacyRedactor.safeText(text, maxLength: 4_000).text }
}

public struct StatusComponent: Codable, Sendable, Hashable {
    public var label: String
    public var status: AgentResultStatus
    public var detail: String?
    public init(label: String, status: AgentResultStatus, detail: String? = nil) {
        self.label = AgentPrivacyRedactor.safeSummary(label, fallback: status.rawValue)
        self.status = status
        self.detail = detail.map { AgentPrivacyRedactor.safeText($0, maxLength: 400).text }
    }
}

public struct ProgressComponent: Codable, Sendable, Hashable {
    public var label: String
    public var value: Double
    public var total: Double
    public var detail: String?

    public init(label: String,
                value: Double,
                total: Double = 1,
                detail: String? = nil) {
        self.label = AgentPrivacyRedactor.safeSummary(label, fallback: "进度")
        self.value = value
        self.total = total
        self.detail = detail.map { AgentPrivacyRedactor.safeText($0, maxLength: 400).text }
    }

    public var fraction: Double {
        guard value.isFinite, total.isFinite, total > 0 else { return 0 }
        return min(1, max(0, value / total))
    }
}

public struct KeyValueComponent: Codable, Sendable, Hashable {
    public var rows: [KeyValueRow]
    public init(rows: [KeyValueRow]) { self.rows = rows }
}

public struct KeyValueRow: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var key: String
    public var value: String
    public init(id: String, key: String, value: String) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.key = AgentPrivacyRedactor.safeSummary(key, fallback: "字段")
        self.value = AgentPrivacyRedactor.safeText(value, maxLength: 600).text
    }
}

public struct ListComponent: Codable, Sendable, Hashable {
    public var items: [String]
    public init(items: [String]) {
        self.items = items.map { AgentPrivacyRedactor.safeText($0, maxLength: 600).text }
    }
}

public struct ChoiceListComponent: Codable, Sendable, Hashable {
    public var choices: [ChoiceItem]
    public var selectedChoiceID: String?
    public var resolvedSummary: String?

    public init(choices: [ChoiceItem],
                selectedChoiceID: String? = nil,
                resolvedSummary: String? = nil) {
        self.choices = choices
        self.selectedChoiceID = selectedChoiceID.map(AgentEventRedactor.safeIdentifier)
        self.resolvedSummary = resolvedSummary.map { AgentPrivacyRedactor.safeText($0, maxLength: 400).text }
    }
}

public struct ChoiceItem: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var subtitle: String?
    public var detail: String?
    public var badge: String?
    public var actionID: String?

    public init(id: String,
                title: String,
                subtitle: String? = nil,
                detail: String? = nil,
                badge: String? = nil,
                actionID: String? = nil) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.title = AgentPrivacyRedactor.safeSummary(title, fallback: "选项")
        self.subtitle = subtitle.map { AgentPrivacyRedactor.safeText($0, maxLength: 240).text }
        self.detail = detail.map { AgentPrivacyRedactor.safeText($0, maxLength: 600).text }
        self.badge = badge.map { AgentPrivacyRedactor.safeSummary($0, fallback: "标签") }
        self.actionID = actionID.map(AgentEventRedactor.safeIdentifier)
    }
}

public struct TableComponent: Codable, Sendable, Hashable {
    public var columns: [String]
    public var rows: [[String]]
    public init(columns: [String], rows: [[String]]) {
        self.columns = columns.map { AgentPrivacyRedactor.safeSummary($0, fallback: "列") }
        self.rows = rows.map { row in row.map { AgentPrivacyRedactor.safeText($0, maxLength: 240).text } }
    }
}

public struct ComparisonCardsComponent: Codable, Sendable, Hashable {
    public var cards: [ComparisonCard]
    public init(cards: [ComparisonCard]) { self.cards = cards }
}

public struct ComparisonListComponent: Codable, Sendable, Hashable {
    public var items: [ComparisonCard]
    public init(items: [ComparisonCard]) { self.items = items }
}

public struct CardGridComponent: Codable, Sendable, Hashable {
    public var cards: [ComparisonCard]
    public init(cards: [ComparisonCard]) { self.cards = cards }
}

public struct ComparisonCard: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var subtitle: String?
    public var attributes: [KeyValueRow]
    public var badge: String?
    public init(id: String, title: String, subtitle: String? = nil,
                attributes: [KeyValueRow], badge: String? = nil) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.title = AgentPrivacyRedactor.safeSummary(title, fallback: "选项")
        self.subtitle = subtitle.map { AgentPrivacyRedactor.safeText($0, maxLength: 240).text }
        self.attributes = attributes
        self.badge = badge.map { AgentPrivacyRedactor.safeSummary($0, fallback: "标签") }
    }
}

public struct TimelineComponent: Codable, Sendable, Hashable {
    public var items: [TimelineItem]
    public init(items: [TimelineItem]) { self.items = items }
}

public struct TimelineItem: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var detail: String?
    public var timestamp: Date?
    public init(id: String, title: String, detail: String? = nil, timestamp: Date? = nil) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.title = AgentPrivacyRedactor.safeSummary(title, fallback: "事件")
        self.detail = detail.map { AgentPrivacyRedactor.safeText($0, maxLength: 400).text }
        self.timestamp = timestamp
    }
}

public struct FormComponent: Codable, Sendable, Hashable {
    public var fields: [FormField]
    public var submitActionID: String?

    public init(fields: [FormField], submitActionID: String? = nil) {
        self.fields = fields
        self.submitActionID = submitActionID.map(AgentEventRedactor.safeIdentifier)
    }
}

public struct FormField: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var label: String
    public var value: String?
    public var placeholder: String?
    public var required: Bool

    public init(id: String,
                label: String,
                value: String? = nil,
                placeholder: String? = nil,
                required: Bool = false) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.label = AgentPrivacyRedactor.safeSummary(label, fallback: "字段")
        self.value = value.map { AgentPrivacyRedactor.safeText($0, maxLength: 600).text }
        self.placeholder = placeholder.map { AgentPrivacyRedactor.safeText($0, maxLength: 240).text }
        self.required = required
    }
}

public struct ConfirmationComponent: Codable, Sendable, Hashable {
    public var message: String
    public var confirmActionID: String?
    public var cancelActionID: String?
    public var resolvedActionID: String?

    public init(message: String,
                confirmActionID: String? = nil,
                cancelActionID: String? = nil,
                resolvedActionID: String? = nil) {
        self.message = AgentPrivacyRedactor.safeText(message, maxLength: 600).text
        self.confirmActionID = confirmActionID.map(AgentEventRedactor.safeIdentifier)
        self.cancelActionID = cancelActionID.map(AgentEventRedactor.safeIdentifier)
        self.resolvedActionID = resolvedActionID.map(AgentEventRedactor.safeIdentifier)
    }
}

public struct MapComponent: Codable, Sendable, Hashable {
    public var title: String?
    public var center: MapCoordinate?
    public var points: [MapPoint]

    public init(title: String? = nil,
                center: MapCoordinate? = nil,
                points: [MapPoint] = []) {
        self.title = title.map { AgentPrivacyRedactor.safeSummary($0, fallback: "地图") }
        self.center = center
        self.points = points
    }
}

public struct MapCoordinate: Codable, Sendable, Hashable {
    public var latitude: Double
    public var longitude: Double
    public init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }
}

public struct MapPoint: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var coordinate: MapCoordinate

    public init(id: String, title: String, coordinate: MapCoordinate) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.title = AgentPrivacyRedactor.safeSummary(title, fallback: "地点")
        self.coordinate = coordinate
    }
}

public enum ChartKind: String, Codable, Sendable, Hashable, CaseIterable {
    case bar
    case line
    case pie
}

public struct ChartComponent: Codable, Sendable, Hashable {
    public var kind: ChartKind
    public var series: [ChartSeries]

    public init(kind: ChartKind, series: [ChartSeries]) {
        self.kind = kind
        self.series = series
    }
}

public struct ChartSeries: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var values: [ChartValue]

    public init(id: String, name: String, values: [ChartValue]) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.name = AgentPrivacyRedactor.safeSummary(name, fallback: "序列")
        self.values = values
    }
}

public struct ChartValue: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var label: String
    public var value: Double

    public init(id: String, label: String, value: Double) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.label = AgentPrivacyRedactor.safeSummary(label, fallback: "值")
        self.value = value
    }
}

public struct ArtifactComponent: Codable, Sendable, Hashable {
    public var title: String
    public var kind: String
    public var url: String?
    public var checksum: String?
    public var sizeBytes: Int?

    public init(title: String,
                kind: String,
                url: String? = nil,
                checksum: String? = nil,
                sizeBytes: Int? = nil) {
        self.title = AgentPrivacyRedactor.safeSummary(title, fallback: "产物")
        self.kind = AgentEventRedactor.safeIdentifier(kind)
        self.url = url.map { AgentPrivacyRedactor.safeText($0, maxLength: 1_000).text }
        self.checksum = checksum.map(AgentEventRedactor.safeIdentifier)
        self.sizeBytes = sizeBytes.map { max(0, $0) }
    }
}

public struct SourceListComponent: Codable, Sendable, Hashable {
    public var sourceIDs: [String]
    public init(sourceIDs: [String]) { self.sourceIDs = sourceIDs.map(AgentEventRedactor.safeIdentifier) }
}

public struct ActionRowComponent: Codable, Sendable, Hashable {
    public var actionIDs: [String]
    public init(actionIDs: [String]) { self.actionIDs = actionIDs.map(AgentEventRedactor.safeIdentifier) }
}

public struct ErrorRecoveryComponent: Codable, Sendable, Hashable {
    public var message: String
    public var actionIDs: [String]
    public init(message: String, actionIDs: [String] = []) {
        self.message = AgentPrivacyRedactor.safeText(message, maxLength: 600).text
        self.actionIDs = actionIDs.map(AgentEventRedactor.safeIdentifier)
    }
}

public struct EmptyStateComponent: Codable, Sendable, Hashable {
    public var message: String
    public var actionIDs: [String]

    public init(message: String, actionIDs: [String] = []) {
        self.message = AgentPrivacyRedactor.safeText(message, maxLength: 600).text
        self.actionIDs = actionIDs.map(AgentEventRedactor.safeIdentifier)
    }
}

public struct AgentResultSource: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var url: String?
    public var lastUpdatedAt: Date?
    public init(id: String, title: String, url: String? = nil, lastUpdatedAt: Date? = nil) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.title = AgentPrivacyRedactor.safeSummary(title, fallback: "来源")
        self.url = url.map { AgentPrivacyRedactor.safeText($0, maxLength: 1_000).text }
        self.lastUpdatedAt = lastUpdatedAt
    }
}

public struct AgentResultAction: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var toolID: ToolID
    public var arguments: AgentJSONValue
    public var requiresApproval: Bool
    public init(id: String, title: String, toolID: ToolID,
                arguments: AgentJSONValue = .object([:]), requiresApproval: Bool = true) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.title = AgentPrivacyRedactor.safeSummary(title, fallback: "操作")
        self.toolID = toolID
        self.arguments = arguments.sanitized()
        self.requiresApproval = requiresApproval
    }
}

public struct AgentResultValidationIssue: Codable, Sendable, Hashable {
    public var path: String
    public var message: String
    public init(path: String, message: String) {
        self.path = path
        self.message = message
    }
}

public struct AgentResultValidationResult: Sendable, Hashable {
    public var accepted: Bool
    public var document: AgentResultDocument?
    public var issues: [AgentResultValidationIssue]

    public init(accepted: Bool, document: AgentResultDocument?, issues: [AgentResultValidationIssue]) {
        self.accepted = accepted
        self.document = document
        self.issues = issues
    }
}

public struct AgentResultValidationLimits: Sendable, Hashable {
    public var maxComponents: Int
    public var maxTextLength: Int
    public var maxTableRows: Int
    public var maxTableColumns: Int
    public var maxSources: Int
    public var maxActions: Int
    public var maxPayloadBytes: Int

    public init(maxComponents: Int = 32,
                maxTextLength: Int = 4_000,
                maxTableRows: Int = 50,
                maxTableColumns: Int = 8,
                maxSources: Int = 20,
                maxActions: Int = 8,
                maxPayloadBytes: Int = 64_000) {
        self.maxComponents = max(1, maxComponents)
        self.maxTextLength = max(200, maxTextLength)
        self.maxTableRows = max(1, maxTableRows)
        self.maxTableColumns = max(1, maxTableColumns)
        self.maxSources = max(0, maxSources)
        self.maxActions = max(0, maxActions)
        self.maxPayloadBytes = max(1_024, maxPayloadBytes)
    }
}

public enum AgentResultValidator {
    public static let supportedSchemaVersion = 1

    public static func validate(_ document: AgentResultDocument,
                                toolCatalog: ToolCatalogSnapshot,
                                limits: AgentResultValidationLimits = AgentResultValidationLimits()) -> AgentResultValidationResult {
        var issues: [AgentResultValidationIssue] = []
        if document.schemaVersion != supportedSchemaVersion {
            issues.append(.init(path: "$.schemaVersion", message: "unsupported schemaVersion"))
        }
        if encodedSize(document) > limits.maxPayloadBytes {
            issues.append(.init(path: "$", message: "payload too large"))
        }
        var ids = Set<String>()
        checkID(document.id, path: "$.id", ids: &ids, issues: &issues)
        if document.sections.count > limits.maxComponents {
            issues.append(.init(path: "$.sections", message: "too many components"))
        }
        if document.sources.count > limits.maxSources {
            issues.append(.init(path: "$.sources", message: "too many sources"))
        }
        if document.actions.count > limits.maxActions {
            issues.append(.init(path: "$.actions", message: "too many actions"))
        }
        for (index, source) in document.sources.enumerated() {
            checkID(source.id, path: "$.sources[\(index)].id", ids: &ids, issues: &issues)
            validateURL(source.url, path: "$.sources[\(index)].url", issues: &issues)
        }
        let sourceIDs = Set(document.sources.map(\.id))
        let actionIDs = Set(document.actions.map(\.id))
        for (index, action) in document.actions.enumerated() {
            checkID(action.id, path: "$.actions[\(index)].id", ids: &ids, issues: &issues)
            guard let entry = toolCatalog.lookup(action.toolID) else {
                issues.append(.init(path: "$.actions[\(index)].toolID", message: "unregistered tool action"))
                continue
            }
            let schema = ToolSchemaValidator.validate(action.arguments, against: entry.manifest.inputSchema)
            if !schema.accepted {
                issues.append(.init(path: "$.actions[\(index)].arguments", message: "arguments schema mismatch"))
            }
            if entry.manifest.riskLevel >= .externalSideEffectReversible && !action.requiresApproval {
                issues.append(.init(path: "$.actions[\(index)].requiresApproval", message: "approval required"))
            }
        }
        for (index, section) in document.sections.enumerated() {
            checkID(section.id, path: "$.sections[\(index)].id", ids: &ids, issues: &issues)
            validate(section.component,
                     path: "$.sections[\(index)].component",
                     sourceIDs: sourceIDs,
                     actionIDs: actionIDs,
                     limits: limits,
                     issues: &issues)
        }
        return AgentResultValidationResult(accepted: issues.isEmpty,
                                           document: issues.isEmpty ? document : nil,
                                           issues: issues)
    }

    public static func fallbackText(from document: AgentResultDocument,
                                    issues: [AgentResultValidationIssue]) -> String {
        let summary = document.summary.isEmpty ? document.title : document.summary
        let reason = issues.first?.message ?? "result validation failed"
        return "\(summary)\n\n结果视图已降级为文本：\(reason)"
    }

    private static func validate(_ component: AgentResultComponent,
                                 path: String,
                                 sourceIDs: Set<String>,
                                 actionIDs: Set<String>,
                                 limits: AgentResultValidationLimits,
                                 issues: inout [AgentResultValidationIssue]) {
        switch component {
        case .text(let payload):
            checkLength(payload.text, path: "\(path).text", max: limits.maxTextLength, issues: &issues)
        case .status(let payload):
            checkLength(payload.label, path: "\(path).label", max: 160, issues: &issues)
            if let detail = payload.detail {
                checkLength(detail, path: "\(path).detail", max: 600, issues: &issues)
            }
        case .progress(let payload):
            if !payload.value.isFinite || !payload.total.isFinite || payload.total <= 0 {
                issues.append(.init(path: "\(path).progress", message: "invalid progress"))
            }
        case .keyValue(let payload):
            if payload.rows.count > 32 { issues.append(.init(path: "\(path).rows", message: "too many key/value rows")) }
        case .list(let payload):
            if payload.items.count > 80 { issues.append(.init(path: "\(path).items", message: "too many list items")) }
        case .choiceList(let payload):
            if payload.choices.count > 16 { issues.append(.init(path: "\(path).choices", message: "too many choices")) }
            let choiceIDs = Set(payload.choices.map(\.id))
            if let selectedChoiceID = payload.selectedChoiceID, !choiceIDs.contains(selectedChoiceID) {
                issues.append(.init(path: "\(path).selectedChoiceID", message: "unknown choice reference"))
            }
            for choice in payload.choices {
                if let actionID = choice.actionID, !actionIDs.contains(actionID) {
                    issues.append(.init(path: "\(path).choices.actionID", message: "unknown action reference"))
                }
            }
        case .table(let payload):
            if payload.columns.count > limits.maxTableColumns {
                issues.append(.init(path: "\(path).columns", message: "too many table columns"))
            }
            if payload.rows.count > limits.maxTableRows {
                issues.append(.init(path: "\(path).rows", message: "too many table rows"))
            }
            for (rowIndex, row) in payload.rows.enumerated() where row.count != payload.columns.count {
                issues.append(.init(path: "\(path).rows[\(rowIndex)]", message: "row/column mismatch"))
            }
        case .comparisonList(let payload):
            if payload.items.count > 12 {
                issues.append(.init(path: "\(path).items", message: "too many comparison items"))
            }
        case .cardGrid(let payload):
            if payload.cards.count > 24 {
                issues.append(.init(path: "\(path).cards", message: "too many cards"))
            }
        case .comparisonCards(let payload):
            if payload.cards.count > 12 {
                issues.append(.init(path: "\(path).cards", message: "too many comparison cards"))
            }
        case .timeline(let payload):
            if payload.items.count > 40 {
                issues.append(.init(path: "\(path).items", message: "too many timeline items"))
            }
        case .form(let payload):
            if payload.fields.count > 20 {
                issues.append(.init(path: "\(path).fields", message: "too many form fields"))
            }
            if let actionID = payload.submitActionID, !actionIDs.contains(actionID) {
                issues.append(.init(path: "\(path).submitActionID", message: "unknown action reference"))
            }
        case .confirmation(let payload):
            for (field, actionID) in [("confirmActionID", payload.confirmActionID),
                                      ("cancelActionID", payload.cancelActionID),
                                      ("resolvedActionID", payload.resolvedActionID)] {
                if let actionID, !actionIDs.contains(actionID) {
                    issues.append(.init(path: "\(path).\(field)", message: "unknown action reference"))
                }
            }
        case .map(let payload):
            if payload.points.count > 50 {
                issues.append(.init(path: "\(path).points", message: "too many map points"))
            }
            if let center = payload.center {
                validateCoordinate(center, path: "\(path).center", issues: &issues)
            }
            for (index, point) in payload.points.enumerated() {
                validateCoordinate(point.coordinate, path: "\(path).points[\(index)].coordinate", issues: &issues)
            }
        case .chart(let payload):
            if payload.series.count > 8 {
                issues.append(.init(path: "\(path).series", message: "too many chart series"))
            }
            for (seriesIndex, series) in payload.series.enumerated() {
                if series.values.count > 80 {
                    issues.append(.init(path: "\(path).series[\(seriesIndex)].values", message: "too many chart values"))
                }
                for (valueIndex, value) in series.values.enumerated() where !value.value.isFinite {
                    issues.append(.init(path: "\(path).series[\(seriesIndex)].values[\(valueIndex)]", message: "invalid chart value"))
                }
            }
        case .artifact(let payload):
            validateURL(payload.url, path: "\(path).url", issues: &issues)
        case .sourceList(let payload):
            for id in payload.sourceIDs where !sourceIDs.contains(id) {
                issues.append(.init(path: "\(path).sourceIDs", message: "unknown source reference"))
            }
        case .actionRow(let payload):
            for id in payload.actionIDs where !actionIDs.contains(id) {
                issues.append(.init(path: "\(path).actionIDs", message: "unknown action reference"))
            }
        case .errorRecovery(let payload):
            checkLength(payload.message, path: "\(path).message", max: 1_000, issues: &issues)
            for id in payload.actionIDs where !actionIDs.contains(id) {
                issues.append(.init(path: "\(path).actionIDs", message: "unknown action reference"))
            }
        case .emptyState(let payload):
            checkLength(payload.message, path: "\(path).message", max: 1_000, issues: &issues)
            for id in payload.actionIDs where !actionIDs.contains(id) {
                issues.append(.init(path: "\(path).actionIDs", message: "unknown action reference"))
            }
        }
    }

    private static func validateURL(_ value: String?, path: String, issues: inout [AgentResultValidationIssue]) {
        guard let value else { return }
        guard let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme) else {
            issues.append(.init(path: path, message: "invalid url scheme"))
            return
        }
    }

    private static func checkID(_ id: String, path: String, ids: inout Set<String>,
                                issues: inout [AgentResultValidationIssue]) {
        if id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            issues.append(.init(path: path, message: "empty id"))
        }
        if !ids.insert(id).inserted {
            issues.append(.init(path: path, message: "duplicate id"))
        }
    }

    private static func checkLength(_ value: String, path: String, max: Int,
                                    issues: inout [AgentResultValidationIssue]) {
        if value.count > max { issues.append(.init(path: path, message: "text too long")) }
    }

    private static func validateCoordinate(_ coordinate: MapCoordinate,
                                           path: String,
                                           issues: inout [AgentResultValidationIssue]) {
        if !coordinate.latitude.isFinite || !coordinate.longitude.isFinite ||
            coordinate.latitude < -90 || coordinate.latitude > 90 ||
            coordinate.longitude < -180 || coordinate.longitude > 180 {
            issues.append(.init(path: path, message: "invalid coordinate"))
        }
    }

    private static func encodedSize(_ document: AgentResultDocument) -> Int {
        (try? JSONEncoder().encode(document).count) ?? Int.max
    }
}

public enum AgentResultPatchOperation: Codable, Sendable, Hashable {
    case upsertSection(AgentResultSection)
    case removeSection(id: String)
    case setStatus(AgentResultStatus)
    case setSummary(String)
    case setFreshness(String?)
    case setMetadata([String: String])
    case resolveChoice(componentID: String, choiceID: String, summary: String)
    case collapseSection(componentID: String, summary: String)
}

public struct AgentResultPatch: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var documentID: String
    public var taskID: UUID
    public var runID: UUID
    public var baseRevision: Int
    public var revision: Int
    public var operations: [AgentResultPatchOperation]
    public var timestamp: Date

    public init(id: UUID = UUID(),
                documentID: String,
                taskID: UUID,
                runID: UUID,
                baseRevision: Int,
                revision: Int,
                operations: [AgentResultPatchOperation],
                timestamp: Date = Date()) {
        self.id = id
        self.documentID = AgentEventRedactor.safeIdentifier(documentID)
        self.taskID = taskID
        self.runID = runID
        self.baseRevision = max(0, baseRevision)
        self.revision = max(0, revision)
        self.operations = operations
        self.timestamp = timestamp
    }
}

public struct AgentResultPatchApplyResult: Sendable, Hashable {
    public var accepted: Bool
    public var document: AgentResultDocument
    public var issues: [AgentResultValidationIssue]

    public init(accepted: Bool,
                document: AgentResultDocument,
                issues: [AgentResultValidationIssue] = []) {
        self.accepted = accepted
        self.document = document
        self.issues = issues
    }
}

public enum AgentResultPatchReducer {
    public static func apply(_ patch: AgentResultPatch,
                             to snapshot: AgentResultDocument,
                             toolCatalog: ToolCatalogSnapshot,
                             limits: AgentResultValidationLimits = AgentResultValidationLimits()) -> AgentResultPatchApplyResult {
        var issues: [AgentResultValidationIssue] = []
        guard patch.documentID == snapshot.id else {
            return .init(accepted: false, document: snapshot,
                         issues: [.init(path: "$.documentID", message: "patch document mismatch")])
        }
        guard patch.taskID == snapshot.taskID, patch.runID == snapshot.runID else {
            return .init(accepted: false, document: snapshot,
                         issues: [.init(path: "$.taskID", message: "patch task/run mismatch")])
        }
        guard patch.baseRevision == snapshot.currentRevision else {
            return .init(accepted: false, document: snapshot,
                         issues: [.init(path: "$.baseRevision", message: "patch revision mismatch")])
        }
        guard patch.revision > snapshot.currentRevision else {
            return .init(accepted: false, document: snapshot,
                         issues: [.init(path: "$.revision", message: "patch revision not newer")])
        }

        var document = snapshot
        for operation in patch.operations {
            apply(operation, to: &document, issues: &issues)
        }
        if document.sections.isEmpty {
            issues.append(.init(path: "$.sections", message: "patch would blank result"))
        }
        document.revision = patch.revision
        document.lastUpdatedAt = patch.timestamp

        let validation = AgentResultValidator.validate(document, toolCatalog: toolCatalog, limits: limits)
        issues.append(contentsOf: validation.issues)
        if !issues.isEmpty {
            return .init(accepted: false, document: snapshot, issues: issues)
        }
        return .init(accepted: true, document: validation.document ?? document)
    }

    private static func apply(_ operation: AgentResultPatchOperation,
                              to document: inout AgentResultDocument,
                              issues: inout [AgentResultValidationIssue]) {
        switch operation {
        case .upsertSection(let section):
            if let index = document.sections.firstIndex(where: { $0.id == section.id }) {
                document.sections[index] = section
            } else {
                document.sections.append(section)
            }
        case .removeSection(let id):
            let safeID = AgentEventRedactor.safeIdentifier(id)
            document.sections.removeAll { $0.id == safeID }
        case .setStatus(let status):
            document.status = status
        case .setSummary(let summary):
            document.summary = AgentPrivacyRedactor.safeText(summary, maxLength: 1_000).text
        case .setFreshness(let freshness):
            document.freshness = freshness.map { AgentPrivacyRedactor.safeText($0, maxLength: 160).text }
        case .setMetadata(let metadata):
            document.metadata.merge(AgentPrivacyRedactor.safeMetadata(metadata)) { _, new in new }
        case .resolveChoice(let componentID, let choiceID, let summary):
            guard let index = document.sections.firstIndex(where: { $0.id == AgentEventRedactor.safeIdentifier(componentID) }) else {
                issues.append(.init(path: "$.operations.resolveChoice", message: "unknown component"))
                return
            }
            let safeChoiceID = AgentEventRedactor.safeIdentifier(choiceID)
            switch document.sections[index].component {
            case .choiceList(var payload):
                guard payload.choices.contains(where: { $0.id == safeChoiceID }) else {
                    issues.append(.init(path: "$.operations.resolveChoice.choiceID", message: "unknown choice reference"))
                    return
                }
                payload.selectedChoiceID = safeChoiceID
                payload.resolvedSummary = AgentPrivacyRedactor.safeText(summary, maxLength: 400).text
                document.sections[index].component = .choiceList(payload)
                document.sections[index].state = .init(kind: .collapsed,
                                                       summary: payload.resolvedSummary,
                                                       selectedID: safeChoiceID)
            default:
                issues.append(.init(path: "$.operations.resolveChoice.componentID", message: "component is not choiceList"))
            }
        case .collapseSection(let componentID, let summary):
            guard let index = document.sections.firstIndex(where: { $0.id == AgentEventRedactor.safeIdentifier(componentID) }) else {
                issues.append(.init(path: "$.operations.collapseSection", message: "unknown component"))
                return
            }
            document.sections[index].state = .init(kind: .collapsed, summary: summary)
        }
    }
}

public struct AgentResultInteractionEvent: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var taskID: UUID
    public var runID: UUID
    public var documentID: String
    public var componentID: String
    public var actionID: String
    public var payload: AgentJSONValue
    public var timestamp: Date

    public init(id: UUID = UUID(),
                taskID: UUID,
                runID: UUID,
                documentID: String,
                componentID: String,
                actionID: String,
                payload: AgentJSONValue = .object([:]),
                timestamp: Date = Date()) {
        self.id = id
        self.taskID = taskID
        self.runID = runID
        self.documentID = AgentEventRedactor.safeIdentifier(documentID)
        self.componentID = AgentEventRedactor.safeIdentifier(componentID)
        self.actionID = AgentEventRedactor.safeIdentifier(actionID)
        self.payload = payload.sanitized()
        self.timestamp = timestamp
    }

    public func envelope(sequence: UInt64,
                         source: AgentEventSource = .chat,
                         visibility: AgentEventVisibility = .user) -> AgentEventEnvelope {
        AgentEventEnvelope(id: id,
                           taskID: taskID,
                           runID: runID,
                           sequence: sequence,
                           timestamp: timestamp,
                           source: source,
                           visibility: visibility,
                           kind: .uiInteractionResolved,
                           payload: .userAction(.init(action: actionID,
                                                       safeSummary: "用户已选择",
                                                       componentID: componentID,
                                                       actionID: actionID,
                                                       documentID: documentID,
                                                       payload: payload)))
    }

    public func streamEvent(sequence: UInt64,
                            source: AgentEventSource = .chat,
                            visibility: AgentEventVisibility = .user) -> AgentStreamEvent {
        AgentStreamEvent(schemaVersion: 1,
                         id: id,
                         taskID: taskID,
                         runID: runID,
                         sequence: sequence,
                         timestamp: timestamp,
                         source: source,
                         visibility: visibility,
                         kind: .uiInteractionResolved,
                         payload: .userAction(.init(action: actionID,
                                                     safeSummary: "用户已选择",
                                                     componentID: componentID,
                                                     actionID: actionID,
                                                     documentID: documentID,
                                                     payload: payload)))
    }
}

public struct StructuredDecisionSupplements: Sendable, Equatable {
    public var memoryCandidates: [MemoryCandidate]
    public var resultDocument: AgentResultDocument?
    public var resultIssues: [AgentResultValidationIssue]

    public init(memoryCandidates: [MemoryCandidate] = [],
                resultDocument: AgentResultDocument? = nil,
                resultIssues: [AgentResultValidationIssue] = []) {
        self.memoryCandidates = memoryCandidates
        self.resultDocument = resultDocument
        self.resultIssues = resultIssues
    }
}

public enum StructuredDecisionSupplementParser {
    public static func parse(raw: String,
                             toolCatalog: ToolCatalogSnapshot) -> StructuredDecisionSupplements {
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let root = object as? [String: Any] else {
            return StructuredDecisionSupplements()
        }
        let candidates = decodeCandidates(root["memoryCandidates"])
        let result = decodeResultDocument(root["resultDocument"], toolCatalog: toolCatalog)
        return StructuredDecisionSupplements(memoryCandidates: candidates,
                                             resultDocument: result.document,
                                             resultIssues: result.issues)
    }

    private static func decodeCandidates(_ raw: Any?) -> [MemoryCandidate] {
        guard let raw,
              JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let candidates = try? supplementDecoder.decode([MemoryCandidate].self, from: data) else {
            return []
        }
        return candidates.filter { !$0.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private static func decodeResultDocument(_ raw: Any?,
                                             toolCatalog: ToolCatalogSnapshot) -> (document: AgentResultDocument?, issues: [AgentResultValidationIssue]) {
        guard let raw,
              JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let document = try? supplementDecoder.decode(AgentResultDocument.self, from: data) else {
            return (nil, [])
        }
        let validation = AgentResultValidator.validate(document, toolCatalog: toolCatalog)
        return (validation.document, validation.issues)
    }

    private static var supplementDecoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

#if DEBUG
public enum P6DebugTravelFixture {
    public static func sampleDocument(taskID: UUID = UUID(),
                                      runID: UUID = UUID(),
                                      now: Date = Date()) -> AgentResultDocument {
        let cards = sampleFlights.map { flight in
            ComparisonCard(
                id: flight.id,
                title: "\(flight.airline) \(flight.flightNumber)",
                subtitle: "\(flight.departureAirport) \(flight.departureTime) -> \(flight.arrivalAirport) \(flight.arrivalTime)",
                attributes: [
                    .init(id: "\(flight.id)-duration", key: "总时长", value: flight.duration),
                    .init(id: "\(flight.id)-stops", key: "中转", value: flight.stops == 0 ? "直飞" : "\(flight.stops) 次"),
                    .init(id: "\(flight.id)-price", key: "SAMPLE 价格", value: flight.price),
                    .init(id: "\(flight.id)-bags", key: "行李", value: flight.baggage),
                ],
                badge: "SAMPLE / DEBUG")
        }
        let rows = sampleFlights.map {
            [$0.airline, $0.flightNumber, $0.departureTime, $0.arrivalTime,
             $0.duration, $0.stops == 0 ? "直飞" : "\($0.stops)", $0.price]
        }
        return AgentResultDocument(
            id: "debug-travel-sample",
            taskID: taskID,
            runID: runID,
            title: "SAMPLE 航班对比",
            summary: "这是 DEBUG fixture，不代表实时价格或真实库存。",
            status: .completed,
            generatedAt: now,
            freshness: "SAMPLE fixture updated at \(ISO8601DateFormatter().string(from: now))",
            sections: [
                AgentResultSection(id: "debug-label",
                                   component: .status(.init(label: "SAMPLE / DEBUG 数据", status: .completed,
                                                            detail: "不连接航空公司，不承诺实时价格。"))),
                AgentResultSection(id: "cards", title: "航班选项",
                                   component: .comparisonCards(.init(cards: cards))),
                AgentResultSection(id: "table", title: "表格对比",
                                   component: .table(.init(columns: ["航司", "航班", "出发", "到达", "时长", "中转", "价格"],
                                                           rows: rows))),
                AgentResultSection(id: "sources", title: "来源",
                                   component: .sourceList(.init(sourceIDs: ["debug-fixture"])))
            ],
            sources: [
                .init(id: "debug-fixture", title: "DeskPet DEBUG sample fixture", lastUpdatedAt: now)
            ],
            metadata: ["debug": "true", "sample": "true"])
    }

    private struct Flight {
        var id: String
        var airline: String
        var flightNumber: String
        var departureTime: String
        var arrivalTime: String
        var departureAirport: String
        var arrivalAirport: String
        var duration: String
        var stops: Int
        var price: String
        var baggage: String
    }

    private static let sampleFlights: [Flight] = [
        Flight(id: "sample-1", airline: "Pacific Sample", flightNumber: "PS 120",
               departureTime: "08:10", arrivalTime: "11:35", departureAirport: "SFO",
               arrivalAirport: "SEA", duration: "3h 25m", stops: 0, price: "$218", baggage: "1 carry-on"),
        Flight(id: "sample-2", airline: "Contoso Air", flightNumber: "CA 408",
               departureTime: "10:40", arrivalTime: "15:20", departureAirport: "SFO",
               arrivalAirport: "SEA", duration: "4h 40m", stops: 1, price: "$176", baggage: "Carry-on + checked sample"),
        Flight(id: "sample-3", airline: "Northwind Shuttle", flightNumber: "NW 77",
               departureTime: "18:05", arrivalTime: "21:20", departureAirport: "OAK",
               arrivalAirport: "SEA", duration: "3h 15m", stops: 0, price: "$242", baggage: "Basic carry-on")
    ]
}
#endif
