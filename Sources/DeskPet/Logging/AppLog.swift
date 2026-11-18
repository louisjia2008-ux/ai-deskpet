import Foundation
import os

// P22 — unified structured logging. Replaces the ad-hoc `print`,
// `FileHandle.standardError.write`, and `debugLog(_:)` calls that were
// scattered across the codebase. Subsystem is the bundle id; each
// category gets its own Logger so a user can filter Console.app to
// `subsystem == "com.deskpet.companion" AND category == "runtime"` for
// e.g. agent-loop tracing without drowning in persistence noise.

public enum AppLogCategory: String, CaseIterable, Sendable {
    case runtime      // AgentRuntimeCoordinator / PetBrainCore
    case ui           // AppShellView / Onboarding / FocusHaloOverlay
    case agent        // PetAgentRuntime loop + planner
    case persistence  // DurableTaskStore / DurableRecoveryStores / SealedStore
    case security     // CapabilityGate / ApprovalRequester / ToolRunner
    case integration  // LLMService / CloudProvider / Provider
    case harness      // Phase harnesses (DEBUG-only)
    case lifecycle    // AppDelegate / launch / shutdown
}

public enum AppLog {
    private static let subsystem = "com.deskpet.companion"

    public static func logger(_ category: AppLogCategory) -> Logger {
        Logger(subsystem: subsystem, category: category.rawValue)
    }

    // Convenience: most code wants the same few operations. Keep the
    // call sites short by routing through these static facades.

    public static func debug(_ category: AppLogCategory, _ message: String) {
        logger(category).debug("\(message, privacy: .public)")
    }

    public static func info(_ category: AppLogCategory, _ message: String) {
        logger(category).info("\(message, privacy: .public)")
    }

    public static func notice(_ category: AppLogCategory, _ message: String) {
        logger(category).notice("\(message, privacy: .public)")
    }

    public static func warning(_ category: AppLogCategory, _ message: String) {
        logger(category).warning("\(message, privacy: .public)")
    }

    public static func error(_ category: AppLogCategory, _ message: String) {
        logger(category).error("\(message, privacy: .public)")
    }

    public static func fault(_ category: AppLogCategory, _ message: String) {
        logger(category).fault("\(message, privacy: .public)")
    }
}
