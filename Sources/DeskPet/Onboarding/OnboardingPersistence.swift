import Foundation
import AICore

// P17-A — onboarding persistence.
//
// State is stored at `<applicationSupportRoot>/onboarding_state.json`. The path
// is resolved from `DeskPetAppPaths.applicationSupportRoot`, so production and
// automation-profile runs land in their own files.

enum OnboardingPersistenceError: Error, LocalizedError {
    case migrationFailed(reason: String)

    var errorDescription: String? {
        switch self {
        case .migrationFailed(let reason):
            return "onboarding state migration failed: \(reason)"
        }
    }
}

struct OnboardingPersistence {
    let fileURL: URL

    init(applicationSupportRoot: URL, fileManager: FileManager = .default) {
        self.fileURL = applicationSupportRoot
            .appendingPathComponent("onboarding_state.json", isDirectory: false)
            .standardizedFileURL
    }

    /// Load persisted state. Returns `OnboardingState()` when no file exists,
    /// when the file is corrupt, or when migration fails (the corruption is logged
    /// so the next save replaces the file).
    func load(fileManager: FileManager = .default) -> OnboardingState {
        guard fileManager.fileExists(atPath: fileURL.path) else {
            return OnboardingState()
        }
        do {
            let data = try Data(contentsOf: fileURL)
            // D3: sealed-aware read (keyless-sealed falls to reset, bytes kept).
            let plain = try SealedStore.openForRead(data)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let raw = try decoder.decode(OnboardingState.self, from: plain)
            let out = migrate(raw)
            SealedStore.migratePlaintext(at: fileURL) { try save(out) }
            return out
        } catch {
            FileHandle.standardError.write(
                "ONBOARDING_PERSISTENCE_LOAD_FAILED: \(error.localizedDescription); resetting state.\n"
                    .data(using: .utf8) ?? Data())
            return OnboardingState()
        }
    }

    /// Persist state. Atomic write so concurrent crash does not leave a partial file.
    func save(_ state: OnboardingState, fileManager: FileManager = .default) throws {
        let directory = fileURL.deletingLastPathComponent()
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(state)
        // D3: sealed when keyed (fail-closed on sealed-without-key).
        try SealedStore.save(data, to: fileURL, fileManager: fileManager)
    }

    /// Mark onboarding completed and persist.
    func markCompleted(providerConfigured: Bool,
                       lastStepIndex: Int,
                       fileManager: FileManager = .default) throws -> OnboardingState {
        var state = load(fileManager: fileManager)
        state.completedAt = Date()
        state.lastShownAt = state.lastShownAt ?? Date()
        state.lastStepIndex = lastStepIndex
        state.providerConfiguredOnCompletion = providerConfigured
        state.contentVersion = OnboardingSchema.currentContentVersion
        try save(state, fileManager: fileManager)
        return state
    }

    /// Record that onboarding was shown but not yet completed.
    func recordShown(stepIndex: Int,
                     fileManager: FileManager = .default) throws -> OnboardingState {
        var state = load(fileManager: fileManager)
        state.lastShownAt = Date()
        state.lastStepIndex = stepIndex
        try save(state, fileManager: fileManager)
        return state
    }

    /// Reset onboarding so the next launch shows it again. Used by Settings →
    /// "重新查看新手引导".
    func reset(fileManager: FileManager = .default) throws -> OnboardingState {
        let fresh = OnboardingState()
        try save(fresh, fileManager: fileManager)
        return fresh
    }

    /// Migrate an older schema to the current schema. Today only one schema
    /// version exists; future versions will branch on `state.schemaVersion`.
    private func migrate(_ state: OnboardingState) -> OnboardingState {
        var migrated = state
        if migrated.schemaVersion < OnboardingSchema.currentSchemaVersion {
            migrated.schemaVersion = OnboardingSchema.currentSchemaVersion
        }
        return migrated
    }
}
