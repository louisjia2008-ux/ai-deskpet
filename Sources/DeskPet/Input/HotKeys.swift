import AppKit

/// Global shortcuts (doc §7.3). Uses event monitors: the global monitor needs the user to
/// grant Input Monitoring; without it the menu bar still provides every action, and the local
/// monitor covers the case where our process is frontmost. Graceful degradation (doc §14.2).
@MainActor
final class HotKeys {

    var onToggleHide: () -> Void = {}
    var onRecall: () -> Void = {}
    var onQuickTask: () -> Void = {}
    var onQuickChat: () -> Void = {}
    var onFloatingChat: (() -> Void)?
    /// P17 / R1-13 — published registration status so the onboarding "ready" step can
    /// surface a live status line ("快捷键已启用" / "未注册：需要输入监控") rather
    /// than the static string it had before.
    @Published private(set) var floatingChatGlobalHotKeyResult: GlobalHotKeyRegistrar.RegistrationResult = .notAttempted

    private var monitors: [Any] = []
    private let floatingChatHotKey = GlobalHotKey.floatingChatOptionSpace
    private lazy var floatingChatRegistrar = GlobalHotKeyRegistrar(hotKey: floatingChatHotKey)
    private let toggleKey: UInt16 = 35    // P
    private let recallKey: UInt16 = 15    // R
    private let quickTaskKey: UInt16 = 45 // N
    private let quickChatKey: UInt16 = 0  // A
    private let required: NSEvent.ModifierFlags = [.command, .option]

    func install() {
        installFloatingChatHotKey()
        guard monitors.isEmpty else { return }

        let handle: (NSEvent) -> Bool = { [weak self] event in
            guard let self else { return false }
            if !self.floatingChatGlobalHotKeyResult.isRegistered &&
                self.floatingChatHotKey.matches(eventKeyCode: event.keyCode,
                                                modifierFlags: event.modifierFlags) {
                self.fireFloatingChat()
                return true
            }
            guard event.modifierFlags.intersection([.command, .option, .control, .shift]) == self.required
            else { return false }
            switch event.keyCode {
            case self.toggleKey: self.onToggleHide(); return true
            case self.recallKey: self.onRecall(); return true
            case self.quickTaskKey: self.onQuickTask(); return true
            case self.quickChatKey:
                // Best-effort event monitor shortcut, not a guaranteed registered system hotkey.
                // P1 prefers the new floating chat when wired, while keeping the old callback as fallback.
                self.fireFloatingChat()
                return true
            default: return false
            }
        }
        if let g = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { _ = handle($0) }) {
            monitors.append(g)
        }
        if let l = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { handle($0) ? nil : $0 }) {
            monitors.append(l)
        }
    }

    /// P18.2 — explicit teardown. Removes the global/local `NSEvent` key-down
    /// monitors and unregisters the Carbon floating-chat hotkey. Idempotent: safe
    /// before `install()` (monitors empty) and safe to call twice; after `uninstall()`
    /// a later `install()` re-establishes everything cleanly (`register()` is itself
    /// idempotent, and the `monitors.isEmpty` guard re-arms once the array is cleared).
    /// Called from `applicationWillTerminate`. Not placed in `deinit` because the
    /// monitor tokens are non-`Sendable` and `HotKeys` is a process-lifetime singleton.
    func uninstall() {
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        monitors.removeAll()
        floatingChatRegistrar.unregister()
        floatingChatGlobalHotKeyResult = .notAttempted
    }

    private func installFloatingChatHotKey() {
        floatingChatRegistrar.onPressed = { [weak self] in
            self?.fireFloatingChat()
        }
        floatingChatGlobalHotKeyResult = floatingChatRegistrar.register()
    }

    /// P18.2 — test seam: number of currently-installed `NSEvent` monitors. Used by
    /// `P18_2LifecycleTests` to prove `install()` idempotency and `uninstall()` cleanup.
    var installedMonitorCount: Int { monitors.count }

    private func fireFloatingChat() {
        if let onFloatingChat {
            onFloatingChat()
        } else {
            onQuickChat()
        }
    }
}
