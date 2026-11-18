import AppKit
import AICore
import PetBrainCore
import PetAgentRuntime
import Combine

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {

    #if DEBUG
    private var live2dDevelopmentWindow: Live2DDevelopmentWindow?
    private var canonicalAcceptanceTask: Task<Void, Never>?
    #endif
    private var overlay: OverlayWindowController!
    private var statusItem: StatusItemController!
    private var mainWindow: MainWindowController!
    private var quickTask: QuickTaskPanel!
    private var quickChat: QuickChatPanel!
    private var floatingChat: FloatingChatPanelController!
    private let hotKeys = HotKeys()
    private let state = PetState()
    private var appEnvironment: DeskPetAppEnvironment!
    private var uiState: AppUIStateStore!
    private var model: AppModel!
    private let llm = LLMService()
    private var chat: ChatModel!
    private var screenReader: ScreenReader!
    private var aiServices: AIServices!
    private let voice = VoiceService()
    private var memory: MemoryModel!
    private var relationship: RelationshipModel!
    private var prefs: PreferencesModel!
    private var providers: ProviderStore!
    private var backup: BackupService!
    private var security: SecurityKernel!                       // P2 security kernel (broker + isolated runner)
    private var petAgent: PetAgentRuntimeCoordinator!          // native agent runtime (no external runtime)
    private var runtimeContainer: AgentRuntimeContainer!       // P5.0 single DI container; owns the one coordinator
    private var runtimeBootstrapTask: Task<Void, Never>?
    private var companionRuntime: CompanionAgentRuntimeModel!
    private var petIntentRouter: PetUIIntentRouter!           // P5.1 UI → pet animation intent bridge
    private var agentLedger: JSONAgentTaskLedgerStore!
    private var scheduler: TaskScheduler!                     // P5 scheduled/recurring tasks
    private var agentActivityStore: AgentTaskActivityStore!
    private var agentScheduler: AgentTaskScheduler!
    private var onboardingCoordinator: OnboardingCoordinator!
    private var presenceCoordinator: CharacterPresenceCoordinator!
    private var presenceStoreCancellables: Set<AnyCancellable> = []
    private var awarenessCancellables: Set<AnyCancellable> = []
    private var awarenessService: DesktopAwarenessService?
    /// D3 — non-nil when the Keychain data key could not be resolved at launch
    /// (sealed stores unavailable; see applicationDidFinishLaunching).
    private(set) var vaultUnavailableReason: String?
    /// P19.1 / P0-A — single shared `AwarenessPermissionObserver` for both the
    /// awareness service and the onboarding + settings permission rows. We hold
    /// it here so the foreground-activation refresh (see
    /// `applicationDidBecomeActive`) refreshes the same observer the UI binds to.
    private var awarenessPermissionObserver: AwarenessPermissionObserver?

    @MainActor
    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { @MainActor in
            await self.applicationDidFinishLaunchingImpl(notification)
        }
    }

    @MainActor
    private func applicationDidFinishLaunchingImpl(_ notification: Notification) async {
        do {
            appEnvironment = try DeskPetAppEnvironment.fromProcess()
        } catch {
            // P22 — surface a native alert instead of dropping the user into
            // an unexplained `terminate`. The alert gives the path / reason
            // so support can reproduce, plus a "Open Console" affordance
            // that opens Console.app filtered to our subsystem.
            FileHandle.standardError.write("DESKPET_ENVIRONMENT_ERROR \(error.localizedDescription)\n".data(using: .utf8)!)
            presentEnvironmentErrorAlert(error: error)
            NSApp.terminate(nil)
            return
        }
        let paths = appEnvironment.paths
        // D3 at-rest encryption: production requires the Keychain data key
        // before any persistent store is constructed. Failure terminates
        // visibly, so no store can silently fall back to plaintext.
        SealedStore.persistencePolicy = .encryptionRequired
        do {
            SealedStore.cachedKey = try VaultKey.current()
        } catch {
            vaultUnavailableReason = "\(error)"
            FileHandle.standardError.write(
                "DESKPET_VAULT_UNAVAILABLE \(error)\n".data(using: .utf8)!)
            presentVaultErrorAlert()
            NSApp.terminate(nil)
            return
        }
        uiState = AppUIStateStore(backend: appEnvironment.uiStateBackend)
        model = AppModel(store: TaskStore(fileURL: paths.tasksURL))
        memory = MemoryModel(store: MemoryStore(fileURL: paths.memoriesURL))
        relationship = RelationshipModel(store: RelationshipStore(fileURL: paths.relationshipURL))
        prefs = PreferencesModel(fileURL: paths.preferencesURL)
        let checkpointStore = AgentCheckpointStore(baseDirectory: paths.agentCheckpointsDirectory)
        let sideEffectLedgerStore = AgentSideEffectLedgerStore(baseDirectory: paths.agentSideEffectsDirectory)
        let conformanceProfileStore = ModelConformanceProfileStore(baseDirectory: paths.modelConformanceProfilesDirectory)
        // P14.1 — durable task kernel stores (R-B-01 wiring). Constructed from
        // the persistent `paths.applicationSupportRoot` so they survive launch.
        let durableTaskStore = DurableTaskStore(baseDirectory: paths.durableTasksDirectory)
        let goalStore = GoalStore(baseDirectory: paths.durableGoalsDirectory)
        let durableInboxStore = DurableInboxStore(baseDirectory: paths.durableInboxURL)
        let durableAuditLogStore = DurableAuditLogStore(url: paths.durableAuditLogURL)
        let durableSchedulerSnapshotStore = DurableSchedulerSnapshotStore(
            url: paths.durableSchedulerSnapshotsDirectory.appendingPathComponent("scheduler.json"))
        providers = ProviderStore(fileURL: paths.providersURL,
                                  secretStore: appEnvironment.secretStore,
                                  conformanceProfileStore: conformanceProfileStore)
        #if DEBUG
        if appEnvironment.automationProfileID != nil,
           let modelID = ProcessInfo.processInfo.environment["DESKPET_AUTOMATION_OLLAMA_MODEL"] {
            providers.configureAutomationOllama(modelID: modelID)
        }
        #endif
        backup = BackupService(directory: paths.applicationSupportRoot)
        agentLedger = JSONAgentTaskLedgerStore(fileURL: paths.agentTaskLedgerURL)
        security = SecurityKernel(tier: .current,
                                  runner: ToolRunnerService(workspaceRoot: paths.workspaceRoot))

        NSApp.setActivationPolicy(.accessory)   // menu-bar only, no Dock icon (LSUIElement)
        installMainMenuCommands()

        let screens = ScreenManager()
        overlay = OverlayWindowController(state: state, screens: screens, modelRoot: paths.applicationSupportRoot.appendingPathComponent("Characters/Live2D"))
        overlay.voice = voice
        prefs.onPreviewCompanionBubble = { [weak self] in self?.overlay.previewBubble() }
        prefs.onPreviewCompanionExpression = { [weak self] name in self?.overlay.previewExpression(name) }
        prefs.onPreviewCompanionEmotion = { [weak self] emotion in self?.overlay.previewEmotion(emotion) }
        overlay.surface.onExpressionsChanged = { [weak self] expressions in
            guard let self, self.prefs.companionExpressions != expressions else { return }
            self.prefs.companionExpressions = expressions
        }
        overlay.setCharacterHeight(prefs.appearance.resolvedCharacterHeight)
        prefs.$prefs.map { $0.appearance.resolvedCharacterHeight }.removeDuplicates()
            .sink { [weak self] height in self?.overlay.setCharacterHeight(height) }
            .store(in: &presenceStoreCancellables)
        overlay.start()
        #if DEBUG
        if let output = ProcessInfo.processInfo.arguments.value(after: "--canonical-surface-evidence") {
            canonicalAcceptanceTask = Task { [weak self] in
                let seconds = Double(ProcessInfo.processInfo.arguments.value(after: "--canonical-soak-seconds") ?? "1800") ?? 1800
                await self?.overlay.surface.runAcceptance(at: URL(fileURLWithPath: output), soakSeconds: seconds)
            }
        }
        #endif

        // Relationship (doc §10) — no-penalty growth from positive interactions.
        overlay.onPetTouched = { [weak self] in self?.relationship.record(.pet) }
        relationship.onStageUp = { [weak self] stage in self?.overlay.celebrateStageUp(stage) }
        relationship.onEquipChange = { [weak self] items in self?.overlay.setAccessories(items) }
        overlay.setAccessories(relationship.equipped)

        // AI stack via PetBrain (P1). Local model still runs in the isolated helper process `llm`;
        // generation/routing/emotion are now behind PetBrainCore seams.
        let repository = JSONMemoryRepository(memory)
        let services = AIServices(llm: llm,
                                  repository: repository,
                                  providers: providers,
                                  conformanceProfileStore: conformanceProfileStore)
        self.aiServices = services
        let perceptionPolicy = { @MainActor [weak self] in self?.chat?.perception ?? PerceptionPolicy() }
        // P18 — the screen-reader's policy closure now delegates through
        // `awarenessService.perception` (wired below). The closure here captures
        // `awarenessService` weakly to avoid the usual retain cycle. Defaulting to
        // `chat?.perception` first lets the chat composer change the policy through
        // its `pushPerceptionToService()` seam at the moment `useScreen` flips.
        screenReader = ScreenReader(policy: { perceptionPolicy() })
        // R1-1 (P0) — Re-route the production chat path through the authoritative
        // `DesktopAwarenessService.readScreen(consent:)` so the capture publishes
        // to `awarenessService.snapshot.screenText` (and the indicator chip
        // displays "屏幕已读取 Ns 前" for the actual user-facing flow). The
        // closure captures `self` weakly; `awarenessService` is wired later in
        // `applicationDidFinishLaunching` but is present by the time any user-
        // initiated `services.screenReader()` call happens.
        services.screenReader = { [weak self] in
            guard let svc = self?.awarenessService else { return nil }
            return await svc.readScreen(consent: true)?.text
        }

        // Native agent runtime (replaces the OpenClaw-adapter direction). All side effects route
        // through the Broker-backed gate → isolated ToolRunner; the model only proposes decisions.
        // P5.0: a single DI container owns the one coordinator and the runtime contracts; the
        // presentation driver bridges to the existing renderer (Runtime → Driver → PetRenderer).
        let presentationDriver = StaticSpritePresentationDriver(overlay: overlay)
        // P5: scheduled-task subsystem. Created before the executor so the schedule.create tool can
        // register tasks; its `runner` is wired after the container exists.
        let scheduler = TaskScheduler(store: ScheduledTaskStore(fileURL: paths.scheduledTasksURL))
        self.scheduler = scheduler
        // P2: real tools. OS-bound capabilities (timer/reminders/calendar/schedule) run in-process;
        // workspace filesystem tools run in the isolated runner. Legacy generic networking remains
        // unavailable until it has an address-pinned transport. The composite routes by capability.
        let toolExecutor = CompositeToolExecutor(
            inProcess: InProcessToolExecutor(
                eventKit: LiveEventKitAccess(),
                scheduleTimer: { [weak self] seconds, title in
                    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
                        self?.overlay.sayBubble(title, emotion: .neutral)
                    }
                },
                scheduleCreate: { [weak scheduler] task in
                    await MainActor.run { scheduler?.add(task); return scheduler != nil }
                }),
            isolated: IsolatedToolExecutor(ToolRunnerService(workspaceRoot: paths.workspaceRoot)))
        let structuredDecisionProvider: any StructuredDecisionProviding
        let conversationProvider: any ConversationGenerating
        let loopDecisionProviderFactory: @Sendable () async -> any AgentLoopDecisionProviding
        let additionalAgentTools: [AnyAgentTool]
        #if DEBUG
        let automationScript = AutomationAgentScript()
        var debugAdditionalAgentTools: [AnyAgentTool] = []
        if appEnvironment.automationProfileID != nil, automationScript != .unknown {
            structuredDecisionProvider = AutomationStructuredDecisionProvider(script: automationScript)
            conversationProvider = AutomationConversationProvider(script: automationScript)
            loopDecisionProviderFactory = {
                AutomationAgentLoopDecisionProvider(script: automationScript)
            }
            debugAdditionalAgentTools.append(AnyAgentTool(AutomationP8ReversibleAgentTool()))
        } else {
            structuredDecisionProvider = ReasoningModelAdapter()
            conversationProvider = LegacyConversationProvider(services)
            loopDecisionProviderFactory = { [weak services] in
                if let provider = await services?.makeAgentLoopDecisionProviderSnapshot() {
                    return provider
                }
                return StructuredAgentLoopDecisionAdapter(provider: ReasoningModelAdapter())
            }
        }
        if P7AppRecoveryHarness.requestedPhase != nil {
            debugAdditionalAgentTools.append(P7AppRecoveryHarness.additionalTool)
        }
        additionalAgentTools = debugAdditionalAgentTools
        #else
        structuredDecisionProvider = ReasoningModelAdapter()
        conversationProvider = LegacyConversationProvider(services)
        loopDecisionProviderFactory = { [weak services] in
            if let provider = await services?.makeAgentLoopDecisionProviderSnapshot() {
                return provider
            }
            return StructuredAgentLoopDecisionAdapter(provider: ReasoningModelAdapter())
        }
        additionalAgentTools = []
        #endif
        #if DEBUG
        let p9cSmokeHarnessRequested = P9CLocalDiscoveryAppSmokeHarness.requestedFlow != nil
        let p9dSmokeHarnessRequested = P9DLocalDiscoveryPresentationAppSmokeHarness.requestedScenario != nil
        #else
        let p9cSmokeHarnessRequested = false
        let p9dSmokeHarnessRequested = false
        #endif
        let runtimeApprover: CapabilityApprover = { capabilityID, reason, risk in
            if p9cSmokeHarnessRequested || p9dSmokeHarnessRequested { return .allowSession }
            return await ApprovalPrompt.ask(capabilityID: capabilityID, reason: reason, risk: risk)
        }
        let container = await AgentRuntimeContainer(
	            tier: .current,
	            context: AppAgentContextBuilder(repository: repository),
	            model: structuredDecisionProvider,
	            conversation: conversationProvider,
            executor: toolExecutor,
            ledger: agentLedger,
            presentationDriver: presentationDriver,
            approver: runtimeApprover,
	            reflection: MemoryReflectionSink(memory),
	            loopDecisionProviderFactory: loopDecisionProviderFactory,
	            localDiscoveryStructuredPlannerFactory: { [weak services] in
	                await services?.makeLocalDiscoveryStructuredPlannerSnapshot()
	            },
		            systemAuthorization: LiveSystemAuthorizationPolicy(),
		            toolPolicyStore: prefs,
		            sideEffectLedgerStore: sideEffectLedgerStore,
		            checkpointStore: checkpointStore,
		            additionalAgentTools: additionalAgentTools,
		            // P14.1 — durable kernel injection (R-B-01). Container owns
		            // these and threads them into the single coordinator.
		            durableTaskStore: durableTaskStore,
		            goalStore: goalStore,
		            durableInboxStore: durableInboxStore,
		            durableAuditLogStore: durableAuditLogStore,
		            durableSchedulerSnapshotStore: durableSchedulerSnapshotStore)
        self.runtimeContainer = container
        // P3: a session "trust reversible operations" toggle drives the gate without a per-action prompt.
        prefs.onTrustReversibleChange = { [weak container] on in
            Task { await container?.appGate.setTrustReversible(on) }
        }
        let runEventStore = AgentRunEventStore(baseDirectory: paths.agentRunEventsDirectory)
        let activityPersistence = JSONLAgentTaskActivityEventStore(fileURL: paths.agentTaskActivityURL)
        let activityStore = AgentTaskActivityStore(persistence: activityPersistence,
                                                   runEventStore: runEventStore,
                                                   checkpointStore: checkpointStore)
        let agentScheduler = AgentTaskScheduler(eventHub: activityStore.eventHub)
        let localDiscoveryPresentationStore = LocalDiscoveryPresentationStore(checkpointStore: checkpointStore)
        let placeHandoffRecordStore = PlaceHandoffJSONRecordStore(
            fileURL: paths.applicationSupportRoot.appendingPathComponent("place_handoff_records.json"))
        let placeHandoffViewModel = PlaceHandoffViewModel(
            authorizer: DefaultPlaceHandoffAuthorizer(systemAuthorization: LiveSystemAuthorizationPolicy(),
                                                      audit: container.auditSink),
            dispatcher: SystemPlaceHandoffDispatcher(),
            recordStore: placeHandoffRecordStore,
            handlerResolver: NSWorkspaceExternalURLHandlerResolver())
        self.agentActivityStore = activityStore
        self.agentScheduler = agentScheduler
        self.companionRuntime = CompanionAgentRuntimeModel(providers: providers,
	                                                           runtimeContainer: container,
	                                                           preferences: prefs,
	                                                           activityStore: activityStore,
	                                                           scheduler: agentScheduler,
	                                                           conformanceProfileStore: conformanceProfileStore)
        petAgent = container.coordinator
        runtimeBootstrapTask = Task { await container.bootstrap() }   // start() reconciles the ledger after restart

        #if DEBUG
        if P7AppRecoveryHarness.requestedPhase != nil {
            Task {
                await self.runtimeBootstrapTask?.value
                await P7AppRecoveryHarness.runIfRequested(paths: paths,
                                                          activityStore: activityStore,
                                                          providers: providers,
                                                          toolRegistry: container.toolRegistry,
                                                          appGate: container.appGate,
                                                          checkpointStore: checkpointStore,
                                                          sideEffectLedgerStore: sideEffectLedgerStore,
                                                          conformanceProfileStore: conformanceProfileStore)
            }
            return
        }
        #endif

        // P5: scheduled tasks fire through the one coordinator. Autonomy is enforced on the gate for
        // the duration of the run (notifyOnly defers P1+; preauthorized caps run unattended).
        scheduler.runner = { [weak self] task in
            guard let self else { return "" }
            await container.appGate.setAutonomousRun(task.autonomy)
            var reply = ""
            let conversationID = UUID()
            let userMessageID = UUID()
            let submitted = await agentScheduler.submit(AgentTaskSubmission(
                taskID: UUID(),
                title: task.title,
                priority: .normal,
                createdAt: Date(),
                scheduleID: task.id,
                origin: .scheduled,
                conversationID: conversationID,
                userMessageID: userMessageID))
            _ = await agentScheduler.startAvailable()
            let record = await agentScheduler.record(taskID: submitted.taskID) ?? submitted
            let event = PetAgentEvent.userMessage(UserMessageEvent(
                conversationID: conversationID,
                messageID: userMessageID,
                text: task.prompt,
                taskIDOverride: record.taskID,
                runIDOverride: record.runID,
                metadata: UserMessageMetadata(source: "scheduled")))
            for await output in container.coordinator.handle(event) {
                switch output {
                case .taskActivity(let event):
                    await activityStore.eventHub.publish(AgentEventEnvelope(activityEvent: event))
                case .responseDelta(_, _, let text): reply += text
                case .presentation(let p): reply = p.bubbles.joined()
                case .waitingForApproval(let capabilityID):
                    await agentScheduler.waitForPermission(taskID: record.taskID, permissions: [capabilityID])
                    reply += reply.isEmpty ? "有操作需要你确认" : "（有操作需要你确认）"
                case .responseCompleted:
                    await agentScheduler.finishFromRuntime(taskID: record.taskID, status: .succeeded)
                case .failed(_, let reason):
                    await agentScheduler.finishFromRuntime(taskID: record.taskID,
                                                           status: .failed,
                                                           failureCategory: "runtimeFailed",
                                                           safeSummary: reason)
                case .cancelled:
                    await agentScheduler.finishFromRuntime(taskID: record.taskID, status: .cancelled)
                default: break
                }
            }
            await container.appGate.setAutonomousRun(nil)
            // P17 / CR-01 (R1-02) — defense-in-depth truncation guard at the call site.
            // `SpeechBubbleLayout` wraps/truncates on the renderer side, but a clamp at the
            // call site protects against legacy replays and any future code path that
            // bypasses the bubble renderer. The 240-char threshold matches the bubble's
            // 4 lines × ~60 chars visible budget; full text still flows through
            // `ChatExpandedView` (which has its own ScrollView).
            if !reply.isEmpty {
                let truncated = Self.truncateForSayBubble(reply)
                self.overlay.sayBubble(truncated, emotion: .neutral)
            }
            return reply
        }
        scheduler.start()
        chat = ChatModel(runtime: petAgent,
                         services: services,
                         store: ChatStore(fileURL: paths.conversationsURL),
                         activityStore: activityStore,
                         scheduler: agentScheduler,
                         localDiscoveryPresentationStore: localDiscoveryPresentationStore,
                         placeHandoffViewModel: placeHandoffViewModel)

        // P18 — Wire the authoritative `DesktopAwarenessService` here so it shares
        // the `WindowTracker` (already owned by the overlay), the new
        // `ScreenReader(policy:)` closure above, and the user's persisted awareness
        // preferences. Falls back gracefully when production wiring is not available
        // (unit tests / harness runs with no NSWorkspace observation).
        if let overlayWindowTracker = overlay.windowTrackerProbe() {
            let observer = AwarenessPermissionObserver()
            self.awarenessPermissionObserver = observer
            let ownBundle = Bundle.main.bundleIdentifier
            let service = DesktopAwarenessService(windowTracker: overlayWindowTracker,
                                                  screenReader: screenReader,
                                                  permissionObserver: observer,
                                                  sensitivePolicy: SensitiveAppPolicy(),
                                                  ownBundleIdentifier: ownBundle)
            // Seed the service's perception from the user's preference (L1 default).
            service.updatePerceptionPolicy(prefs.perceptionPolicy)
            // On settings change, mirror the new level back into the service.
            prefs.$prefs
                .map { $0.awareness }
                .removeDuplicates()
                .sink { awareness in
                    let policy = awareness.toPerceptionPolicy()
                    service.updatePerceptionPolicy(policy)
                }
                .store(in: &awarenessCancellables)
            // Apply the chip ↔ chat seam.
            chat.awarenessService = service
            chat.pullPerceptionFromService()
            // Re-route the screen reader's policy through the service so its gate
            // matches what the chat composer sees (instead of `chat.perception`).
            screenReader.replacePolicy { @MainActor in service.perception }
            self.awarenessService = service
            service.startObservingWorkspace()
            // Tag the overlay so its `perceivedContext` reads through the service
            // (no parallel NSWorkspace path).
            overlay.attachAwarenessService(service)
        }
        chat.onAnimationEvent = { [weak self] event in
            guard let self else { return }
            // R2-6: optional-chain so the absence of `presenceCoordinator` (under the
            // presence-visual-smoke env var) does not crash. The chat event is
            // simply swallowed in that case — the smoke has its own coordinator
            // funnel that drives the scene independently.
            Task { await self.presenceCoordinator?.ingestChatAnimationEvent(event) }
        }
        chat.onReply = { [weak self] presentation, isQuick in
            guard let self else { return }
            let action = Self.action(for: presentation.animationIntent)
            self.overlay.reactPet(emotion: presentation.emotion, action: action)
            if isQuick {
                self.overlay.sayBubble(presentation.bubbles.joined(separator: " "), emotion: presentation.emotion)
            }
            self.relationship.record(.chat)
        }

        mainWindow = MainWindowController(model: model, chat: chat, memory: memory, relationship: relationship,
                                          prefs: prefs, providers: providers,
                                          runtime: companionRuntime, scheduler: scheduler, backup: backup,
                                          uiState: uiState,
                                          automationIndicatorInfo: appEnvironment.automationIndicatorInfo,
                                          diagnosticsURL: paths.diagnosticsURL)
        // P22 — feed the main window back to the overlay so `setFocusActive`
        // can derive the focus spot relative to the user's actual screen.
        overlay.mainWindowRef = mainWindow
        // P17-A — onboarding coordinator. Suppressed for automation profiles so
        // the test harness does not have to drive onboarding interactively.
        if appEnvironment.mode == .normal {
            let onboardingPersistence = OnboardingPersistence(applicationSupportRoot: paths.applicationSupportRoot)
            onboardingCoordinator = OnboardingCoordinator(
                persistence: onboardingPersistence,
                providers: providers,
                preferences: prefs,
                paths: paths,
                permissionObserver: awarenessPermissionObserver)
            // P17 / R2-08 — thread the LIVE global-hotkey registration status into
            // onboarding so the ready step shows "已启用 / 未注册" instead of the static
            // fallback. Read lazily (closure) because `hotKeys.install()` runs later in
            // this same launch, before the user can reach the ready step.
            onboardingCoordinator.hotkeyStatusProvider = { [weak self] in
                self?.hotKeys.floatingChatGlobalHotKeyResult
            }
            onboardingCoordinator.attach(mainWindow: mainWindow)
            if onboardingCoordinator.shouldPresentOnLaunch() {
                onboardingCoordinator.presentIfNeeded(reason: .firstLaunch)
            }
            NotificationCenter.default.addObserver(
                forName: .deskpetReplayOnboardingRequested,
                object: nil,
                queue: .main) { [weak onboardingCoordinator] _ in
                    MainActor.assumeIsolated {
                        _ = onboardingCoordinator?.replay()
                    }
                }
        }
        // P5.1: route typed UI intents to the existing animation FSM (throttled), via the presence
        // coordinator funnel (P16 — ensures every writer is mediated by one coordinator).
        let router = PetUIIntentRouter(sink: { [weak self] event in
            guard let self else { return }
            // R2-6: optional-chain for the same reason as the chat sink above.
            Task { await self.presenceCoordinator?.ingestChatAnimationEvent(event) }
        })
        petIntentRouter = router
        mainWindow.setPetIntentHandler { [weak router] intent in router?.send(intent) }
        quickTask = QuickTaskPanel(model: model)
        quickChat = QuickChatPanel(chat: chat)
        let floatingChatStore = FloatingChatStateStore()
        // P17 / R2-03 + R3-02 — wire the floating chat's failure-recovery CTA to the
        // production main-window route. The previous R2-03 disposition asserted this
        // wiring existed; the reviewer's `grep` confirmed it did not (R3-02 — fabricated
        // implementation claim). The actual production wiring is now here: when the
        // floating chat's failed-message CTA is tapped we open the main window and switch
        // to the `.providers` section so the user lands directly on AI settings.
        // Without this closure the CTA stayed hidden (the optional was nil-passed through),
        // which is acceptable but loses the EX-04 "every failure has a next step" affordance
        // for users who hit the failure from the floating panel.
        floatingChat = FloatingChatPanelController(store: floatingChatStore,
                                                   chat: chat,
                                                   providers: providers,
                                                   uiState: uiState,
                                                   onOpenAISettings: { [weak self] in
                                                       self?.mainWindow?.show()
                                                       self?.mainWindow?.setSection(.providers)
                                                   })
        floatingChat.showCapsule()
        overlay.onPetClickedForChat = { [weak self] in self?.floatingChat.expand() }

        // P16 — Character presence coordinator. Funnels chat events + UI intents through one writer
        // so the character animation FSM has a single source of truth for semantic state. Boots
        // after the overlay exists (needed for `applyPresenceIntent`) and after the chat store
        // exists (the coordinator subscribes to it).
        // R2-6: gate the production coordinator construction+start behind the absence of
        // `DESKPET_PRESENCE_VISUAL_SMOKE`. The smoke harness constructs its own
        // coordinator against the shared overlay scene; running both concurrently made
        // the smoke nondeterministic at steps 00/01 (production persistence-hydration
        // terminal reactions firing into the scene mid-step). The three IUO call sites
        // below (`?.` rather than `!`) are safe whether the coordinator is built or not.
        let presenceSmokeRequested = ProcessInfo.processInfo.environment["DESKPET_PRESENCE_VISUAL_SMOKE"] != nil
        if !presenceSmokeRequested {
            let presenceAdvancer = ContainerBehaviorAdvancer(container: container)
            var presenceConfig = CharacterPresenceCoordinator.Configuration()
            presenceConfig.currentRendererIntent = { [weak overlay] in overlay?.surface.currentIntent }
            let presenceCoordinator = CharacterPresenceCoordinator(
                activityStore: activityStore,
                chatStore: floatingChatStore,
                advancer: presenceAdvancer,
                configuration: presenceConfig,
                applyIntent: { [weak overlay] intent in overlay?.applyPresenceIntent(intent) },
                onPresenceEngage: { [weak overlay] engaged in
                    overlay?.setPresenceEngaged?(engaged)
                })
            self.presenceCoordinator = presenceCoordinator
        } else {
            self.presenceCoordinator = nil
        }
        overlay.applyPresenceIntent = { [weak overlay] intent in overlay?.surface.apply(intent: intent) }
        overlay.presenceCoordinatorState = { [weak self] in self?.presenceCoordinator?.state }
        // R1-2: pass the renderer's current intent to the coordinator so reconcile() can
        // self-heal against any writer (driver path, UI router path).
        // R2-13: the prior `overlay.currentRendererIntentProvider = { ... }`
        // writer was dead — the seam was declared but never read; the
        // `presenceConfig.currentRendererIntent` wired above is the actual reader.
        overlay.onSecondTick = { [weak self] in
            guard let self else { return }
            Task { await self.presenceCoordinator?.tickOneSecond() }
        }
        // R1-3: wire overlay mouse-down + registerUserResponse to the coordinator's
        // noteUserInteraction seam so a sleeping pet wakes on click (and the inactivity
        // accounting observes real user input).
        overlay.onUserInteractionNote = { [weak self] in
            self?.presenceCoordinator?.noteUserInteraction()
        }
        overlay.setPresenceEngaged = { [weak self] engaged in
            guard let self else { return }
            // Rising/falling edge of the engaged semantic state: hold the pet still (block wander)
            // and unhold when disengaging. Recall/drag remain unaffected (they bypass this gate
            // by transitioning the activity directly).
            if engaged {
                self.overlay?.machine.holdStill()
                self.overlay?.machine.suppressWander = true
            } else {
                self.overlay?.machine.suppressWander = false
            }
        }
        // Attentive gaze — point the character at the chat panel whenever it's expanded/taskHUD.
        overlay.setChatLookTarget = { [weak self] target in
            guard let self, let overlay = self.overlay else { return }
            // A nil target releases chat attention so the real pointer owns gaze again.
            if let global = target {
                overlay.surface.setLookTarget(overlay.toLocalPublic(global))
            } else {
                overlay.surface.setLookTarget(nil)
            }
        }
        floatingChatStore.$visibilityState
            .removeDuplicates()
            .sink { [weak self] state in
                guard let self else { return }
                if state == .expanded || state == .taskHUD {
                    self.overlay?.setChatLookTarget(self.floatingChat?.panelAnchorGlobal)
                } else {
                    self.overlay?.setChatLookTarget(nil)
                }
            }
            .store(in: &presenceStoreCancellables)
        // R2-6: only start when the coordinator was actually constructed (i.e. the
        // smoke env var was NOT set).
        if presenceCoordinator != nil {
            Task { await self.presenceCoordinator?.start() }
        }

        // Focus session ↔ pet light-companion mode (doc §9.5).
        model.focus.onActiveChange = { [weak self] active in
            self?.overlay.setFocusActive(active)
            if active { self?.companionRuntime.startFocusSession() }
            else { self?.companionRuntime.endFocusSession() }
        }
        // Repeated focus length → suggest remembering it (doc §12.1 建议式记忆).
        model.focus.onFinished = { [weak self] minutes in
            guard let self else { return }
            let n = self.model.recordFocusCompletion(minutes: minutes)
            self.memory.suggest(MemorySuggester.focusHabit(minutes: minutes, occurrences: n))
            self.relationship.record(.focusComplete)
        }
        model.onTaskCompleted = { [weak self] in self?.relationship.record(.taskComplete) }

        statusItem = StatusItemController(overlay: overlay, state: state, model: model,
                                          mainWindow: mainWindow, quickTask: quickTask, quickChat: quickChat,
                                          voice: voice)
        statusItem.onOpenAppearance = { [weak self] in
            self?.uiState.setSection(.appearance)
            self?.mainWindow.show()
        }

        hotKeys.onToggleHide = { [weak self] in self?.overlay.toggleHidden(); self?.statusItem.rebuildMenu() }
        hotKeys.onRecall = { [weak self] in self?.overlay.recall() }
        hotKeys.onQuickTask = { [weak self] in self?.quickTask.toggle() }
        hotKeys.onQuickChat = { [weak self] in self?.quickChat.toggle() }
        hotKeys.onFloatingChat = { [weak self] in self?.floatingChat.toggle() }
        hotKeys.install()

        #if DEBUG
        if let modelRoot = ProcessInfo.processInfo.arguments.value(after: "--live2d-model-root") {
            let source = ProcessInfo.processInfo.arguments.value(after: "--live2d-source") ?? "Haru/Haru.model3.json"
            let evidence = ProcessInfo.processInfo.arguments.value(after: "--live2d-evidence").map { URL(fileURLWithPath: $0) }
            live2dDevelopmentWindow = Live2DDevelopmentWindow(modelDirectory: URL(fileURLWithPath: modelRoot),
                source: "deskpet://models/" + source, evidence: evidence)
            live2dDevelopmentWindow?.show()
        }
        // Headless verification hook: open the main window on launch when requested.
        if ProcessInfo.processInfo.environment["DESKPET_AUTO_OPEN"] != nil {
            mainWindow.show()
        }
        // Headless verification hook: exercise the isolated-LLM round trip end to end.
        if ProcessInfo.processInfo.environment["DESKPET_AI_SELFTEST"] != nil {
            Task {
                let resp = await llm.send(AIRequest(kind: .chat, prompt: "你好"))
                FileHandle.standardError.write("SELFTEST reply=\(resp.reply) emotion=\(resp.emotion) ok=\(resp.ok)\n".data(using: .utf8)!)
            }
        }
        // Headless verification hook: exercise the full PetBrain path (planner → model → renderer).
        if ProcessInfo.processInfo.environment["DESKPET_PETBRAIN_SELFTEST"] != nil {
            Task {
                await self.runtimeBootstrapTask?.value
                let event = PetAgentEvent.userMessage(UserMessageEvent(conversationID: UUID(), text: "你好呀"))
                var bubbles: [String] = []
                for await output in petAgent.handle(event) {
                    if case .presentation(let pres) = output { bubbles = pres.bubbles }
                }
                FileHandle.standardError.write("PETBRAIN_VIA_AGENT bubbles=\(bubbles)\n".data(using: .utf8)!)
            }
        }
        // Headless verification hook: app → Broker → token → isolated ToolRunner → result.
        if ProcessInfo.processInfo.environment["DESKPET_SECURITY_SELFTEST"] != nil {
            Task {
                let ok = await security.run(capabilityID: "state.read", reason: "self-test")
                let denied = await security.run(capabilityID: "shell.arbitrary", reason: "self-test")
                FileHandle.standardError.write("SECURITY p0=\(ok.ok)/\(ok.output) p4=\(denied.ok)/\(denied.error ?? "")\n".data(using: .utf8)!)
            }
        }
        // Headless verification hook: native runtime — a capability task routed through the Broker.
        if ProcessInfo.processInfo.environment["DESKPET_AGENT_SELFTEST"] != nil {
            Task {
                await self.runtimeBootstrapTask?.value
                let r = await petAgent.run(.userMessage(text: "计时 25 分钟", conversationClass: .normal))
                FileHandle.standardError.write("PETAGENT executed=\(r.executedSteps) denied=\(r.deniedSteps) state=\(String(describing: r.taskState))\n".data(using: .utf8)!)
            }
        }
        // Headless verification hook: P5.0 runtime container bootstrap → diagnostics → shutdown.
        if ProcessInfo.processInfo.environment["DESKPET_RUNTIME_SELFTEST"] != nil {
            Task {
                await self.runtimeBootstrapTask?.value
                let snapshot = await container.diagnosticsSnapshot()
                let active = await container.lifecycle.activeRequestCount()
                FileHandle.standardError.write("RUNTIME \(snapshot.compactSummary) bootstrapped=\(container.isBootstrapped)\n".data(using: .utf8)!)
                await container.shutdown()
                let afterState = await container.lifecycle.currentState().label
                FileHandle.standardError.write("RUNTIME afterShutdown state=\(afterState) activeBefore=\(active)\n".data(using: .utf8)!)
            }
        }
        if Self.selftestRequested(environmentKey: "DESKPET_MAIN_CHAT_SELFTEST",
                                  argumentFlag: "--deskpet-main-chat-selftest") {
            Task {
                await self.runtimeBootstrapTask?.value
                var sawDelta = false
                var terminal = "none"
                var provider = "unknown"
                let text = ProcessInfo.processInfo.environment["DESKPET_MAIN_CHAT_SELFTEST_TEXT"]
                    ?? "你好，今天陪我聊一会儿。"
                let event = PetAgentEvent.userMessage(UserMessageEvent(conversationID: UUID(),
                                                                       text: text,
                                                                       conversationClass: .normal))
                for await output in petAgent.handle(event) {
                    switch output {
                    case .providerMetadata(let capability): provider = capability.rawValue
                    case .responseDelta: sawDelta = true
                    case .responseCompleted: terminal = "completed"
                    case .cancelled: terminal = "cancelled"
                    case .failed: terminal = "failed"
                    default: break
                    }
                }
                let line = "MAINCHAT coordinator=true provider=\(provider) delta=\(sawDelta) terminal=\(terminal)\n"
                Self.writeSelftestLine(line,
                                       environmentKey: "DESKPET_MAIN_CHAT_SELFTEST_OUT",
                                       argumentFlag: "--deskpet-selftest-output")
                if Self.selftestRequested(environmentKey: "DESKPET_SELFTEST_TERMINATE",
                                          argumentFlag: "--deskpet-selftest-terminate") {
                    NSApp.terminate(nil)
                }
            }
        }
        #endif
        #if DEBUG
        if P9CLocalDiscoveryAppSmokeHarness.requestedFlow != nil {
            FileHandle.standardError.write("P9C_APP_SMOKE trigger=scheduled\n".data(using: .utf8)!)
            Task {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await P9CLocalDiscoveryAppSmokeHarness.runIfRequested(paths: paths,
                                                                      chat: chat,
                                                                      activityStore: activityStore)
            }
        }
        if P9DLocalDiscoveryPresentationAppSmokeHarness.requestedScenario != nil {
            FileHandle.standardError.write("P9D_APP_SMOKE trigger=scheduled\n".data(using: .utf8)!)
            Task {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await P9DLocalDiscoveryPresentationAppSmokeHarness.runIfRequested(paths: paths,
                                                                                  chat: chat,
                                                                                  activityStore: activityStore,
                                                                                  checkpointStore: checkpointStore)
            }
        }
        if P9EPlaceHandoffAppSmokeHarness.requestedScenario != nil {
            FileHandle.standardError.write("P9E_APP_SMOKE trigger=scheduled\n".data(using: .utf8)!)
            Task {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await P9EPlaceHandoffAppSmokeHarness.runIfRequested(paths: paths,
                                                                    chat: chat,
                                                                    activityStore: activityStore,
                                                                    checkpointStore: checkpointStore)
            }
        }
        if P9FRealSystemHandoffAcceptanceHarness.requestedScenario != nil {
            FileHandle.standardError.write("P9F_REAL_HANDOFF_ACCEPTANCE trigger=scheduled\n".data(using: .utf8)!)
            Task {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await P9FRealSystemHandoffAcceptanceHarness.runIfRequested(paths: paths,
                                                                           chat: chat,
                                                                           activityStore: activityStore,
                                                                           checkpointStore: checkpointStore)
            }
        }
        if P15_1GUIAcceptanceHarness.requestedScenario != nil {
            FileHandle.standardError.write("P15_1_GUI_ACCEPTANCE trigger=scheduled\n".data(using: .utf8)!)
            Task {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await P15_1GUIAcceptanceHarness.runIfRequested(paths: paths,
                                                                chat: chat,
                                                                activityStore: activityStore)
            }
        }
        if P16ProductSurfaceHarness.requestedCapture != nil || P16ProductSurfaceHarness.requestedAll {
            FileHandle.standardError.write("P16_PRODUCT_SURFACES trigger=scheduled\n".data(using: .utf8)!)
            Task {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                await P16ProductSurfaceHarness.runIfRequested(chat: chat,
                                                              activityStore: activityStore,
                                                              paths: paths)
            }
        }
        if P17ProductSurfaceHarness.requestedCapture != nil || P17ProductSurfaceHarness.requestedAll || P17ProductSurfaceHarness.requestedChatStates {
            FileHandle.standardError.write("P17_PRODUCT_SURFACES trigger=scheduled\n".data(using: .utf8)!)
            Task {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                await P17ProductSurfaceHarness.runIfRequested(chat: chat,
                                                              activityStore: activityStore,
                                                              paths: paths)
            }
        }
        if P17OnboardingScreenshotHarness.requestedCapture != nil {
            FileHandle.standardError.write("P17_ONBOARDING_SCREENSHOTS trigger=scheduled\n".data(using: .utf8)!)
            let onboardingPersistence = OnboardingPersistence(
                applicationSupportRoot: paths.applicationSupportRoot)
            Task {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                await P17OnboardingScreenshotHarness.runIfRequested(
                    persistence: onboardingPersistence,
                    providers: providers,
                    preferences: prefs)
            }
        }
        if Self.selftestRequested(environmentKey: "DESKPET_LUMI_VISUAL_SMOKE",
                                  argumentFlag: "--lumi-visual-smoke") {
            let outputPath = ProcessInfo.processInfo.environment["DESKPET_LUMI_VISUAL_OUT"]
                ?? ProcessInfo.processInfo.arguments.value(after: "--lumi-visual-out")
                ?? NSTemporaryDirectory().appending("deskpet-lumi-visual-smoke")
            Task {
                await overlay.runLumiScholarVisualSmoke(outputDirectory: URL(fileURLWithPath: outputPath))
                NSApp.terminate(nil)
            }
        } else if ProcessInfo.processInfo.environment["DESKPET_CHARACTER_WALK_VISUAL_SMOKE"] != nil {
            let outputPath = ProcessInfo.processInfo.environment["DESKPET_CHARACTER_WALK_VISUAL_OUT"]
                ?? NSTemporaryDirectory().appending("deskpet-character-walk-visual-smoke")
            Task {
                await overlay.runCharacterWalkVisualSmoke(outputDirectory: URL(fileURLWithPath: outputPath))
                NSApp.terminate(nil)
            }
        } else if ProcessInfo.processInfo.environment["DESKPET_PRESENCE_VISUAL_SMOKE"] != nil {
            let outputPath = ProcessInfo.processInfo.environment["DESKPET_PRESENCE_VISUAL_OUT"]
                ?? NSTemporaryDirectory().appending("deskpet-presence-visual-smoke")
            FileHandle.standardError.write("PRESENCE_VISUAL_SMOKE trigger=env output=\(outputPath)\n".data(using: .utf8)!)
            Task {
                await overlay.runPresenceVisualSmoke(outputDirectory: URL(fileURLWithPath: outputPath))
                NSApp.terminate(nil)
            }
        } else if ProcessInfo.processInfo.environment["DESKPET_IDLE_PRESENCE_VISUAL_SMOKE"] != nil {
            let outputPath = ProcessInfo.processInfo.environment["DESKPET_IDLE_PRESENCE_VISUAL_OUT"]
                ?? NSTemporaryDirectory().appending("deskpet-idle-presence-visual-smoke")
            FileHandle.standardError.write("IDLE_PRESENCE_SMOKE trigger=env output=\(outputPath)\n".data(using: .utf8)!)
            Task {
                await overlay.runIdlePresenceVisualSmoke(outputDirectory: URL(fileURLWithPath: outputPath))
                NSApp.terminate(nil)
            }
        }
        #endif
    }

    /// Map semantic AnimationIntent → concrete pet action (doc §14.6 — model never names resources).
    private static func action(for intent: AnimationIntent) -> PetAction {
        switch intent {
        case .encourage, .celebrateSoft, .taskSucceeded: return .cheer
        case .explain, .think, .prepareToWork, .working: return .read
        case .listen, .concerned: return .nod
        case .requestPermission: return .point
        case .taskFailed: return .none
        }
    }

    /// P17 / CR-01 (R1-02) — defense-in-depth truncation cap applied to the desktop speech
    /// bubble call site. The bubble's wrap/truncate on the renderer side is the primary
    /// guarantee; this cap is the last line of defense against runaway reply text.
    /// Exposed as an internal static so a unit test can pin the threshold + behavior.
    static let sayBubbleTruncationLimit = 240

    /// P17 / CR-01 (R1-02) — pure clamp used at the call site (and by the regression test).
    /// Returns `reply.prefix(Self.sayBubbleTruncationLimit)` when the input exceeds the
    /// limit; otherwise returns `reply` unchanged. Empty input returns the empty string.
    static func truncateForSayBubble(_ reply: String) -> String {
        guard !reply.isEmpty else { return "" }
        if reply.count > sayBubbleTruncationLimit {
            return String(reply.prefix(sayBubbleTruncationLimit))
        }
        return reply
    }

    private func installMainMenuCommands() {
        let mainMenu = NSMenu(title: "DeskPet")

        // P17 / NM-02 — App menu: About + Settings… ⌘, + Quit. Settings routes to the
        // main window and selects the privacy section so ⌘, opens the user-facing page
        // (it is the conventional shortcut on macOS).
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu(title: "DeskPet")
        let aboutItem = NSMenuItem(title: "关于 DeskPet",
                                    action: nil,
                                    keyEquivalent: "")
        aboutItem.target = self
        aboutItem.action = #selector(showAboutPanel)
        appMenu.addItem(aboutItem)
        appMenu.addItem(.separator())
        let settingsItem = NSMenuItem(title: "设置…",
                                      action: nil,
                                      keyEquivalent: ",")
        settingsItem.target = self
        settingsItem.action = #selector(showSettings)
        appMenu.addItem(settingsItem)
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(title: "退出 DeskPet",
                                   action: #selector(NSApplication.terminate(_:)),
                                   keyEquivalent: "q"))
        appMenuItem.submenu = appMenu

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Cut",
                                    action: #selector(NSText.cut(_:)),
                                    keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy",
                                    action: #selector(NSText.copy(_:)),
                                    keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste",
                                    action: #selector(NSText.paste(_:)),
                                    keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(NSMenuItem(title: "Select All",
                                    action: #selector(NSText.selectAll(_:)),
                                    keyEquivalent: "a"))
        editMenuItem.submenu = editMenu

        // P17 / NM-02 — Window menu routes to the main window and floating chat.
        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "Window")
        let openMain = NSMenuItem(title: "主窗口",
                                  action: nil,
                                  keyEquivalent: "0")
        openMain.target = self
        openMain.action = #selector(openMainWindow)
        windowMenu.addItem(openMain)
        let toggleChat = NSMenuItem(title: "悬浮聊天",
                                    action: nil,
                                    keyEquivalent: "1")
        toggleChat.target = self
        toggleChat.action = #selector(toggleFloatingChat)
        windowMenu.addItem(toggleChat)
        windowMenuItem.submenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func showAboutPanel() {
        // Route to the existing main window; the "关于" row in SettingsView handles
        // the about copy. This avoids spawning a second chrome surface.
        floatingChat?.showCapsule()
        mainWindow?.show()
        mainWindow?.setSection(.advanced)
    }

    @objc private func showSettings() {
        mainWindow?.show()
        mainWindow?.setSection(.privacy)
    }

    @objc private func openMainWindow() {
        mainWindow?.show()
    }

    @objc private func toggleFloatingChat() {
        floatingChat?.toggle()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// P19.1 / P0-A — foreground activation refresh. When the user returns from
    /// System Settings (where they may have toggled Accessibility, Screen Recording,
    /// or Input Monitoring), re-query the live observer so the onboarding + settings
    /// permission pills update without a full app restart.
    ///
    /// We do NOT do anything else on activation — in particular we do not silently
    /// kill/relaunch the app even if a TCC grant would technically require it (P19.1
    /// §3 forbids silent relaunch; in practice the runtime reads TCC lazily so
    /// there is nothing to relaunch).
    func applicationDidBecomeActive(_ notification: Notification) {
        awarenessPermissionObserver?.refresh()
    }

    func applicationWillTerminate(_ notification: Notification) {
        // P18.2 — explicit lifecycle teardown for the UI-side resource owners. Runs
        // before the runtime guard below so timers/monitors/observers are released
        // even if the runtime container never came up (partial-init safe). Both calls
        // are idempotent.
        overlay?.stopLifecycleResources()
        overlay?.surface.shutdown()
        #if DEBUG
        canonicalAcceptanceTask?.cancel()
        #endif
        hotKeys.uninstall()
        // Stop the runtime and cancel its managed tasks (best effort during shutdown).
        guard let container = runtimeContainer else { return }
        presenceStoreCancellables.removeAll()
        awarenessCancellables.removeAll()
        awarenessService?.stopObservingWorkspace()
        if let presenceCoordinator { Task { await presenceCoordinator.stop() } }
        Task { await container.shutdown() }
    }

    #if DEBUG
    private static func selftestRequested(environmentKey: String,
                                          argumentFlag: String,
                                          environment: [String: String] = ProcessInfo.processInfo.environment,
                                          arguments: [String] = ProcessInfo.processInfo.arguments) -> Bool {
        environment[environmentKey] != nil || arguments.contains(argumentFlag)
    }

    private static func writeSelftestLine(_ line: String,
                                          environmentKey: String,
                                          argumentFlag: String,
                                          environment: [String: String] = ProcessInfo.processInfo.environment,
                                          arguments: [String] = ProcessInfo.processInfo.arguments) {
        FileHandle.standardError.write(line.data(using: .utf8)!)
        let outputPath = environment[environmentKey] ?? arguments.value(after: argumentFlag)
        guard let outputPath, !outputPath.isEmpty else { return }
        do {
            let url = URL(fileURLWithPath: outputPath)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try line.data(using: .utf8)?.write(to: url, options: .atomic)
        } catch {
            FileHandle.standardError.write("SELFTEST_OUTPUT_WRITE_FAILED \(error)\n".data(using: .utf8)!)
        }
    }
    #endif
}

#if DEBUG
private extension [String] {
    func value(after flag: String) -> String? {
        guard let index = firstIndex(of: flag) else { return nil }
        let valueIndex = self.index(after: index)
        guard indices.contains(valueIndex) else { return nil }
        return self[valueIndex]
    }
}
#endif

// MARK: - P22 startup-failure alert

extension AppDelegate {
    @MainActor
    fileprivate func presentVaultErrorAlert() {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "DeskPet 安全存储不可用"
        alert.informativeText = """
            DeskPet 无法访问用于保护本地数据的 macOS 钥匙串密钥，因此已停止启动，且不会把数据降级写成明文。

            请解锁登录钥匙串并重新启动 DeskPet。若问题持续存在，请在“钥匙串访问”中检查登录钥匙串状态。
            """
        alert.addButton(withTitle: "退出")
        alert.runModal()
    }

    /// Show a native modal explaining why DeskPet can't start, so the user
    /// is not left guessing. The alert blocks on `runModal` until dismissed.
    @MainActor
    fileprivate func presentEnvironmentErrorAlert(error: Error) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "DeskPet 启动失败"
        let detail = error.localizedDescription.isEmpty
            ? String(describing: error)
            : error.localizedDescription
        alert.informativeText = """
            DeskPet 无法完成启动前的环境配置。

            原因：\(detail)

            应用即将退出。请检查：
            • 磁盘空间与 ~/Library/Application Support 权限
            • macOS 版本（需要 14.0+）
            • 上一次崩溃后残留的锁文件

            详细日志已写入标准错误流；可在 Console.app 搜索 "DESKPET_ENVIRONMENT_ERROR" 查看。
            """
        alert.addButton(withTitle: "退出")
        alert.addButton(withTitle: "打开 Console.app")
        let response = alert.runModal()
        if response == .alertSecondButtonReturn {
            // Open Console.app filtered to the user's own process; this
            // requires Console.app to be installed (always present on macOS).
            if let consoleURL = URL(string: "console-app://") {
                NSWorkspace.shared.open(consoleURL)
            }
        }
    }
}
