import AppKit
import SwiftUI

/// Hosts the SwiftUI main window. The app is an accessory (menu-bar) app, but this is a normal
/// titled window the user can summon (doc §13.1). Created lazily; reused across opens.
@MainActor
final class MainWindowController {

    private let model: AppModel
    private let chat: ChatModel
    private let memory: MemoryModel
    private let relationship: RelationshipModel
    private let prefs: PreferencesModel
    private let providers: ProviderStore
    private let runtime: CompanionAgentRuntimeModel
    private let scheduler: TaskScheduler
    private let backup: BackupService
    private let uiState: AppUIStateStore
    private let automationIndicatorInfo: DeskPetAutomationIndicatorInfo?
    private let diagnosticsURL: URL
    private var window: NSWindow?

    /// P22 — read-only bridge for the overlay to derive the focus anchor
    /// from the screen the main window is currently on.
    var windowScreen: NSScreen? { window?.screen }

    /// UI → 桌宠意图出口（由 AppDelegate 注入，连到 overlay 的现有 animation FSM）。
    private var petIntent: @MainActor (PetUIIntent) -> Void = { _ in }

    init(model: AppModel, chat: ChatModel, memory: MemoryModel, relationship: RelationshipModel,
         prefs: PreferencesModel, providers: ProviderStore, runtime: CompanionAgentRuntimeModel,
         scheduler: TaskScheduler, backup: BackupService,
         uiState: AppUIStateStore = AppUIStateStore(),
         automationIndicatorInfo: DeskPetAutomationIndicatorInfo? = nil,
         diagnosticsURL: URL? = nil) {
        self.model = model; self.chat = chat; self.memory = memory; self.relationship = relationship
        self.prefs = prefs; self.providers = providers; self.runtime = runtime
        self.scheduler = scheduler; self.backup = backup
        self.uiState = uiState
        self.automationIndicatorInfo = automationIndicatorInfo
        self.diagnosticsURL = diagnosticsURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DeskPet", isDirectory: true)
            .appendingPathComponent("diagnostics-redacted.txt")
    }

    func setPetIntentHandler(_ handler: @escaping @MainActor (PetUIIntent) -> Void) {
        petIntent = handler
    }

    /// P17-A — route the main window to a given section. Used by the
    /// onboarding coordinator when the user clicks "configure now" so the
    /// main window opens directly to the AI settings page.
    func setSection(_ section: AppSection) {
        uiState.setSection(section)
    }

    func show() {
        if window == nil {
            let root = RootView(chat: chat, memory: memory, relationship: relationship,
                                prefs: prefs, providers: providers, runtime: runtime,
                                scheduler: scheduler, backup: backup,
                                uiState: uiState,
                                automationIndicatorInfo: automationIndicatorInfo,
                                diagnosticsURL: diagnosticsURL)
                .environmentObject(model)
                .environment(\.sendPetIntent, { [weak self] intent in self?.petIntent(intent) })
                .environment(\.setWindowMode, { [weak self] mode in self?.applyMode(mode) })
            let hosting = NSHostingController(rootView: root)
            let win = NSWindow(contentViewController: hosting)
            win.title = "桌宠 · 陪伴台"
            win.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            let mode = persistedMode
            win.contentMinSize = CompanionConsoleWindowMetrics.minimumSize
            win.setContentSize(CompanionConsoleWindowMetrics.contentSize(for: mode))
            win.isReleasedWhenClosed = false
            win.center()
            window = win
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    private var persistedMode: WindowMode {
        WindowMode(rawValue: uiState.windowModeRaw) ?? .compact
    }

    /// Resize the existing window to a target mode, anchored at the top-left so it doesn't jump
    /// off-screen. Reuses the same window — never recreates it (Runtime is untouched).
    private func applyMode(_ mode: WindowMode) {
        guard let window else { return }
        let target = CompanionConsoleWindowMetrics.contentSize(for: mode)
        let currentTop = window.frame.maxY
        var frame = window.frameRect(forContentRect: CGRect(origin: .zero, size: target))
        frame.origin.x = window.frame.origin.x
        frame.origin.y = currentTop - frame.height
        window.contentMinSize = CompanionConsoleWindowMetrics.minimumSize
        window.setFrame(frame, display: true, animate: true)
    }
}
