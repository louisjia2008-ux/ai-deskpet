import Foundation
import Combine
import AICore
import PetBrainCore
import PetAgentRuntime

/// Main conversation model. P4.3 routes user input through PetAgentRuntimeCoordinator as the single
/// top-level runtime. ChatModel owns only UI-facing conversation/history bookkeeping and subscribes
/// to runtime output; it never calls a model or the legacy PetBrain runtime directly.
@MainActor
final class ChatModel: ObservableObject {

    @Published var conversation = Conversation()
    @Published var perception = PerceptionPolicy()
    @Published private(set) var cloudAuth = CloudAuthorization()
    @Published var lastDestination: ModelRouter.Destination = .local
    @Published var busy = false
    @Published private(set) var transientStatusText: String?
    @Published private(set) var waitingApprovalCapabilityID: String?
    @Published private(set) var activePlan: PlanPresentationSnapshot?
    @Published private(set) var activeTaskActivity: AgentTaskActivitySnapshot?
    @Published private(set) var conversations: [Conversation]
    /// P18.6 — observable durable-persistence failure for conversation history
    /// writes. `nil` when the last save reached disk; a user-facing message when it
    /// did not, so a finalized turn is never silently reported as persisted.
    @Published private(set) var lastPersistenceError: String?
    /// P18.6 — non-nil when the conversations file existed but could not be decoded
    /// and was quarantined at load, so a corrupt history is surfaced as recovery
    /// state instead of being presented as an empty history (which the next save
    /// would otherwise make permanent).
    @Published private(set) var loadCorruptionQuarantineURL: URL?

    /// P18 §22 — User-Explicit Screen Command. Toggled by the chat composer's
    /// "看看我现在的屏幕" button. Flips `useScreen: true` for the *next* message only;
    /// it reverts to false after the message is dispatched. Hidden when awareness
    /// level < L3.
    @Published var useScreenForNextMessage: Bool = false

    /// Fired on every pet reply so the desktop layer can bubble + react (doc §11.1).
    var onReply: (_ presentation: CharacterPresentation, _ isQuick: Bool) -> Void = { _, _ in }
    /// Fired for semantic animation lifecycle events. It must never change LLM text or persistence.
    var onAnimationEvent: (_ event: PetAgentAnimationEvent) -> Void = { _ in }

    private let runtime: PetAgentRuntimeCoordinator
    private let services: AIServices
    private let store: ChatStore
    let activityStore: AgentTaskActivityStore
    let scheduler: AgentTaskScheduler
    let localDiscoveryPresentationStore: LocalDiscoveryPresentationStore
    var placeHandoffViewModel: PlaceHandoffViewModel
    private var generationTask: Task<Void, Never>?
    private var activeTaskID: UUID?
    private var activeAttemptID: UUID?
    private var activeConversationID: UUID?
    private var activeRetryOfMessageID: UUID?
    private var activeRetryOfTaskID: UUID?
    private var activeRegeneratedFromMessageID: UUID?
    private var activeAssistantMessageID: UUID?
    private var activeUserMessageID: UUID?
    private var finalizedAssistantMessageIDs = Set<UUID>()
    private var terminalizedRunIDs = Set<UUID>()
    private var executionStates: [UUID: ConversationExecutionState] = [:]
    private let streamCoalescer = ChatResponseDeltaCoalescer()

    init(runtime: PetAgentRuntimeCoordinator,
         services: AIServices,
         store: ChatStore = ChatStore(),
         activityStore: AgentTaskActivityStore = AgentTaskActivityStore(),
         scheduler: AgentTaskScheduler? = nil,
         localDiscoveryPresentationStore: LocalDiscoveryPresentationStore? = nil,
         placeHandoffViewModel: PlaceHandoffViewModel? = nil) {
        self.runtime = runtime
        self.services = services
        self.store = store
        self.activityStore = activityStore
        self.scheduler = scheduler ?? AgentTaskScheduler(eventHub: activityStore.eventHub)
        self.localDiscoveryPresentationStore = localDiscoveryPresentationStore ?? LocalDiscoveryPresentationStore(checkpointStore: nil)
        self.placeHandoffViewModel = placeHandoffViewModel ?? PlaceHandoffViewModel()
        self.conversations = store.load()
        self.loadCorruptionQuarantineURL = store.lastLoadCorruptionURL
        reconcileInterruptedMessages()
        activityStore.loadPersistedHistory()
    }

    // MARK: Authorization (doc §11.3)

    func authorizeCloud(_ f: CloudAuthorization.Function) { cloudAuth.grant(f); services.setCloudAuthorized(true) }
    func revokeCloud(_ f: CloudAuthorization.Function) { cloudAuth.revoke(f); services.setCloudAuthorized(false) }

    // MARK: History (doc §12.4)

    var history: [Conversation] {
        conversations.filter { !$0.archived }.sorted { $0.updatedAt > $1.updatedAt }
    }

    func open(_ c: Conversation) {
        if conversation.kind.persists, !conversation.messages.isEmpty { upsert(conversation) }
        conversation = c
        refreshActiveTaskActivity()
    }
    func archive(_ c: Conversation) {
        guard let i = conversations.firstIndex(where: { $0.id == c.id }) else { return }
        conversations[i].archived = true; persistConversations()
    }
    func deleteConversation(_ c: Conversation) {
        conversations.removeAll { $0.id == c.id }
        persistConversations()
        executionStates[c.id] = nil
        if conversation.id == c.id { conversation = Conversation() }
        refreshActiveTaskActivity()
    }

    func newConversation(kind: ConversationKind) {
        if conversation.kind.persists, !conversation.messages.isEmpty { upsert(conversation) }
        conversation = Conversation(kind: kind)
        refreshActiveTaskActivity()
    }

    // MARK: Sending — delegates to the single PetAgent runtime

    func send(_ text: String, kind: AIRequestKind = .chat, useScreen: Bool = false) {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !busy else { return }
        // P18 §22 — when the user toggled "看看我现在的屏幕" we OR the explicit per-message
        // consent with the toggle so a `chat.send(...)` call site that already passes
        // `useScreen:` keeps working. Reset the toggle after the message dispatches so
        // it does NOT persist to subsequent turns.
        let combinedUseScreen = useScreen || useScreenForNextMessage
        let userMessage = appendUser(prompt)
        onAnimationEvent(.userMessageReceived)
        persist()
        startResponse(for: userMessage, kind: kind, useScreen: combinedUseScreen)
        useScreenForNextMessage = false
    }

    /// P18 §22 — UI helper for the "look at my screen" composer button.
    /// Sets the next-message toggle and returns the effective state.
    @discardableResult
    func setUseScreenForNextMessage(_ on: Bool) -> Bool {
        useScreenForNextMessage = on
        return useScreenForNextMessage
    }

    /// P18 §22 — Whether the chat composer should show the "look at my screen" button.
    /// Gated by the awareness policy: only enabled when the user has at least L3.
    var canRequestScreen: Bool {
        perception.maxLevel >= .screen
    }

    // MARK: Awareness snapshot mirroring (P18)

    /// P18 — Optional reference to the authoritative `DesktopAwarenessService`. The
    /// service is the single source of truth for foreground-app / window-title /
    /// screen-text snapshots; ChatModel mirrors it into its published shape so
    /// SwiftUI views can `@ObservedObject` ChatModel alone.
    weak var awarenessService: DesktopAwarenessService?

    /// P18 §23 — Convenience snapshot for the indicator chip. Reads from the
    /// `awarenessService` if wired; otherwise returns an empty snapshot. Falls
    /// back to the chip's "off" state when no service is attached so the chip
    /// silently hides itself.
    var awarenessSnapshot: AwarenessSnapshot {
        awarenessService?.snapshot ?? .empty
    }

    /// P18 §23 — Convenience for views that want to render the indicator chip.
    var awarenessIndicatorState: AwarenessIndicatorState {
        AwarenessIndicatorState.from(perception: perception,
                                     snapshot: awarenessSnapshot,
                                     screenAgeSeconds: nil)
    }

    /// Update the locally-mirrored `perception` from the service's current value.
    /// Called when the settings UI changes the level. Keeps `ChatModel.perception`
    /// in sync with the canonical service-level policy without forcing every
    /// call site to dereference the service directly.
    func pullPerceptionFromService() {
        guard let policy = awarenessService?.perception else { return }
        if perception != policy { perception = policy }
    }

    func pushPerceptionToService() {
        guard let service = awarenessService else { return }
        if service.perception != perception { service.updatePerceptionPolicy(perception) }
    }

    /// P18 §23 — Returns the age (in seconds) of the most recent screen capture,
    /// or nil when no capture has happened or it is older than the TTL. Used by
    /// the indicator chip to render "屏幕已读取 5s 前".
    func awarenessScreenAgeSeconds(now: Date = Date()) -> Int? {
        guard let capturedAt = awarenessService?.snapshot.screenText?.captureCompletedAt else {
            return nil
        }
        let age = now.timeIntervalSince(capturedAt)
        if age < 0 { return 0 }
        if age > DesktopAwarenessService.screenTextTTL { return nil }
        return Int(age)
    }

    func stopGenerating() {
        let conversationID = activeConversationID ?? conversation.id
        let execution = currentCancellableExecution(conversationID: conversationID)
        guard busy || execution != nil else { return }
        generationTask?.cancel()
        generationTask = nil
        Task {
            if let execution { await scheduler.cancel(taskID: execution.taskID) }
            await runtime.cancel(conversationID: conversationID)
            if let execution {
                await activityStore.catchUpFromEventHub()
                syncActivityHistoryBubble(taskID: execution.taskID,
                                          runID: execution.runID,
                                          conversationID: conversationID,
                                          userMessageID: activeUserMessageID)
            }
        }
        if let execution {
            terminalizedRunIDs.insert(execution.runID)
            markExecutionTerminal(taskID: execution.taskID, runID: execution.runID, conversationID: conversationID)
        }
        streamCoalescer.cancelAll()
        onAnimationEvent(.responseCancelled)
        markPendingAssistant(status: .cancelled)
        busy = false
        transientStatusText = nil
        activePlan = nil
        refreshActiveTaskActivity()
        clearActiveAttempt()
        persist()
    }

    func approveActivePlan() {
        guard activePlan?.canApprove == true else { return }
        let conversationID = conversation.id
        let taskID = activeTaskID
        Task {
            if let taskID { await scheduler.resolvePermission(taskID: taskID, granted: true) }
            await runtime.approveActivePlan(conversationID: conversationID)
        }
    }

    func cancelActivePlan() {
        guard activePlan != nil else { return }
        let conversationID = conversation.id
        let taskID = activeTaskID
        Task {
            if let taskID { await scheduler.cancel(taskID: taskID, reason: "approvalDenied") }
            await runtime.cancelActivePlan(conversationID: conversationID)
        }
    }

    func retry(_ assistantMessage: ChatMessage) {
        guard !busy, [.failed, .cancelled, .interrupted].contains(assistantMessage.status),
              let userMessage = previousUserMessage(before: assistantMessage.id) else { return }
        startResponse(for: userMessage, kind: .chat, useScreen: false,
                      retryOfMessageID: assistantMessage.id,
                      retryOfTaskID: assistantMessage.taskID)
    }

    func retryTask(_ taskID: UUID) {
        guard !busy,
              let snapshot = activityStore.task(id: taskID),
              let run = snapshot.latestRun,
              run.status.isTerminal else { return }
        if let conversationID = run.conversationID,
           conversation.id != conversationID,
           let target = conversations.first(where: { $0.id == conversationID }) {
            open(target)
        }
        var userMessage: ChatMessage?
        if let messageID = run.userMessageID {
            userMessage = conversation.messages.first(where: { $0.id == messageID && $0.role == .user })
        }
        if userMessage == nil, let activityMessage = conversation.messages.first(where: {
            $0.role == .activity && $0.taskID == taskID && $0.attemptID == run.runID
        }) {
            userMessage = previousUserMessage(before: activityMessage.id)
        }
        guard let userMessage else { return }
        startResponse(for: userMessage, kind: .chat, useScreen: false, retryOfTaskID: taskID)
    }

    func approveTask(_ taskID: UUID) {
        guard let conversationID = activityStore.task(id: taskID)?.latestRun?.conversationID else { return }
        Task {
            await scheduler.resolvePermission(taskID: taskID, granted: true)
            await runtime.approveActivePlan(conversationID: conversationID)
        }
    }

    func cancelTask(_ taskID: UUID) {
        guard let conversationID = activityStore.task(id: taskID)?.latestRun?.conversationID else { return }
        Task {
            await scheduler.cancel(taskID: taskID, reason: "approvalDenied")
            await runtime.cancelActivePlan(conversationID: conversationID)
        }
    }

    func stopTask(_ taskID: UUID) {
        guard let run = activityStore.task(id: taskID)?.latestRun,
              let conversationID = run.conversationID else { return }
        Task {
            await scheduler.cancel(taskID: taskID)
            await runtime.cancel(conversationID: conversationID)
            await activityStore.catchUpFromEventHub()
            syncActivityHistoryBubble(taskID: taskID,
                                      runID: run.runID,
                                      conversationID: conversationID,
                                      userMessageID: run.userMessageID)
        }
        if activeTaskID == taskID {
            if let runID = activeAttemptID {
                terminalizedRunIDs.insert(runID)
                markExecutionTerminal(taskID: taskID, runID: runID, conversationID: conversationID)
            }
            generationTask?.cancel()
            busy = false
            markPendingAssistant(status: .cancelled)
            clearActiveAttempt()
            persist()
        }
        refreshActiveTaskActivity()
    }

    func deleteTaskHistory(_ taskID: UUID) {
        activityStore.remove(taskID: taskID)
        refreshActiveTaskActivity()
    }

    func regenerate(_ assistantMessage: ChatMessage) {
        guard assistantMessage.role == .pet, assistantMessage.status == .completed,
              let userMessage = previousUserMessage(before: assistantMessage.id) else { return }
        if busy { stopGenerating() }
        guard !busy else { return }
        startResponse(for: userMessage, kind: .chat, useScreen: false,
                      regeneratedFromMessageID: assistantMessage.id)
    }

    private func startResponse(for userMessage: ChatMessage, kind: AIRequestKind, useScreen: Bool,
                               retryOfMessageID: UUID? = nil, retryOfTaskID: UUID? = nil,
                               regeneratedFromMessageID: UUID? = nil) {
        guard !busy else { return }
        busy = true
        activeTaskID = nil
        activeAttemptID = nil
        activeConversationID = conversation.id
        activeRetryOfMessageID = retryOfMessageID
        activeRetryOfTaskID = retryOfTaskID
        activeRegeneratedFromMessageID = regeneratedFromMessageID
        activeAssistantMessageID = nil
        activeUserMessageID = userMessage.id
        finalizedAssistantMessageIDs.removeAll()
        waitingApprovalCapabilityID = nil
        activePlan = nil
        activeTaskActivity = nil
        streamCoalescer.cancelAll()
        transientStatusText = "正在准备"
        let isQuick = (kind == .quick)
        let conversationID = conversation.id
        let conversationClass = conversationClass(conversation.kind)
        let intentContext = conversationIntentContext(before: userMessage, conversationID: conversationID)
        let metadata = UserMessageMetadata(useScreen: useScreen && perception.maxLevel >= .screen,
                                           source: isQuick ? "quickChat" : "mainChat",
                                           intentContext: intentContext)
        let origin: AgentTaskOrigin = retryOfTaskID == nil ? (isQuick ? .quickChat : .chat) : .retry

        generationTask?.cancel()
        generationTask = Task { [weak self] in
            guard let self else { return }
            let schedulerRecord: AgentTaskQueueRecord
            // Privacy dye: private chats must not leave user text in the scheduler
            // title, activity JSONL, run events, or checkpoints (doc §12.4). The
            // live UI still works — only disk writes are skipped (see
            // AgentTaskActivityStore.markPrivate).
            let submitIsPrivate = conversation.kind == .privateChat
            if let retryOfTaskID,
               let retry = await self.scheduler.retry(taskID: retryOfTaskID, reason: "manualRetry") {
                schedulerRecord = retry
            } else {
                schedulerRecord = await self.scheduler.submit(AgentTaskSubmission(
                    taskID: retryOfTaskID ?? UUID(),
                    title: submitIsPrivate ? "私密会话" : userMessage.text,
                    priority: .userInteractive,
                    createdAt: Date(),
                    origin: origin,
                    conversationID: conversationID,
                    userMessageID: userMessage.id,
                    isPrivate: submitIsPrivate))
            }
            if submitIsPrivate { self.activityStore.markPrivate(taskID: schedulerRecord.taskID) }
            _ = await self.scheduler.startAvailable()
            let activeRecord = await self.scheduler.record(taskID: schedulerRecord.taskID) ?? schedulerRecord
            self.activeTaskID = activeRecord.taskID
            self.activeAttemptID = activeRecord.runID
            self.activeConversationID = conversationID
            self.setActiveExecution(conversationID: conversationID,
                                    taskID: activeRecord.taskID,
                                    runID: activeRecord.runID)
            self.refreshActiveTaskActivity()
            let event = PetAgentEvent.userMessage(UserMessageEvent(
                conversationID: conversationID,
                messageID: userMessage.id,
                text: userMessage.text,
                conversationClass: conversationClass,
                retryOfMessageID: retryOfMessageID,
                retryOfTaskID: retryOfTaskID,
                regeneratedFromMessageID: regeneratedFromMessageID,
                taskIDOverride: activeRecord.taskID,
                runIDOverride: activeRecord.runID,
                metadata: metadata))
            self.onAnimationEvent(.thinkingStarted)
            for await output in self.runtime.handle(event) {
                if Task.isCancelled { break }
                await self.apply(output, isQuick: isQuick)
            }
            if self.busy { self.busy = false }
            self.transientStatusText = nil
            self.activePlan = nil
            self.refreshActiveTaskActivity()
            self.generationTask = nil
            self.clearActiveAttempt()
        }
    }

    // MARK: Message bookkeeping

    private func appendUser(_ text: String) -> ChatMessage {
        let message = ChatMessage(role: .user, text: text)
        conversation.messages.append(message)
        refreshConversationMetadata()
        return message
    }

    private func appendPresentation(_ p: CharacterPresentation) {
        for bubble in p.bubbles where !bubble.isEmpty {
            conversation.messages.append(ChatMessage(role: .pet, text: bubble,
                                                     emotion: p.emotion, viaCloud: p.viaCloud))
        }
        refreshConversationMetadata()
        persist()
    }

    private func conversationIntentContext(before userMessage: ChatMessage,
                                           conversationID: UUID) -> ConversationIntentContext? {
        guard let currentIndex = conversation.messages.firstIndex(where: { $0.id == userMessage.id }),
              let previousUserIndex = conversation.messages[..<currentIndex].lastIndex(where: { $0.role == .user }) else {
            return nil
        }
        let previousUser = conversation.messages[previousUserIndex]
        let turnMessages = conversation.messages[(previousUserIndex + 1)..<currentIndex]
        let activityRecords = turnMessages.compactMap(\.activity)
        let toolRecords = activityRecords.flatMap(\.tools)
        var previousCapabilities = RuntimeRequestPreparer
            .prepare(userText: previousUser.text)
            .inferredCapabilities
        if toolRecords.contains(where: { $0.toolID == "get_current_datetime" }),
           !previousCapabilities.contains(.currentDateTime) {
            previousCapabilities.append(.currentDateTime)
        }
        let previousSuccessfulToolIDs = uniqueStrings(toolRecords.compactMap { tool in
            tool.status == .succeeded ? tool.toolID : nil
        })
        guard !previousCapabilities.isEmpty || !previousSuccessfulToolIDs.isEmpty else {
            return nil
        }
        let latestActivity = activityRecords.last
        return ConversationIntentContext(
            conversationID: conversationID,
            recentUserGoal: previousUser.text,
            previousInferredCapabilities: previousCapabilities,
            previousSuccessfulToolIDs: previousSuccessfulToolIDs,
            previousOutcomeStatus: latestActivity.map { runtimeOutcomeStatus(for: $0.status) } ?? .unknown,
            previousCompletedAt: latestActivity?.completedAt ?? latestActivity?.updatedAt,
            recentAssistantCategory: recentAssistantCategory(from: Array(turnMessages))
        )
    }

    private func uniqueStrings(_ values: [String]) -> [String] {
        var result: [String] = []
        for value in values where !result.contains(value) {
            result.append(value)
        }
        return result
    }

    private func runtimeOutcomeStatus(for status: ChatActivityStatus) -> RuntimePreviousOutcomeStatus {
        switch status {
        case .succeeded:
            return .succeeded
        case .failed:
            return .failed
        case .cancelled:
            return .cancelled
        case .pending, .running, .waiting:
            return .running
        }
    }

    private func recentAssistantCategory(from messages: [ChatMessage]) -> String? {
        if let activity = messages.compactMap(\.activity).last {
            return "activity:\(activity.status.rawValue)"
        }
        if let assistant = messages.last(where: { $0.role == .pet }) {
            return "assistant:\(assistant.status.rawValue)"
        }
        return nil
    }

    private func apply(_ output: PetAgentRuntimeOutput, isQuick: Bool) async {
        switch output {
        case .taskStarted(let taskID, let attemptID, _):
            activeTaskID = taskID
            activeAttemptID = attemptID
            let conversationID = activeConversationID ?? conversation.id
            setActiveExecution(conversationID: conversationID, taskID: taskID, runID: attemptID)
            syncActivityHistoryBubble(taskID: taskID,
                                      runID: attemptID,
                                      conversationID: conversationID,
                                      userMessageID: activeUserMessageID)
            refreshActiveTaskActivity()
        case .taskActivity(let event):
            activityStore.publish(AgentEventEnvelope(activityEvent: event))
            syncActivityHistoryBubble(taskID: event.taskID,
                                      runID: event.runID,
                                      conversationID: event.conversationID,
                                      userMessageID: event.userMessageID)
            await completeScheduler(forTerminalEvent: event)
            // P15 — surface retry/recovery transient status so the
            // FloatingChat header shows "请求暂时受限，将自动重试…"
            // instead of generic "正在生成回复……".
            switch event.kind {
            case .taskWaitingForRetry:
                transientStatusText = "请求暂时受限，将自动重试…"
            case .taskRecovered:
                transientStatusText = "已恢复，继续处理…"
            default:
                break
            }
            refreshActiveTaskActivity()
        case .providerMetadata:
            break
        case .loopStateChanged(let state):
            transientStatusText = state.userVisibleStatus
        case .planUpdated(let snapshot):
            activePlan = snapshot
            transientStatusText = snapshot.status.userVisibleText
        case .responseStarted(let messageID):
            onAnimationEvent(.thinkingFinished)
            onAnimationEvent(.responseStarted)
            activeAssistantMessageID = messageID
            guard !conversation.messages.contains(where: { $0.id == messageID }) else { return }
            conversation.messages.append(ChatMessage(id: messageID, role: .pet, text: "", status: .pending,
                                                     retryOfMessageID: activeRetryOfMessageID,
                                                     regeneratedFromMessageID: activeRegeneratedFromMessageID,
                                                     taskID: activeTaskID,
                                                     attemptID: activeAttemptID))
            refreshConversationMetadata()
            persist()
        case .responseDelta(let messageID, let sequence, let text):
            onAnimationEvent(.responseDelta)
            guard !finalizedAssistantMessageIDs.contains(messageID) else { return }
            // P15 — strip thinking content at the ingestion boundary so the
            // coalescer never holds raw reasoning chunks in its buffer.
            let safeText = ThinkingContentFilter.filter(text).visible
            if streamCoalescer.ingest(messageID: messageID, sequence: sequence, text: safeText) {
                scheduleCoalescedFlush(messageID: messageID)
            }
        case .responseCompleted(let messageID, let emotion, let viaCloud):
            flushCoalescedDelta(messageID: messageID)
            guard finalizedAssistantMessageIDs.insert(messageID).inserted else { return }
            onAnimationEvent(.responseFinished(emotion: emotion))
            guard let i = conversation.messages.firstIndex(where: { $0.id == messageID }) else { return }
            conversation.messages[i].status = .completed
            conversation.messages[i].emotion = emotion
            conversation.messages[i].viaCloud = viaCloud
            lastDestination = viaCloud ? .cloud : .local
            await completeScheduler(status: .succeeded)
            finalizeAssistantTurn()
        case .presentation(let presentation):
            onAnimationEvent(.emotionChanged(presentation.emotion))
            lastDestination = presentation.viaCloud ? .cloud : .local
            onReply(presentation, isQuick)
        case .waitingForApproval(let capabilityID):
            waitingApprovalCapabilityID = capabilityID
            if let activeTaskID {
                Task { await scheduler.waitForPermission(taskID: activeTaskID, permissions: [capabilityID]) }
            }
        case .failed(let messageID, let reason):
            onAnimationEvent(.responseFailed)
            let userReason = UserFacingErrorPresenter.runtimeFailureMessage(from: reason)
            if let messageID {
                flushCoalescedDelta(messageID: messageID)
            }
            if let messageID, let i = conversation.messages.firstIndex(where: { $0.id == messageID }) {
                conversation.messages[i].status = .failed
                if conversation.messages[i].text.isEmpty { conversation.messages[i].text = userReason }
            } else {
                conversation.messages.append(ChatMessage(role: .pet, text: userReason, status: .failed))
            }
            // P14.2 — R-B-F01 closure. When the upstream provider
            // surfaced a typed `LlmFailure` (via
            // `ConversationChunk.typedError(...)`), the typed failure is
            // already in `pendingTypedFailure` (carried over from the
            // `converse()` chunk consumer). Use it to drive the typed
            // scheduler path. Otherwise fall back to the stringly-typed
            // path for non-typed failures.
            if let typed = Self.consumePendingTypedFailure(reason: reason) {
                await completeScheduler(status: .failed, llmFailure: typed, safeSummary: userReason)
            } else {
                await completeScheduler(status: .failed, failureCategory: "runtimeFailed", safeSummary: userReason)
            }
            finalizeAssistantTurn()
        case .typedFailed(let messageID, let llmFailure, _):
            // P14.2 — R-B-F01 closure. Direct typed-failure emission from
            // the coordinator when `converse()` caught a typed
            // `ConversationChunk.typedError(...)`. The legacy `.failed`
            // output is also emitted for any non-ChatModel consumers; this
            // typed variant is the production-reachable retry path.
            onAnimationEvent(.responseFailed)
            let userReason = UserFacingErrorPresenter.providerMessage(from: llmFailure)
            if let messageID {
                flushCoalescedDelta(messageID: messageID)
            }
            if let messageID, let i = conversation.messages.firstIndex(where: { $0.id == messageID }) {
                conversation.messages[i].status = .failed
                if conversation.messages[i].text.isEmpty { conversation.messages[i].text = userReason }
            } else {
                conversation.messages.append(ChatMessage(role: .pet, text: userReason, status: .failed))
            }
            await completeScheduler(status: .failed,
                                    llmFailure: llmFailure,
                                    safeSummary: userReason)
            finalizeAssistantTurn()
        case .cancelled(let messageID):
            onAnimationEvent(.responseCancelled)
            if let messageID {
                streamCoalescer.cancel(messageID: messageID)
            } else {
                streamCoalescer.cancelAll()
            }
            if let messageID { markAssistant(messageID: messageID, status: .cancelled) }
            else { markPendingAssistant(status: .cancelled) }
            await completeScheduler(status: .cancelled)
            finalizeAssistantTurn()
        }
    }

    /// P18.1 — Terminal finalization helper (APP-001 / APP-002 closure).
    ///
    /// Every assistant-turn terminal event (`.responseCompleted`,
    /// `.failed`, `.typedFailed`, `.cancelled`) MUST funnel through this
    /// single helper. The invariant is exactly-once persistence and
    /// exactly-once state clear:
    ///
    /// - `busy`, `waitingApprovalCapabilityID`, `activePlan`,
    ///   `transientStatusText`, `activeAssistantMessageID` cleared
    /// - `refreshActiveTaskActivity()` called once
    /// - `clearActiveAttempt()` called once
    /// - `refreshConversationMetadata()` called once
    /// - `persist()` called once (writes `conversations.json` once)
    ///
    /// Prior code in `.typedFailed` accidentally duplicated this block
    /// (write-twice bug) and `.failed` omitted it entirely (UI-stuck
    /// "正在回复" bug). Both defects collapse here.
    @MainActor
    private func finalizeAssistantTurn() {
        busy = false
        waitingApprovalCapabilityID = nil
        activePlan = nil
        transientStatusText = nil
        refreshActiveTaskActivity()
        activeAssistantMessageID = nil
        clearActiveAttempt()
        refreshConversationMetadata()
        persist()
    }

    private func scheduleCoalescedFlush(messageID: UUID) {
        Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: self.streamCoalescer.flushIntervalNanoseconds)
            self.flushCoalescedDelta(messageID: messageID)
        }
    }

    private func flushCoalescedDelta(messageID: UUID) {
        guard let text = streamCoalescer.flush(messageID: messageID) else { return }
        guard !finalizedAssistantMessageIDs.contains(messageID) else { return }
        guard let i = conversation.messages.firstIndex(where: { $0.id == messageID }) else { return }
        guard conversation.messages[i].status == .pending else { return }
        // P15 — strip provider thinking/reasoning content before it reaches
        // the user-visible chat message. The filter removes complete
        // <think>…</think> blocks, mid-stream openers, tool-call blocks,
        // and structured reasoning channels. Stripped bytes are discarded
        // (not shown as "removed by filter" — the user must see clean text).
        let filtered = ThinkingContentFilter.filter(text)
        conversation.messages[i].text += filtered.visible
        refreshConversationMetadata()
        persist()
    }

    private func markAssistant(messageID: UUID, status: MessageStatus) {
        guard let i = conversation.messages.firstIndex(where: { $0.id == messageID }) else { return }
        conversation.messages[i].status = status
        refreshConversationMetadata()
    }

    private func markPendingAssistant(status: MessageStatus) {
        guard let i = conversation.messages.lastIndex(where: { $0.role == .pet && $0.status == .pending }) else { return }
        conversation.messages[i].status = status
        refreshConversationMetadata()
    }

    private func refreshActiveTaskActivity() {
        guard let state = executionStates[conversation.id],
              let activeTaskID = state.activeTaskID,
              let activeRunID = state.activeRunID,
              let snapshot = activityStore.task(id: activeTaskID),
              let run = snapshot.latestRun,
              run.runID == activeRunID,
              run.conversationID == conversation.id,
              !run.status.isTerminal else {
            activeTaskActivity = nil
            return
        }
        activeTaskActivity = snapshot
    }

    private func syncActivityHistoryBubble(taskID: UUID,
                                           runID: UUID,
                                           conversationID: UUID?,
                                           userMessageID: UUID?) {
        guard let record = chatActivityRecord(taskID: taskID, runID: runID) else { return }
        let targetConversationID = conversationID ?? record.conversationID ?? activeConversationID
        guard targetConversationID == conversation.id else { return }
        if let index = conversation.messages.firstIndex(where: {
            $0.role == .activity && $0.taskID == taskID && $0.attemptID == runID
        }) {
            conversation.messages[index].activity = record
            conversation.messages[index].text = record.summary
            conversation.messages[index].status = messageStatus(for: record.status)
        } else {
            conversation.messages.append(ChatMessage(role: .activity,
                                                     text: record.summary,
                                                     timestamp: record.createdAt,
                                                     status: messageStatus(for: record.status),
                                                     taskID: taskID,
                                                     attemptID: runID,
                                                     activity: record))
        }
        refreshConversationMetadata()
        persist()
    }

    private func chatActivityRecord(taskID: UUID, runID: UUID) -> ChatActivityRecord? {
        guard let run = activityStore.task(id: taskID)?.runs.first(where: { $0.runID == runID }) else {
            return nil
        }
        let tools = chatActivityTools(for: run)
        guard !tools.isEmpty else { return nil }
        return ChatActivityRecord(taskID: taskID,
                                  runID: runID,
                                  conversationID: run.conversationID,
                                  userMessageID: run.userMessageID,
                                  status: chatActivityStatus(for: run.status),
                                  summary: chatActivitySummary(for: run, tools: tools),
                                  detail: chatActivityDetail(for: run, toolCount: tools.count),
                                  tools: tools,
                                  createdAt: run.createdAt,
                                  updatedAt: run.updatedAt,
                                  completedAt: run.completedAt)
    }

    private func chatActivityTools(for run: AgentTaskRunActivity) -> [ChatActivityToolRecord] {
        var tools: [String: ChatActivityToolDraft] = [:]
        for event in run.events.sorted(by: activityEventSort) {
            guard let toolID = toolID(for: event) else { continue }
            let metadata = ToolPresentationMetadata.metadata(for: toolID)
            let key = event.stepID ?? toolID
            let incoming = toolStatus(for: event.kind)
            // P19.1 — capture the runtime-sanitized result detail (which now flows
            // through `PetAgentRuntimeCoordinator.toolObserved` for `stepSucceeded`
            // / `verificationSucceeded` events). We DO NOT synthesize a preview here:
            // see `ToolOutputPreviewBuilder` for the truthfulness contract. The
            // event's `presentation.detail` is itself the runner's
            // `userSafeSummary` (already redacted via `AgentPrivacyRedactor.safeSummary`).
            let eventDetail = event.presentation.detail
            let capturedPreview: String? = {
                guard incoming == .succeeded,
                      let detail = eventDetail,
                      !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                else { return nil }
                return ToolOutputPreviewBuilder.preview(toolID: toolID,
                                                       rawUserSafeSummary: detail)
            }()
            var draft = tools[key] ?? ChatActivityToolDraft(key: key,
                                                            toolID: toolID,
                                                            displayName: metadata.displayName,
                                                            icon: metadata.icon,
                                                            status: incoming,
                                                            title: toolTitle(toolID: toolID, status: incoming),
                                                            resultPreview: capturedPreview,
                                                            updatedAt: event.timestamp)
            if event.kind == .verificationStarted {
                draft.status = .running
            } else {
                draft.status = prioritizedToolStatus(current: draft.status, incoming: incoming)
            }
            draft.title = toolTitle(toolID: toolID, status: draft.status)
            // P19.1 — keep the most recently-captured preview (the latest succeeded
            // event for this tool wins). This matches the same "newest write wins"
            // rule as `updatedAt`.
            if capturedPreview != nil { draft.resultPreview = capturedPreview }
            draft.updatedAt = max(draft.updatedAt, event.timestamp)
            tools[key] = draft
        }
        return tools.values
            .sorted {
                if $0.updatedAt != $1.updatedAt { return $0.updatedAt < $1.updatedAt }
                return $0.key < $1.key
            }
            .map {
                ChatActivityToolRecord(key: $0.key,
                                       toolID: $0.toolID,
                                       displayName: $0.displayName,
                                       icon: $0.icon,
                                       status: $0.status,
                                       title: $0.title,
                                       resultPreview: $0.resultPreview,
                                       updatedAt: $0.updatedAt)
            }
    }

private func activityEventSort(_ lhs: AgentTaskActivityEvent, _ rhs: AgentTaskActivityEvent) -> Bool {
        if lhs.sequenceNumber != rhs.sequenceNumber { return lhs.sequenceNumber < rhs.sequenceNumber }
        if lhs.timestamp != rhs.timestamp { return lhs.timestamp > rhs.timestamp }
        return lhs.eventID.uuidString < rhs.eventID.uuidString
    }

    private func toolID(for event: AgentTaskActivityEvent) -> String? {
        if let raw = event.toolID?.rawValue, !raw.isEmpty { return raw }
        guard let stepID = event.stepID else { return nil }
        if stepID.contains("get_current_datetime") || stepID == "currentDateTime" {
            return "get_current_datetime"
        }
        return nil
    }

    private func toolStatus(for kind: AgentTaskEventKind) -> ChatActivityStatus {
        switch kind {
        case .stepSucceeded, .verificationSucceeded, .synthesisSucceeded, .taskSucceeded:
            return .succeeded
        case .stepFailed, .verificationFailed, .replanFailed, .taskFailed, .taskPartiallySucceeded:
            return .failed
        case .stepSkipped, .taskCancelled:
            return .cancelled
        case .approvalRequested:
            return .waiting
        case .taskCreated, .taskQueued, .planningStarted, .planProposed:
            return .pending
        default:
            return .running
        }
    }

    private func prioritizedToolStatus(current: ChatActivityStatus,
                                       incoming: ChatActivityStatus) -> ChatActivityStatus {
        if incoming.isTerminal { return incoming }
        if current.isTerminal { return current }
        if incoming == .waiting { return .waiting }
        if incoming == .running { return .running }
        return current
    }

    private func toolTitle(toolID: String, status: ChatActivityStatus) -> String {
        let metadata = ToolPresentationMetadata.metadata(for: toolID)
        switch status {
        case .succeeded: return metadata.succeededTitle
        case .failed: return metadata.failedTitle
        case .cancelled: return "已停止"
        case .waiting: return "等待你的确认"
        case .pending, .running: return metadata.runningTitle
        }
    }

    private func chatActivityStatus(for status: AgentTaskStatus) -> ChatActivityStatus {
        switch status {
        case .succeeded:
            return .succeeded
        case .partiallySucceeded, .failed, .interrupted, .unknown:
            return .failed
        case .cancelled:
            return .cancelled
        case .waitingForApproval, .waitingForPermission, .waitingForUser, .paused:
            return .waiting
        case .created, .queued, .planning:
            return .pending
        case .running, .synthesizing:
            return .running
        }
    }

    private func chatActivitySummary(for run: AgentTaskRunActivity,
                                     tools: [ChatActivityToolRecord]) -> String {
        if tools.count == 1, let tool = tools.first {
            return tool.title
        }
        switch chatActivityStatus(for: run.status) {
        case .succeeded:
            return "已完成"
        case .failed:
            return userFacingFailureSummary(for: run)
        case .cancelled:
            return "已停止"
        case .waiting:
            return "等待你的确认"
        case .pending, .running:
            return "正在执行操作…"
        }
    }

    private func chatActivityDetail(for run: AgentTaskRunActivity, toolCount: Int) -> String? {
        guard run.status.isTerminal else { return nil }
        switch chatActivityStatus(for: run.status) {
        case .succeeded:
            return toolCount > 1 ? "\(toolCount) 个操作已完成" : nil
        case .failed:
            return userFacingFailureSummary(for: run)
        case .cancelled:
            return "已停止"
        case .pending, .running, .waiting:
            return nil
        }
    }

    private func userFacingFailureSummary(for run: AgentTaskRunActivity) -> String {
        if let terminal = run.userVisibleTerminalSummary {
            return UserFacingErrorPresenter.runtimeFailureMessage(from: terminal)
        }
        if let detail = run.userVisibleEvents.last?.presentation.detail {
            return UserFacingErrorPresenter.runtimeFailureMessage(from: detail)
        }
        if let category = run.events.last?.failureCategory {
            switch category {
            case .permissionDenied, .approvalRejected, .approvalTimedOut:
                return "已取消这个操作。"
            case .providerUnavailable:
                return "暂时无法连接到模型。"
            case .interrupted:
                return "上次生成被应用重启打断，可以重试。"
            case .cancelled:
                return "已停止"
            case .toolTimedOut, .toolFailed, .validationFailed:
                return "这个操作没有完成。"
            case .planningFailed, .synthesisFailed, .unknown:
                break
            }
        }
        return "这个操作没有完成。"
    }

    private func messageStatus(for status: ChatActivityStatus) -> MessageStatus {
        switch status {
        case .succeeded:
            return .completed
        case .failed:
            return .failed
        case .cancelled:
            return .cancelled
        case .pending, .running, .waiting:
            return .pending
        }
    }

    private func completeScheduler(status: AgentTaskSchedulerStatus,
                                   failureCategory: String? = nil,
                                   safeSummary: String? = nil) async {
        guard let taskID = activeTaskID,
              let runID = activeAttemptID else { return }
        await finishRunOnce(taskID: taskID,
                            runID: runID,
                            conversationID: activeConversationID,
                            status: status,
                            failureCategory: failureCategory,
                            safeSummary: safeSummary)
    }

    /// P14.2 — R-B-F01 closure. Typed-failure completion path used by
    /// the production `.failed` handler when the upstream provider
    /// surfaced a typed `LlmFailure`. Routes the failure through
    /// `AgentTaskScheduler.finishFromRuntime(... llmFailure:)` so the
    /// scheduler's typed retry decision is reached from production.
    private func completeScheduler(status: AgentTaskSchedulerStatus,
                                   llmFailure: LlmFailure,
                                   safeSummary: String? = nil) async {
        guard let taskID = activeTaskID,
              let runID = activeAttemptID else { return }
        await finishRunOnce(taskID: taskID,
                            runID: runID,
                            conversationID: activeConversationID,
                            status: status,
                            llmFailure: llmFailure,
                            safeSummary: safeSummary)
    }

    private func currentCancellableExecution(conversationID: UUID) -> (taskID: UUID, runID: UUID)? {
        if let taskID = activeTaskID, let runID = activeAttemptID {
            return (taskID, runID)
        }
        if let state = executionStates[conversationID],
           let taskID = state.activeTaskID,
           let runID = state.activeRunID {
            return (taskID, runID)
        }
        guard let task = activityStore.latestTask(conversationID: conversationID),
              let run = task.latestRun,
              !run.status.isTerminal else {
            return nil
        }
        return (task.taskID, run.runID)
    }

    private func completeScheduler(forTerminalEvent event: AgentTaskActivityEvent) async {
        guard event.taskID == activeTaskID else { return }
        switch event.kind {
        case .taskSucceeded:
            await completeScheduler(status: .succeeded)
        case .taskPartiallySucceeded:
            await completeSchedulerPartially(failureCategory: event.failureCategory?.rawValue ?? "partialSuccess",
                                             safeSummary: event.presentation.detail ?? event.presentation.title)
        case .taskFailed:
            await completeScheduler(status: .failed,
                                    failureCategory: event.failureCategory?.rawValue ?? "runtimeFailed",
                                    safeSummary: event.presentation.detail ?? event.presentation.title)
        case .taskCancelled:
            await completeScheduler(status: .cancelled,
                                    failureCategory: event.failureCategory?.rawValue,
                                    safeSummary: event.presentation.detail ?? event.presentation.title)
        case .taskInterrupted:
            await completeScheduler(status: .failed,
                                    failureCategory: event.failureCategory?.rawValue ?? "interrupted",
                                    safeSummary: event.presentation.detail ?? event.presentation.title)
        default:
            break
        }
    }

    private func completeSchedulerPartially(failureCategory: String?,
                                            safeSummary: String?) async {
        guard let taskID = activeTaskID,
              let runID = activeAttemptID else { return }
        guard terminalizedRunIDs.insert(runID).inserted else { return }
        await scheduler.partiallyCompleteFromRuntime(taskID: taskID,
                                                     failureCategory: failureCategory,
                                                     safeSummary: safeSummary)
        markExecutionTerminal(taskID: taskID,
                              runID: runID,
                              conversationID: activeConversationID)
    }

    private func finishRunOnce(taskID: UUID,
                               runID: UUID,
                               conversationID: UUID?,
                               status: AgentTaskSchedulerStatus,
                               failureCategory: String?,
                               safeSummary: String?) async {
        guard terminalizedRunIDs.insert(runID).inserted else { return }
        await scheduler.finishFromRuntime(taskID: taskID,
                                          status: status,
                                          failureCategory: failureCategory,
                                          safeSummary: safeSummary)
        markExecutionTerminal(taskID: taskID, runID: runID, conversationID: conversationID)
    }

    /// P14.2 — R-B-F01 closure. Typed-failure overload used by the
    /// production `.failed` path. Threads the typed `LlmFailure` through
    /// `AgentTaskScheduler.finishFromRuntime(... llmFailure:)` so the
    /// scheduler's typed retry decision is reached from production.
    private func finishRunOnce(taskID: UUID,
                               runID: UUID,
                               conversationID: UUID?,
                               status: AgentTaskSchedulerStatus,
                               llmFailure: LlmFailure,
                               safeSummary: String?) async {
        guard terminalizedRunIDs.insert(runID).inserted else { return }
        await scheduler.finishFromRuntime(taskID: taskID,
                                          status: status,
                                          llmFailure: llmFailure,
                                          safeSummary: safeSummary)
        markExecutionTerminal(taskID: taskID, runID: runID, conversationID: conversationID)
    }

    private func setActiveExecution(conversationID: UUID, taskID: UUID, runID: UUID) {
        var state = executionStates[conversationID] ?? ConversationExecutionState(conversationID: conversationID)
        state.activeTaskID = taskID
        state.activeRunID = runID
        state.queuedTaskIDs.removeAll { $0 == taskID }
        executionStates[conversationID] = state
    }

    private func markExecutionTerminal(taskID: UUID, runID: UUID, conversationID: UUID?) {
        let resolvedConversationID = conversationID
            ?? executionStates.first { $0.value.activeTaskID == taskID && $0.value.activeRunID == runID }?.key
        if let resolvedConversationID {
            var state = executionStates[resolvedConversationID] ?? ConversationExecutionState(conversationID: resolvedConversationID)
            if state.activeTaskID == taskID && state.activeRunID == runID {
                state.activeTaskID = nil
                state.activeRunID = nil
                state.lastTerminalTaskID = taskID
            }
            executionStates[resolvedConversationID] = state
        }
        refreshActiveTaskActivity()
    }

    private func refreshConversationMetadata() {
        if conversation.title == "新对话", let first = conversation.messages.first?.text {
            conversation.title = String(first.prefix(16))
        }
        conversation.updatedAt = Date()
    }

    private func previousUserMessage(before messageID: UUID) -> ChatMessage? {
        guard let index = conversation.messages.firstIndex(where: { $0.id == messageID }) else { return nil }
        return conversation.messages[..<index].last { $0.role == .user }
    }

    private func clearActiveAttempt() {
        activeTaskID = nil
        activeAttemptID = nil
        activeConversationID = nil
        activeRetryOfMessageID = nil
        activeRetryOfTaskID = nil
        activeRegeneratedFromMessageID = nil
        activeAssistantMessageID = nil
        activeUserMessageID = nil
        refreshActiveTaskActivity()
    }

    private func reconcileInterruptedMessages() {
        var changed = false
        for convIndex in conversations.indices {
            for msgIndex in conversations[convIndex].messages.indices {
                if conversations[convIndex].messages[msgIndex].role == .pet,
                   conversations[convIndex].messages[msgIndex].status == .pending {
                    conversations[convIndex].messages[msgIndex].status = .interrupted
                    if conversations[convIndex].messages[msgIndex].text.isEmpty {
                        conversations[convIndex].messages[msgIndex].text = "上次生成被应用重启打断，可以重试。"
                    }
                    changed = true
                }
            }
        }
        if changed { persistConversations() }
    }

    private func conversationClass(_ k: ConversationKind) -> ConversationClass {
        switch k {
        case .privateChat: return .privateChat
        case .temporary: return .temporary
        case .normal, .project: return .normal
        }
    }

    private func persist() {
        guard conversation.kind.persists else { return }
        upsert(conversation)
        persistConversations()
    }

    /// P18.6 — single choke point for writing conversation history to disk.
    /// Surfaces any durable-write failure through the observable
    /// `lastPersistenceError` instead of the previous silent `try?`, so a
    /// finalized/archived/deleted conversation is never reported as persisted when
    /// the write did not reach disk. Does not change *when* we persist (the P18.1
    /// exactly-once terminal-persist contract is unaffected) — only whether a
    /// failure is observable.
    private func persistConversations() {
        do {
            try store.save(conversations)
            lastPersistenceError = nil
        } catch {
            lastPersistenceError = SealedStore.describe(error, fallback: "对话保存失败")
        }
    }
    private func upsert(_ c: Conversation) {
        if let i = conversations.firstIndex(where: { $0.id == c.id }) { conversations[i] = c }
        else { conversations.append(c) }
    }
}

private struct ConversationExecutionState: Sendable, Equatable {
    let conversationID: UUID
    var activeTaskID: UUID?
    var activeRunID: UUID?
    var queuedTaskIDs: [UUID] = []
    var lastTerminalTaskID: UUID?
}

private struct ChatActivityToolDraft: Sendable {
    var key: String
    var toolID: String
    var displayName: String
    var icon: String
    var status: ChatActivityStatus
    var title: String
    /// P19.1 — captured from the runtime's `AgentToolObservation.userSafeSummary`
    /// (already sanitized) via the matching `stepSucceeded` / `verificationSucceeded`
    /// activity event's `presentation.detail`. `nil` when the runtime hasn't surfaced
    /// a trustworthy result yet.
    var resultPreview: String?
    var updatedAt: Date
}

extension ChatActivityStatus {
    var isTerminal: Bool {
        switch self {
        case .succeeded, .failed, .cancelled:
            return true
        case .pending, .running, .waiting:
            return false
        }
    }
}

private extension PlanStatus {
    var userVisibleText: String? {
        switch self {
        case .planning:
            return "正在制定计划"
        case .validating:
            return "正在检查计划"
        case .awaitingApproval:
            return "等待计划确认"
        case .approved:
            return "计划已确认"
        case .executing:
            return "正在执行计划"
        case .replanning:
            return "正在调整计划"
        case .verifying:
            return "正在验证执行结果"
        case .synthesizing:
            return "正在整理结果"
        case .completed:
            return "计划完成"
        case .partiallyCompleted:
            return "计划部分完成"
        case .cancelled:
            return "计划已取消"
        case .failed:
            return "计划失败"
        case .unknown:
            return nil
        }
    }
}

// P14.2 — R-B-F01 closure. Heuristic mapping from a stringly-typed
// failure reason (e.g. "API Key 无效或已失效。", "暂时无法连接到模型。")
// to a typed `LlmFailure`. Used when the `.failed` handler at the chat
// boundary needs to drive the typed scheduler retry path.
extension ChatModel {
    /// Process-local storage for a typed failure carried from a recent
    /// `ConversationChunk.typedError(...)` stream to the chat boundary.
    /// The coordinator's `converse()` catch block writes here before
    /// the surface; `handle(.failed)` reads + clears.
    fileprivate static var pendingTypedFailure: LlmFailure?

    static func consumePendingTypedFailure(reason: String) -> LlmFailure? {
        defer { pendingTypedFailure = nil }
        if let stored = pendingTypedFailure { return stored }
        // Fallback: synthesize from a substring heuristic (kept narrow
        // — only the well-known patterns from UserFacingErrorPresenter).
        let lower = reason.lowercased()
        if lower.contains("api key") || lower.contains("401") || lower.contains("unauthorized") {
            return LlmFailure(code: .authenticationFailed, message: reason, httpStatus: 401)
        }
        if lower.contains("404") || lower.contains("model not found") {
            return LlmFailure(code: .modelNotFound, message: reason, httpStatus: 404)
        }
        if lower.contains("连接") || lower.contains("connection") || lower.contains("timeout") || lower.contains("network") {
            return LlmFailure(code: .transportFailure, message: reason)
        }
        return nil
    }

    static func setPendingTypedFailure(_ failure: LlmFailure?) {
        pendingTypedFailure = failure
    }

    // MARK: - DEBUG-only test helpers (P15.1 GUI acceptance harness)

    #if DEBUG
    /// Test-only: register an in-flight execution so `refreshActiveTaskActivity` will
    /// surface `activeTaskActivity` from `activityStore.task(id:)` for the current
    /// conversation.
    func _p15_1SetActiveExecution(conversationID: UUID, taskID: UUID, runID: UUID) {
        var state = executionStates[conversationID] ?? ConversationExecutionState(conversationID: conversationID)
        state.activeTaskID = taskID
        state.activeRunID = runID
        executionStates[conversationID] = state
        refreshActiveTaskActivity()
    }

    /// Test-only: clear in-flight execution state (after a terminal task).
    func _p15_1ClearActiveExecution(conversationID: UUID) {
        var state = executionStates[conversationID] ?? ConversationExecutionState(conversationID: conversationID)
        state.activeTaskID = nil
        state.activeRunID = nil
        state.lastTerminalTaskID = executionStates[conversationID]?.activeTaskID ?? state.lastTerminalTaskID
        executionStates[conversationID] = state
        refreshActiveTaskActivity()
    }

    /// Test-only: append a user message directly to the conversation (no runtime side effects).
    func _p15_1AppendUserMessage(text: String, conversationID: UUID) {
        ensureConversationExists(id: conversationID)
        if let idx = conversations.firstIndex(where: { $0.id == conversationID }) {
            conversations[idx].messages.append(ChatMessage(role: .user, text: text))
            conversations[idx].updatedAt = Date()
        }
        if conversation.id == conversationID {
            conversation.messages.append(ChatMessage(role: .user, text: text))
            conversation.updatedAt = Date()
        }
    }

    /// Test-only: append an assistant message directly to the conversation (no runtime side effects).
    func _p15_1AppendAssistantMessage(text: String,
                                      conversationID: UUID,
                                      taskID: UUID,
                                      runID: UUID,
                                      status: MessageStatus = .completed) {
        ensureConversationExists(id: conversationID)
        let record = makeChatActivityRecord(taskID: taskID, runID: runID)
        let activity = ChatActivityMessageHelpers.makeActivityMessage(
            text: text, status: status, taskID: taskID, runID: runID, record: record)
        if let idx = conversations.firstIndex(where: { $0.id == conversationID }) {
            conversations[idx].messages.append(activity)
            conversations[idx].updatedAt = Date()
        }
        if conversation.id == conversationID {
            conversation.messages.append(activity)
            conversation.updatedAt = Date()
            syncActivityHistoryBubble(taskID: taskID, runID: runID,
                                      conversationID: conversationID,
                                      userMessageID: nil)
        }
    }

    /// Test-only: switch the active conversation.
    func _p15_1OpenConversation(id conversationID: UUID) {
        if let target = conversations.first(where: { $0.id == conversationID }) {
            open(target)
        } else {
            ensureConversationExists(id: conversationID)
            if let target = conversations.first(where: { $0.id == conversationID }) {
                open(target)
            }
        }
        refreshActiveTaskActivity()
    }

    /// Test-only: create a new conversation (so the harness can run multiple scenarios).
    func _p15_1CreateConversation(kind: ConversationKind = .normal) -> UUID {
        let c = Conversation(kind: kind)
        conversations.append(c)
        return c.id
    }

    private func ensureConversationExists(id: UUID) {
        if !conversations.contains(where: { $0.id == id }) {
            let c = Conversation(id: id)
            conversations.append(c)
        }
    }

    private func makeChatActivityRecord(taskID: UUID, runID: UUID) -> ChatActivityRecord? {
        chatActivityRecord(taskID: taskID, runID: runID)
    }

    /// Test-only: drive a `taskActivity` event through the real `apply` path
    /// so that `transientStatusText` and `syncActivityHistoryBubble` are
    /// updated exactly as production does.
    func _p15_1DriveTaskActivity(event: AgentTaskActivityEvent) async {
        await apply(PetAgentRuntimeOutput.taskActivity(event), isQuick: false)
    }
    #endif
}

#if DEBUG
private enum ChatActivityMessageHelpers {
    static func makeActivityMessage(text: String,
                                    status: MessageStatus,
                                    taskID: UUID,
                                    runID: UUID,
                                    record: ChatActivityRecord?) -> ChatMessage {
        ChatMessage(role: .activity,
                    text: record?.summary ?? text,
                    timestamp: record?.createdAt ?? Date(),
                    status: status,
                    taskID: taskID,
                    attemptID: runID,
                    activity: record)
    }
}
#endif
