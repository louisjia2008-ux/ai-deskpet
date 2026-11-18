import Foundation
import Combine
import AICore
import PetAgentRuntime

enum CompanionRuntimeMode: String, Codable, CaseIterable, Sendable {
    case idle
    case companion
    case focus
    case paused
    case error

    var label: String {
        switch self {
        case .idle: return "空闲"
        case .companion: return "陪伴中"
        case .focus: return "专注中"
        case .paused: return "暂停"
        case .error: return "错误"
        }
    }
}

struct RuntimePermissionSummary: Equatable {
    var screen: CapabilityPermissionState = .notRequested
    var microphone: CapabilityPermissionState = .notRequested
    var memory: CapabilityPermissionState = .grantedPersistently
    var tools: CapabilityPermissionState = .notRequested

    var label: String {
        "屏幕 \(screen.displayLabel) · 麦克风 \(microphone.displayLabel) · 记忆 \(memory.displayLabel) · 工具 \(tools.displayLabel)"
    }
}

struct CompanionRuntimeStatus: Equatable {
    var currentMode: CompanionRuntimeMode
    var selectedModel: String
    var providerStatus: ProviderConnectionStatus
    var modelReadiness: ModelReadinessState
    var permissionSummary: RuntimePermissionSummary
    var memoryStatus: String
    var lastError: String?
}

enum CompanionRuntimeMessageError: Error, Equatable {
    case userFacing(String)
}

@MainActor
final class CompanionAgentRuntimeModel: ObservableObject {
    @Published private(set) var currentMode: CompanionRuntimeMode = .idle
    @Published private(set) var lastError: String?

    let providers: ProviderStore
    private let runtimeContainer: AgentRuntimeContainer
    private let preferences: PreferencesModel
    private let activityStore: AgentTaskActivityStore
    private let scheduler: AgentTaskScheduler
    private let conformanceProfileStore: ModelConformanceProfileStore?

    init(providers: ProviderStore,
         runtimeContainer: AgentRuntimeContainer,
         preferences: PreferencesModel,
         activityStore: AgentTaskActivityStore,
         scheduler: AgentTaskScheduler,
         conformanceProfileStore: ModelConformanceProfileStore? = nil) {
        self.providers = providers
        self.runtimeContainer = runtimeContainer
        self.preferences = preferences
        self.activityStore = activityStore
        self.scheduler = scheduler
        self.conformanceProfileStore = conformanceProfileStore
    }

    func runtimeStatus() -> CompanionRuntimeStatus {
        let readiness = providers.readiness()
        let provider = providers.provider(id: providers.defaults.companionModelProviderID)
        let status = provider.map { providers.statuses[$0.id] ?? ($0.enabled ? .ready : .notConfigured) } ?? .notConfigured
        return CompanionRuntimeStatus(currentMode: currentMode,
                                      selectedModel: selectedModelLabel(readiness: readiness),
                                      providerStatus: status,
                                      modelReadiness: readiness,
                                      permissionSummary: preferences.runtimePermissionSummary,
                                      memoryStatus: preferences.permissions.memoryEnabled ? "记忆开启" : "记忆关闭",
                                      lastError: lastError)
    }

    func sendCompanionMessage(_ userText: String) async -> Result<String, CompanionRuntimeMessageError> {
        let route = await ModelRouter().route(.companion,
                                              providers: providers.providers,
                                              defaults: providers.defaults,
                                              secretStore: providers.secretStore,
                                              conformancePolicy: await persistedConformancePolicy())
        switch route {
        case .failure(let error):
            lastError = error.userMessage
            currentMode = .error
            return .failure(.userFacing(error.userMessage))
        case .success:
            currentMode = .companion
            let conversationID = UUID()
            let userMessageID = UUID()
            let submitted = await scheduler.submit(AgentTaskSubmission(title: userText,
                                                                       priority: .normal,
                                                                       origin: .chat,
                                                                       conversationID: conversationID,
                                                                       userMessageID: userMessageID))
            _ = await scheduler.startAvailable()
            let record = await scheduler.record(taskID: submitted.taskID) ?? submitted
            let event = PetAgentEvent.userMessage(UserMessageEvent(conversationID: conversationID,
                                                                    messageID: userMessageID,
                                                                    text: userText,
                                                                    taskIDOverride: record.taskID,
                                                                    runIDOverride: record.runID))
            var reply = ""
            for await output in runtimeContainer.coordinator.handle(event) {
                if case .taskActivity(let event) = output {
                    await activityStore.eventHub.publish(AgentEventEnvelope(activityEvent: event))
                }
                if case .waitingForApproval(let capabilityID) = output {
                    await scheduler.waitForPermission(taskID: record.taskID, permissions: [capabilityID])
                }
                if case .responseCompleted = output {
                    await scheduler.finishFromRuntime(taskID: record.taskID, status: .succeeded)
                }
                if case .responseDelta(_, _, let text) = output { reply += text }
                if case .failed(_, let reason) = output {
                    await scheduler.finishFromRuntime(taskID: record.taskID,
                                                      status: .failed,
                                                      failureCategory: "runtimeFailed",
                                                      safeSummary: reason)
                    lastError = reason
                    currentMode = .error
                    return .failure(.userFacing(reason))
                }
                if case .cancelled = output {
                    await scheduler.finishFromRuntime(taskID: record.taskID, status: .cancelled)
                }
            }
            currentMode = .idle
            return .success(reply)
        }
    }

    func updateCompanionMode(_ mode: CompanionRuntimeMode) {
        currentMode = mode
        if mode != .error { lastError = nil }
    }

    func handleResultInteraction(_ interaction: AgentResultInteractionEvent) async {
        let existingRun = activityStore.run(id: interaction.runID)
        let nextSequence = UInt64((existingRun?.events.map(\.sequenceNumber).max() ?? 0) + 1)
        activityStore.publish(interaction.envelope(sequence: nextSequence, source: .chat))

        guard let document = existingRun?.resultDocument,
              let selectedChoiceID = interaction.selectedChoiceID else {
            return
        }
        let selectedTitle = interaction.selectedChoiceTitle ?? selectedChoiceID
        let summary = "已选择：\(selectedTitle)"
        let patch = AgentResultPatch(documentID: document.id,
                                     taskID: document.taskID,
                                     runID: document.runID,
                                     baseRevision: document.currentRevision,
                                     revision: document.currentRevision + 1,
                                     operations: [
                                        .resolveChoice(componentID: interaction.componentID,
                                                       choiceID: selectedChoiceID,
                                                       summary: summary)
                                     ],
                                     timestamp: interaction.timestamp)
        let catalog = ToolCatalogSnapshot(entries: ToolPlatformAssembly.releaseManifests.map {
            ToolCatalogEntry(manifest: $0, enabled: true)
        })
        let applied = AgentResultPatchReducer.apply(patch, to: document, toolCatalog: catalog)
        guard applied.accepted else { return }
        activityStore.publish(AgentEventEnvelope(
            taskID: document.taskID,
            runID: document.runID,
            sequence: nextSequence + 1,
            timestamp: interaction.timestamp,
            source: .runtime,
            kind: .resultPatch,
            payload: .result(.init(title: "结果已更新",
                                    summary: applied.document.summary,
                                    document: applied.document,
                                    eventKind: .patch,
                                    baseRevision: patch.baseRevision))))
    }

    func startFocusSession() {
        currentMode = .focus
    }

    func endFocusSession() {
        currentMode = .idle
    }

    func testSelectedModel() async -> ProviderConnectionStatus {
        guard let providerID = providers.defaults.companionModelProviderID else {
            lastError = ModelReadinessState.noProvider.label
            return .notConfigured
        }
        await providers.testConnection(providerID: providerID)
        let status = providers.statuses[providerID] ?? .notConfigured
        if case .failed(let message) = status { lastError = message }
        return status
    }

    private func selectedModelLabel(readiness: ModelReadinessState) -> String {
        switch readiness {
        case .ready(let providerName, let modelName):
            return "\(providerName) / \(modelName)"
        case .providerConnectedNoModel(let providerName):
            return "\(providerName) / 未选择模型"
        default:
            return readiness.label
        }
    }

    private func persistedConformancePolicy() async -> (any ModelRouter.ConformancePolicy)? {
        guard let conformanceProfileStore,
              let policy = try? await conformanceProfileStore.routingPolicy(),
              !policy.isEmpty else { return nil }
        return policy
    }
}

private extension AgentResultInteractionEvent {
    var selectedChoiceID: String? {
        guard case .object(let object) = payload,
              case .string(let value)? = object["choiceID"] else { return nil }
        return value
    }

    var selectedChoiceTitle: String? {
        guard case .object(let object) = payload,
              case .string(let value)? = object["title"] else { return nil }
        return value
    }
}

extension CapabilityPermissionState {
    var displayLabel: String {
        switch self {
        case .unknown: return "未知"
        case .notRequested: return "未开启"
        case .denied: return "已拒绝"
        case .grantedOnce: return "单次允许"
        case .grantedForSession: return "本次允许"
        case .grantedPersistently: return "允许"
        case .restricted: return "受限"
        case .unavailable: return "不可用"
        }
    }
}

extension PreferencesModel {
    var runtimePermissionSummary: RuntimePermissionSummary {
        RuntimePermissionSummary(screen: prefs.permissions.screenRead,
                                 microphone: prefs.permissions.microphone,
                                 memory: prefs.permissions.memoryEnabled ? .grantedPersistently : .denied,
                                 tools: prefs.permissions.tools)
    }
}
