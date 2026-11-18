import AppKit
import AICore
import Combine
import SwiftUI

@MainActor
final class FloatingChatPanelController {
    private enum Metrics {
        static let capsuleSize = FloatingChatPanelMetrics.capsuleSize
        static let taskHUDSize = FloatingChatPanelMetrics.taskHUDSize
        static let screenMargin: CGFloat = 112
        static let bottomOffset: CGFloat = 128
        static let edgePadding: CGFloat = 8
    }

    let store: FloatingChatStateStore

    private let chat: ChatModel
    private let providers: ProviderStore
    private let uiState: AppUIStateStore
    private var panel: FloatingChatPanel
    private var cancellables: Set<AnyCancellable> = []
    private var inactivityTask: Task<Void, Never>?
    private var preferredAnchor: CGPoint?
    private var dragStartAnchor: CGPoint?
    // P17 / R1-08 + R2-04 — user-chosen expanded size. Persisted across collapse→expand so
    // the panel reopens at the size the user last left it instead of clamping back to the
    // capsule frame. Seeded with the production ideal size so the first expand matches
    // EVID-06 (420×520). The memory lives in `FloatingChatExpandedSizeMemory` (shared with
    // the regression tests) and is fed by the live-resize observers installed in
    // `observeResize()` — without those the field was circular and user resizes were lost
    // on every collapse (R2-04).
    //
    // P17 / R3-06 — the R2-04 refactor left a dead `lastExpandedSize` alias here. Zero
    // callers anywhere in Sources/ or Tests/; the comment below that referenced it
    // ("the very first expand uses `lastExpandedSize`") was stale. Removed — the
    // canonical entry point is `expandedSizeMemory.expandedSize`.
    internal private(set) var expandedSizeMemory = FloatingChatExpandedSizeMemory()
    // P17 / R2-03 — host-provided route to the main window's AI settings section. When nil
    // the failed-message CTA stays hidden (see `FloatingChatWindowView.onOpenAISettings`).
    private let onOpenAISettings: (() -> Void)?

    init(store: FloatingChatStateStore,
         chat: ChatModel,
         providers: ProviderStore,
         uiState: AppUIStateStore,
         onOpenAISettings: (() -> Void)? = nil) {
        self.store = store
        self.chat = chat
        self.providers = providers
        self.uiState = uiState
        self.onOpenAISettings = onOpenAISettings
        self.preferredAnchor = uiState.floatingAnchor
        // P17 / CX-02 — the panel advertises the min/max clamp for the expanded state; we use
        // the ideal size as the initial geometry to preserve the production layout.
        self.panel = FloatingChatPanel(
            contentRect: CGRect(origin: .zero, size: Metrics.capsuleSize),
            styleMask: [.borderless, .fullSizeContentView, .resizable],
            backing: .buffered,
            defer: false)

        configurePanel()
        panel.onEscape = { [weak self] in self?.collapse() }
        installRootView()
        observeState()
        observeResize()
        syncModelBadge()
        syncChatState()
        apply(visibilityState: store.visibilityState, animated: false)
        startInactivityTimer()
    }

    deinit {
        inactivityTask?.cancel()
    }

    /// P16 — global (screen-space) center of the chat panel, or nil when the panel is hidden.
    /// Used by `OverlayWindowController.setChatLookTarget` to point the character's gaze at
    /// the chat panel while listening. Computed from the panel's frame on screen.
    var panelAnchorGlobal: CGPoint? {
        guard store.visibilityState.isVisible else { return nil }
        return CGPoint(x: panel.frame.midX, y: panel.frame.midY)
    }

    func showCapsule() {
        store.showCapsule()
    }

    func expand() {
        store.expand()
    }

    func toggle() {
        store.toggleExpanded()
    }

    func collapse() {
        store.collapseToCapsule()
    }

    func hide() {
        store.hide()
    }

    private func configurePanel() {
        panel.title = "DeskPet Floating Chat"
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        // P17 / CX-02 — clamp content size so resizing stays within the design spec.
        panel.contentMinSize = FloatingChatPanelMetrics.expandedMinSize
        panel.contentMaxSize = FloatingChatPanelMetrics.expandedMaxSize
    }

    private func installRootView() {
        let root = FloatingChatWindowView(
            store: store,
            chat: chat,
            providers: providers,
            onExpand: { [weak self] in self?.expand() },
            onCollapse: { [weak self] in self?.collapse() },
            onDragChanged: { [weak self] translation in self?.drag(by: translation) },
            onDragEnded: { [weak self] translation in self?.finishDrag(by: translation) },
            onOpenAISettings: onOpenAISettings)
        let hosting = NSHostingView(rootView: root)
        hosting.frame = CGRect(origin: .zero, size: Metrics.capsuleSize)
        hosting.autoresizingMask = [.width, .height]
        panel.contentView = hosting
    }

    private func observeState() {
        store.$visibilityState
            .removeDuplicates()
            .sink { [weak self] state in
                self?.apply(visibilityState: state, animated: true)
            }
            .store(in: &cancellables)

        chat.objectWillChange
            .sink { [weak self] _ in
                Task { @MainActor in
                    self?.syncChatState()
                }
            }
            .store(in: &cancellables)

        providers.objectWillChange
            .sink { [weak self] _ in
                Task { @MainActor in
                    self?.syncModelBadge()
                }
            }
            .store(in: &cancellables)
    }

    /// P17 / R2-04 — observe user-driven panel resizes so the chosen expanded size is
    /// actually remembered. `didEndLiveResize` covers mouse-drag resizing; `didResize`
    /// covers programmatic/zoom changes. Both are ignored unless the panel is expanded, so
    /// the capsule and task-HUD frames can never overwrite the expanded memory.
    private func observeResize() {
        for name in [NSWindow.didEndLiveResizeNotification, NSWindow.didResizeNotification] {
            NotificationCenter.default.publisher(for: name, object: panel)
                .sink { [weak self] _ in
                    guard let self else { return }
                    self.noteResize(to: self.panel.frame.size)
                }
                .store(in: &cancellables)
        }
    }

    /// Internal seam used by the resize observers and by `P17FloatingChatPanelGeometryTests`.
    @discardableResult
    internal func noteResize(to size: CGSize) -> Bool {
        expandedSizeMemory.noteResize(to: size, state: store.visibilityState)
    }

    private func startInactivityTimer() {
        inactivityTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                self?.tickInactivity()
            }
        }
    }

    private func tickInactivity() {
        syncChatState()
        _ = store.collapseIfInactive()
    }

    private func syncChatState() {
        store.isResponding = chat.busy
    }

    private func syncModelBadge() {
        store.modelBadge = modelBadgeText()
    }

    private func apply(visibilityState: FloatingChatVisibilityState, animated: Bool) {
        panel.allowsKeyWindow = visibilityState == .expanded
        panel.ignoresMouseEvents = visibilityState == .hidden

        guard visibilityState.isVisible else {
            panel.orderOut(nil)
            return
        }

        let frame = frame(for: visibilityState)
        panel.alphaValue = alpha(for: visibilityState)
        panel.setFrame(frame, display: true, animate: animated)

        if visibilityState == .expanded {
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
        } else {
            panel.orderFrontRegardless()
        }
    }

    private func drag(by translation: CGSize) {
        guard store.visibilityState.isVisible else { return }
        store.markUserActivity()

        if dragStartAnchor == nil {
            dragStartAnchor = currentAnchor
        }

        guard let dragStartAnchor else { return }
        let size = size(for: store.visibilityState)
        let placement = placement(for: dragStartAnchor)
        let proposedAnchor = placement.translatedAnchor(from: dragStartAnchor, translation: translation)
        let frame = placement.frame(size: size, anchor: proposedAnchor)
        preferredAnchor = placement.anchor(for: frame)
        panel.setFrame(frame, display: true, animate: false)
    }

    private func finishDrag(by translation: CGSize) {
        drag(by: translation)
        dragStartAnchor = nil
        if let preferredAnchor {
            uiState.floatingAnchor = preferredAnchor
        }
    }

    private func frame(for state: FloatingChatVisibilityState) -> CGRect {
        let size = size(for: state)
        return placement(for: preferredAnchor).frame(size: size, anchor: preferredAnchor)
    }

    private func size(for state: FloatingChatVisibilityState) -> CGSize {
        switch state {
        case .hidden, .capsuleIdle, .capsuleActive:
            return Metrics.capsuleSize
        case .expanded:
            // P17 / CX-02 + R1-08 — use the user's last-chosen expanded size so the
            // panel reopens at the size they left it; clamp the panel's current size so
            // a fresh resize within the design spec sticks. The very first expand uses
            // `expandedSizeMemory.expandedSize` (seeded with the production ideal size
            // — see `FloatingChatExpandedSizeMemory.init(initial:)`).
            return expandedSizeMemory.expandedSize
        case .taskHUD:
            return Metrics.taskHUDSize
        }
    }

    private func placement(for anchor: CGPoint?) -> FloatingChatPanelPlacement {
        FloatingChatPanelPlacement(
            visibleFrame: visibleFrame(containing: anchor),
            screenMargin: Metrics.screenMargin,
            bottomOffset: Metrics.bottomOffset,
            edgePadding: Metrics.edgePadding)
    }

    private func visibleFrame(containing anchor: CGPoint?) -> CGRect {
        if let anchor,
           let screen = NSScreen.screens.first(where: { $0.visibleFrame.insetBy(dx: -64, dy: -64).contains(anchor) }) {
            return screen.visibleFrame
        }
        return NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
    }

    private var currentAnchor: CGPoint {
        CGPoint(x: panel.frame.maxX, y: panel.frame.minY)
    }

    private func alpha(for state: FloatingChatVisibilityState) -> CGFloat {
        switch state {
        case .hidden:
            return 0
        case .capsuleIdle:
            return 0.9
        case .capsuleActive:
            return 0.98
        case .expanded:
            return 1
        case .taskHUD:
            return 0.94
        }
    }

    private func modelBadgeText() -> String {
        // P17 / CI-04, LC-02 — provider display name only; localized fallback.
        switch providers.readiness() {
        case .ready(let providerName, _):
            return providerName
        case .providerConnectedNoModel(let providerName):
            return providerName
        case .providerConfiguredButDisconnected:
            return "AI 未连接"
        case .noProvider:
            return "未配置 AI"
        case .error:
            return "AI 异常"
        }
    }

}

@MainActor
private final class FloatingChatPanel: NSPanel {
    var allowsKeyWindow = false
    var onEscape: (() -> Void)?

    override var canBecomeKey: Bool {
        allowsKeyWindow
    }

    override var canBecomeMain: Bool {
        false
    }

    override func cancelOperation(_ sender: Any?) {
        onEscape?()
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {
            onEscape?()
            return
        }
        super.keyDown(with: event)
    }
}
