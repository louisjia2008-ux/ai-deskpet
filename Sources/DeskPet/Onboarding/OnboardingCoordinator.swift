import AppKit
import Foundation

// P17-A — coordinator that owns the onboarding lifecycle.
//
// Responsibilities:
//   - Decide whether onboarding should appear on launch (`.firstLaunch` reason).
//   - Allow programmatic replay (`.replay` reason from Settings).
//   - Bridge external "open Provider Center" requests posted by the onboarding
//     window itself (the user clicked "configure now") back to the AppDelegate's
//     main window so it routes there.
//
// Threading: MainActor — touches NSWindow + UI state.

@MainActor
final class OnboardingCoordinator {
    private let persistence: OnboardingPersistence
    private let providers: ProviderStore
    private let preferences: PreferencesModel
    private let paths: DeskPetAppPaths
    private let userDefaults: UserDefaults
    /// P19.1 / P0-A — optional live TCC observer. When present, the onboarding
    /// permission step renders the Accessibility + Input Monitoring rows and
    /// binds them to the observer's typed state. The observer is optional so
    /// onboarding can still run in headless tests where no real TCC API is
    /// reachable.
    var permissionObserver: AwarenessPermissionObserver?
    private weak var mainWindow: MainWindowController?
    private var currentWindow: OnboardingWindowController?

    private var providerCenterObserver: NSObjectProtocol?
    /// P17 / R2-08 — live hotkey registration status supplied by the AppDelegate so the
    /// onboarding "ready" step can show the real status instead of the static fallback.
    var hotkeyStatusProvider: () -> GlobalHotKeyRegistrar.RegistrationResult? = { nil }

    init(persistence: OnboardingPersistence,
         providers: ProviderStore,
         preferences: PreferencesModel,
         paths: DeskPetAppPaths,
         permissionObserver: AwarenessPermissionObserver? = nil,
         userDefaults: UserDefaults = .standard) {
        self.persistence = persistence
        self.providers = providers
        self.preferences = preferences
        self.paths = paths
        self.permissionObserver = permissionObserver
        self.userDefaults = userDefaults
    }

    /// Wire external triggers. Call once after mainWindow is created.
    func attach(mainWindow: MainWindowController) {
        self.mainWindow = mainWindow
        if let observer = providerCenterObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        providerCenterObserver = NotificationCenter.default.addObserver(
            forName: .deskpetOpenProviderCenterRequested,
            object: nil,
            queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.mainWindow?.setSection(.providers)
                    self?.mainWindow?.show()
                }
        }
    }

    /// Stop observing notification. MainActor-isolated; the coordinator is
    /// long-lived for the lifetime of the app, so this is only needed if the
    /// host explicitly tears down.
    func detach() {
        if let observer = providerCenterObserver {
            NotificationCenter.default.removeObserver(observer)
            providerCenterObserver = nil
        }
    }

    /// Returns true if onboarding should be presented on this launch.
    /// First-launch presentation is suppressed when the user has already
    /// completed onboarding at the current content version, OR when the user
    /// has explicitly suppressed it via a debug flag (DEBUG only).
    func shouldPresentOnLaunch() -> Bool {
        #if DEBUG
        if ProcessInfo.processInfo.environment["DESKPET_SKIP_ONBOARDING"] != nil {
            return false
        }
        #endif
        let state = persistence.load()
        return !state.isCompleted
    }

    /// Present onboarding if not already shown.
    @discardableResult
    func presentIfNeeded(reason: OnboardingPresentationReason) -> Bool {
        if case .firstLaunch = reason, currentWindow != nil {
            return false  // already presenting
        }
        let configuration = OnboardingWindowController.Configuration()
        let controller = OnboardingWindowController(
            persistence: persistence,
            providers: providers,
            preferences: preferences,
            permissionObserver: permissionObserver,
            configuration: configuration,
            reason: reason,
            hotkeyStatusProvider: { [weak self] in self?.hotkeyStatusProvider() ?? nil },
            onDismiss: { [weak self] in
                guard let self else { return }
                self.currentWindow = nil
                NotificationCenter.default.post(name: .deskpetOnboardingCompleted, object: nil)
            })
        controller.present()
        self.currentWindow = controller
        return true
    }

    /// Programmatically replay onboarding (e.g. from Settings → "重新查看新手引导").
    @discardableResult
    func replay() -> Bool {
        // Reset state first so the view starts at step 0 even if the user
        // had previously completed onboarding.
        do {
            _ = try persistence.reset()
        } catch {
            return false
        }
        return presentIfNeeded(reason: .replay)
    }
}
