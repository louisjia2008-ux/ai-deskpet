#if DEBUG
import AppKit
import SwiftUI
import PetAgentRuntime

// P17-A — onboarding smoke harness. Captures the five onboarding steps
// as PNGs for the human visual review packet. Triggered by the
// `DESKPET_P17_ONBOARDING_SCREENSHOTS` environment variable; output goes
// to `DESKPET_P17_ONBOARDING_OUT` or the system temp directory.
//
// This harness is compiled only in DEBUG builds — it does not appear in
// Release binaries (verified via RELEASES_BINARY_AUDIT).

@MainActor
enum P17OnboardingScreenshotHarness {
    static var requestedCapture: String? {
        ProcessInfo.processInfo.environment["DESKPET_P17_ONBOARDING_SCREENSHOTS"]
    }

    static var outputDirectoryURL: URL {
        let env = ProcessInfo.processInfo.environment["DESKPET_P17_ONBOARDING_OUT"]
        let path = env ?? NSTemporaryDirectory().appending("deskpet-p17-onboarding-screenshots")
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    static func runIfRequested(persistence: OnboardingPersistence,
                                providers: ProviderStore,
                                preferences: PreferencesModel) async {
        guard requestedCapture != nil else { return }
        let outputDir = outputDirectoryURL
        try? FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        FileHandle.standardError.write(
            "P17_ONBOARDING_SCREENSHOTS dir=\(outputDir.path)\n".data(using: .utf8)!)

        let steps: [OnboardingStep] = OnboardingStep.allCases
        for step in steps {
            for appearance in ["light", "dark"] {
                await capture(step: step,
                              appearance: appearance,
                              persistence: persistence,
                              providers: providers,
                              preferences: preferences,
                              outputDir: outputDir)
            }
        }

        FileHandle.standardError.write("P17_ONBOARDING_SCREENSHOTS_DONE\n".data(using: .utf8)!)
        NSApp.appearance = nil
        // P17 / R3-04 — terminate the app after captures. The R2-12 rewrite added the
        // light/dark loop but did NOT terminate, so the production app kept running
        // after the harness captured its 10 PNGs — burning ~4% CPU and spamming
        // `SKView: no drawables available for rendering. Skipping this frame.` to the
        // log every ~6 seconds for 10+ hours on the reviewer's machine. Mirror
        // `P17ProductSurfaceHarness.runIfRequested`'s `NSApp.terminate(nil)` here so
        // the evidence pipeline no longer leaks a full DeskPet instance per run.
        FileHandle.standardError.write(
            "P17_ONBOARDING_SCREENSHOTS_TERMINATING\n".data(using: .utf8)!)
        NSApp.terminate(nil)
    }

    private static func capture(step: OnboardingStep,
                                appearance: String,
                                persistence: OnboardingPersistence,
                                providers: ProviderStore,
                                preferences: PreferencesModel,
                                outputDir: URL) async {
        var state = OnboardingState()
        state.lastStepIndex = step.index
        let viewModel = OnboardingViewModel(
            persistence: persistence,
            providers: providers,
            preferences: preferences,
            initialState: state,
            reason: .replay)

        let isDark = appearance == "dark"
        let view = OnboardingView(
            viewModel: viewModel,
            // P17 / R2-08 — also capture the onboarding hotkey status the production host
            // now wires in (R2-08 was: every real host hardcoded nil). The harness seeds a
            // fake `.registered` status so the ready-step capture proves the live copy
            // branch is reachable.
            hotkeyStatusProvider: { .registered },
            // P17 / EVID-04 — the screenshot harness must show the same strings a real
            // onboarding session does, otherwise the captures lie about the product copy.
            reasonsTitle: OnboardingWindowController.Configuration().reasonsTitle,
            reasonsMessage: OnboardingWindowController.Configuration().reasonsMessage,
            onClose: { })

        // P17 / R2-12 — light + dark captures. The window-less NSHostingView needs the same
        // appearance propagation as the surface harness (NSApp.appearance + hosting.appearance
        // + .environment(\.colorScheme, …)) or the dark captures are bit-identical to light.
        NSApp.appearance = NSAppearance(named: isDark ? .darkAqua : .aqua)
        let hosting = NSHostingView(
            rootView: view
                .frame(width: 720, height: 600)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, isDark ? .dark : .light)
                .id("p17-onboarding-\(step.rawValue)-\(appearance)")
        )
        hosting.frame = CGRect(origin: .zero, size: CGSize(width: 720, height: 600))
        hosting.appearance = NSAppearance(named: isDark ? .darkAqua : .aqua)
        hosting.layoutSubtreeIfNeeded()

        guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
            FileHandle.standardError.write("P17_ONBOARDING_SCREENSHOTS_BITMAP_FAILED step=\(step.rawValue)\n".data(using: .utf8)!)
            return
        }
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)

        guard let pngData = bitmap.representation(using: .png, properties: [:]) else {
            FileHandle.standardError.write("P17_ONBOARDING_SCREENSHOTS_PNG_FAILED step=\(step.rawValue)\n".data(using: .utf8)!)
            return
        }
        let pngURL = outputDir.appendingPathComponent("p17_onboarding_step_\(step.rawValue)_\(step.identifierName)_\(appearance).png")
        try? pngData.write(to: pngURL, options: .atomic)
        FileHandle.standardError.write("P17_ONBOARDING_SCREENSHOTS_WROTE step=\(step.rawValue) appearance=\(appearance) bytes=\(pngData.count)\n".data(using: .utf8)!)

        try? await Task.sleep(nanoseconds: 50_000_000)
    }
}

private extension OnboardingStep {
    var identifierName: String {
        switch self {
        case .welcome:     return "welcome"
        case .aiSetup:     return "ai_setup"
        case .permissions: return "permissions"
        case .safety:      return "safety"
        case .ready:       return "ready"
        }
    }
}
#endif
