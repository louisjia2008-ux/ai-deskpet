import AppKit
import SwiftUI

// P17-A — onboarding window controller.
//
// Hosts `OnboardingView` in a dedicated NSWindow so onboarding has its own focus
// context separate from the main floating chat and main window. Window style is
// stable across all five steps (no toolbar, no resize-grab below minimum).
//
// Window-close is treated as "dismiss without completing" so the user is not
// trapped on a non-resolvable state.

@MainActor
final class OnboardingWindowController {
    struct Configuration {
        var windowSize: CGSize = CGSize(width: 720, height: 600)
        var windowTitle: String = "DeskPet 设置引导"
        var reasonsTitle: String = "首次启动"
        var reasonsMessage: String = "让我们一起完成几项简单设置，桌宠就能开始陪你了。"
    }

    let configuration: Configuration
    let viewModel: OnboardingViewModel
    private var windowController: NSWindowController?
    private var window: NSWindow?
    private let onDismiss: () -> Void
    /// P17 / R2-08 — live global-hotkey registration status, supplied by the AppDelegate
    /// (`HotKeys.floatingChatGlobalHotKeyResult`). Previously hardcoded to nil here, which
    /// made the onboarding status line unreachable in production.
    private let hotkeyStatusProvider: () -> GlobalHotKeyRegistrar.RegistrationResult?

    init(persistence: OnboardingPersistence,
         providers: ProviderStore,
         preferences: PreferencesModel,
         permissionObserver: AwarenessPermissionObserver? = nil,
         configuration: Configuration = Configuration(),
         reason: OnboardingPresentationReason,
         hotkeyStatusProvider: @escaping () -> GlobalHotKeyRegistrar.RegistrationResult? = { nil },
         onDismiss: @escaping () -> Void) {
        self.configuration = configuration
        self.hotkeyStatusProvider = hotkeyStatusProvider
        let state = persistence.load()
        self.viewModel = OnboardingViewModel(
            persistence: persistence,
            providers: providers,
            preferences: preferences,
            permissionObserver: permissionObserver,
            initialState: state,
            reason: reason)
        self.onDismiss = onDismiss
    }

    func present() {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: configuration.windowSize),
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false)
        window.title = configuration.windowTitle
        window.titlebarAppearsTransparent = false
        window.isReleasedWhenClosed = false
        window.minSize = CGSize(width: 600, height: 520)
        window.contentView = NSHostingView(
            rootView: OnboardingView(
                viewModel: viewModel,
                hotkeyStatusProvider: hotkeyStatusProvider,
                reasonsTitle: configuration.reasonsTitle,
                reasonsMessage: configuration.reasonsMessage,
                onClose: { [weak self] in self?.dismiss(reason: .windowClosed) }))
        window.center()
        window.setFrameAutosaveName("DeskPetOnboardingWindow")
        let controller = NSWindowController(window: window)
        controller.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
        self.windowController = controller
    }

    enum DismissReason {
        case finished
        case windowClosed
        case cancelled
    }

    func dismiss(reason: DismissReason) {
        guard let window else { return }
        switch reason {
        case .finished:
            window.orderOut(nil)
            windowController?.close()
            windowController = nil
            self.window = nil
            onDismiss()
        case .windowClosed, .cancelled:
            // Treat close-as-cancel as "user dismissed; remember lastStepIndex
            // so the next launch can resume rather than restart from 0".
            try? viewModel.recordShownAndClose()
            window.orderOut(nil)
            windowController?.close()
            windowController = nil
            self.window = nil
            onDismiss()
        }
    }
}
