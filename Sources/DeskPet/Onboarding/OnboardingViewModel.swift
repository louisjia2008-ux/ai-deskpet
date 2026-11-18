import AppKit
import Combine
import Foundation

// P17-A — onboarding view model.
//
// Owns the step navigation state and provides operations that mutate the persisted
// `OnboardingState`. The view layer binds to `currentStep`, `state`, and a small
// set of imperative callbacks (open editor, open system settings, finish).

@MainActor
final class OnboardingViewModel: ObservableObject {
    @Published private(set) var currentStep: OnboardingStep
    @Published private(set) var state: OnboardingState
    @Published private(set) var reason: OnboardingPresentationReason
    @Published private(set) var providerReadiness: ProviderReadinessSnapshot

    let persistence: OnboardingPersistence
    let providers: ProviderStore
    let preferences: PreferencesModel
    /// P19.1 / P0-A — live permission observer. The accessibility + InputMonitoring
    /// rows are bound to this directly. Per P19.1 §2, PermissionPreferences is NOT
    /// the source of TCC truth — these two capabilities are queried live, not
    /// persisted as a `granted` flag. The observer is optional so the onboarding
    /// window can be presented in environments (tests, headless harnesses) where
    /// no real TCC API is reachable.
    let permissionObserver: AwarenessPermissionObserver?

    private var observer: NSObjectProtocol?
    private var cancellables: Set<AnyCancellable> = []

    init(persistence: OnboardingPersistence,
         providers: ProviderStore,
         preferences: PreferencesModel,
         permissionObserver: AwarenessPermissionObserver? = nil,
         initialState: OnboardingState,
         reason: OnboardingPresentationReason) {
        self.persistence = persistence
        self.providers = providers
        self.preferences = preferences
        self.permissionObserver = permissionObserver
        self.state = initialState
        self.reason = reason
        self.currentStep = OnboardingStep(rawValue: max(0, min(initialState.lastStepIndex, OnboardingStep.allCases.count - 1))) ?? .welcome
        self.providerReadiness = providers.readinessSnapshot()
        providers.objectWillChange
            .sink { [weak self] _ in
                guard let self else { return }
                self.providerReadiness = self.providers.readinessSnapshot()
            }
            .store(in: &cancellables)
        // Forward the observer's `objectWillChange` so the view refreshes when the
        // TCC state flips while the onboarding window is visible (e.g. user
        // toggled permission in System Settings and switched back).
        if let permissionObserver {
            permissionObserver.objectWillChange
                .sink { [weak self] _ in
                    self?.objectWillChange.send()
                }
                .store(in: &cancellables)
        }
    }

    var canGoBack: Bool { currentStep.index > 0 }

    var isLastStep: Bool { currentStep == OnboardingStep.ready }

    var isReplay: Bool { reason == .replay }

    /// Provider center has at least one enabled provider. We treat any
    /// "configured" state as a successful configuration — connection status
    /// is shown separately so the user is not blocked from completing onboarding
    /// just because their local Ollama server is not currently running.
    var hasConfiguredProvider: Bool {
        switch providerReadiness.state {
        case .ready, .noModel, .disconnected, .error:
            return true
        case .noProvider:
            return false
        }
    }

    /// P19.1 / P0-A — live Accessibility state. Comes straight from
    /// `AXIsProcessTrusted()` via the observer; never persisted.
    var accessibilityLiveGranted: Bool {
        permissionObserver?.liveState.accessibilityGranted ?? false
    }

    /// P19.1 / P0-A — live Input Monitoring state. Defaults to `.unknown` so the
    /// UI says "状态未知" rather than claiming TCC truth.
    var inputMonitoringLiveState: AwarenessPermissionObserver.InputMonitoringState {
        permissionObserver?.liveState.inputMonitoring ?? .unknown
    }

    /// P19.1 / P0-A — was the Accessibility explanation shown to the user at
    /// least once in this onboarding session? Workflow state only (not TCC truth).
    var accessibilityExplanationSeen: Bool {
        state.skipReasons["permissions.accessibility.explained"] != nil
    }

    /// P19.1 / P0-A — was the Input Monitoring explanation shown to the user at
    /// least once in this onboarding session?
    var inputMonitoringExplanationSeen: Bool {
        state.skipReasons["permissions.inputMonitoring.explained"] != nil
    }

    /// P19.1 / P0-A — does DeskPet currently need an Accessibility-trusted relaunch?
    /// Carbon `RegisterEventHotKey` works without Accessibility; `AXIsProcessTrusted`
    /// is only consulted by `Awareness` (window title / frontmost app) features.
    /// Concretely: an Accessibility grant only requires a relaunch when the
    /// previous state was "denied" and the process had already started reading
    /// the AX API. We start every process with AX disabled, so the answer is
    /// always NO and the onboarding UI therefore never asks the user to relaunch.
    /// The setter is exposed so future capability work can flip the flag.
    var accessibilityRestartRequired: Bool { false }

    func markAccessibilityExplanationSeen() {
        recordSkip("permissions.accessibility.explained")
    }

    func markInputMonitoringExplanationSeen() {
        recordSkip("permissions.inputMonitoring.explained")
    }

    /// P19.1 / P0-A — explicit user-controlled refresh of the permission observer.
    /// Onboarding view binds this to a "刷新状态" button.
    func refreshPermissions() {
        permissionObserver?.refresh()
    }

    func goBack() {
        guard canGoBack else { return }
        currentStep = OnboardingStep(rawValue: currentStep.index - 1) ?? .welcome
        _ = try? persistence.recordShown(stepIndex: currentStep.index)
    }

    func goNext() {
        guard currentStep.index < OnboardingStep.allCases.count - 1 else { return }
        currentStep = OnboardingStep(rawValue: currentStep.index + 1) ?? .ready
        _ = try? persistence.recordShown(stepIndex: currentStep.index)
    }

    func jump(to step: OnboardingStep) {
        currentStep = step
        _ = try? persistence.recordShown(stepIndex: step.index)
    }

    func recordSkip(_ reason: String) {
        var skipReasons = state.skipReasons
        skipReasons[reason] = Date()
        state.skipReasons = skipReasons
        try? persistence.save(state)
    }

    /// Persist the current step and the in-flight state (used when the window
    /// closes mid-flow).
    func recordShownAndClose() throws {
        state.lastShownAt = Date()
        state.lastStepIndex = currentStep.index
        try persistence.save(state)
    }

    func finish() throws -> OnboardingState {
        let configured = hasConfiguredProvider
        let completed = try persistence.markCompleted(
            providerConfigured: configured,
            lastStepIndex: currentStep.index)
        state = completed
        return completed
    }
}

/// Compact snapshot of provider readiness for the onboarding UI.
struct ProviderReadinessSnapshot: Equatable {
    enum State: Equatable {
        case noProvider
        case disconnected
        case noModel
        case ready
        case error
    }
    var state: State
    var summaryText: String
    var providerName: String?

    static let empty = ProviderReadinessSnapshot(
        state: .noProvider,
        summaryText: "尚未配置 AI 服务",
        providerName: nil)
}

extension ProviderStore {
    func readinessSnapshot() -> ProviderReadinessSnapshot {
        switch readiness() {
        case .ready(let providerName, _):
            return ProviderReadinessSnapshot(state: .ready,
                                             summaryText: "已配置可用 AI（\(providerName)），可以直接开始对话。",
                                             providerName: providerName)
        case .providerConfiguredButDisconnected(let providerName):
            return ProviderReadinessSnapshot(state: .disconnected,
                                             summaryText: "\(providerName) 已配置但当前未连接；可在「AI 设置」中检查。",
                                             providerName: providerName)
        case .providerConnectedNoModel(let providerName):
            return ProviderReadinessSnapshot(state: .noModel,
                                             summaryText: "\(providerName) 已连接，但还没选默认模型。",
                                             providerName: providerName)
        case .noProvider:
            return ProviderReadinessSnapshot(state: .noProvider,
                                             summaryText: "尚未配置 AI 服务。",
                                             providerName: nil)
        case .error(let message):
            return ProviderReadinessSnapshot(state: .error,
                                             summaryText: "AI 配置有问题：\(message)",
                                             providerName: nil)
        }
    }
}
