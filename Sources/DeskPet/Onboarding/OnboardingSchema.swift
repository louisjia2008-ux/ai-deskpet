import Foundation

// P17-A — first-run onboarding state schema.
//
// Schema versioning rules:
//   - Bumping `currentSchemaVersion` triggers migration of an older persisted file.
//   - Adding a NEW field with a default value is a NON-breaking schema change — keep
//     the same `currentSchemaVersion` and provide the default in `init(from:)`.
//   - Removing or renaming a field requires a `currentSchemaVersion` bump and a
//     migration in `OnboardingPersistence.migrate(_:)`.
//
// On-disk layout: `<applicationSupportRoot>/onboarding_state.json`.

enum OnboardingSchema {
    /// Schema version written into the persisted JSON. Bump when migrating.
    static let currentSchemaVersion = 1

    /// Onboarding content version (steps + copy). Independent of schema versioning
    /// so a copy refresh can be released without a migration.
    static let currentContentVersion = 1
}

struct OnboardingState: Codable, Equatable {
    var schemaVersion: Int
    var contentVersion: Int
    var completedAt: Date?
    var lastShownAt: Date?
    var lastStepIndex: Int
    var providerConfiguredOnCompletion: Bool
    var skipReasons: [String: Date]

    init(schemaVersion: Int = OnboardingSchema.currentSchemaVersion,
         contentVersion: Int = OnboardingSchema.currentContentVersion,
         completedAt: Date? = nil,
         lastShownAt: Date? = nil,
         lastStepIndex: Int = 0,
         providerConfiguredOnCompletion: Bool = false,
         skipReasons: [String: Date] = [:]) {
        self.schemaVersion = schemaVersion
        self.contentVersion = contentVersion
        self.completedAt = completedAt
        self.lastShownAt = lastShownAt
        self.lastStepIndex = lastStepIndex
        self.providerConfiguredOnCompletion = providerConfiguredOnCompletion
        self.skipReasons = skipReasons
    }

    /// Onboarding has been completed AND matches current content version.
    var isCompleted: Bool {
        completedAt != nil && contentVersion >= OnboardingSchema.currentContentVersion
    }

    /// User has finished or dismissed onboarding. The window should not reappear.
    var isResolved: Bool {
        completedAt != nil
    }
}

/// Reason for presenting onboarding. Affects what the user can do.
enum OnboardingPresentationReason: String, Equatable {
    /// First-launch flow. Welcome + setup + safety + ready.
    case firstLaunch
    /// User explicitly requested to view onboarding again from Settings.
    case replay
}
