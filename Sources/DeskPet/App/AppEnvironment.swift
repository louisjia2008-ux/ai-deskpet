import Combine
import CoreGraphics
import Foundation
import AICore

struct DeskPetAppPaths: Equatable {
    var profileID: String?
    var profileRoot: URL?
    var applicationSupportRoot: URL
    var conversationsURL: URL
    var memoriesURL: URL
    var tasksURL: URL
    var relationshipURL: URL
    var preferencesURL: URL
    var providersURL: URL
    var scheduledTasksURL: URL
    var agentTaskLedgerURL: URL
    var agentTaskActivityURL: URL
    var agentRunEventsDirectory: URL
    var agentCheckpointsDirectory: URL
    var agentSideEffectsDirectory: URL
    var modelConformanceProfilesDirectory: URL
    var logsDirectory: URL
    var diagnosticsURL: URL
    var cachesDirectory: URL
    var temporaryOutputDirectory: URL
    var workspaceRoot: URL
    var uiStateURL: URL?
    // P14.1 — durable task runtime persistence (R-B-01 wiring).
    var durableTasksDirectory: URL
    var durableGoalsDirectory: URL
    var durableInboxURL: URL
    var durableSchedulerSnapshotsDirectory: URL
    var durableAuditLogURL: URL
}

enum DeskPetAutomationDataRootMode: Equatable {
    case explicit(URL)
    case appTemporary

    var identifier: String {
        switch self {
        case .explicit: return "explicit"
        case .appTemporary: return "appTemporary"
        }
    }

    var displayName: String {
        switch self {
        case .explicit: return "Explicit"
        case .appTemporary: return "App Temporary"
        }
    }
}

struct DeskPetAutomationIndicatorInfo: Equatable {
    var profileID: String
    var rootMode: DeskPetAutomationDataRootMode
    var isolation: String

    var displayText: String {
        "AUTOMATION PROFILE: \(profileID) - \(rootMode.displayName) - \(isolation)"
    }

    var accessibilityValue: String {
        "profile=\(profileID); rootMode=\(rootMode.identifier); isolation=\(isolation)"
    }
}

enum DeskPetAppEnvironmentError: Error, Equatable, LocalizedError {
    case invalidProfileID(String)
    case missingDataRoot
    case invalidDataRootMode(String)
    case dataRootMustBeAbsolute(String)
    case unsafeDataRoot(String)
    case unsafeCleanupRoot(String)
    case resetRequiresAppTemporary

    var errorDescription: String? {
        switch self {
        case .invalidProfileID(let value):
            return "invalid automation profile id: \(value)"
        case .missingDataRoot:
            return "automation profile requires --data-root"
        case .invalidDataRootMode(let value):
            return "invalid automation data root mode: \(value)"
        case .dataRootMustBeAbsolute(let value):
            return "automation data root must be absolute: \(value)"
        case .unsafeDataRoot(let value):
            return "automation data root is not in an allowed temporary/review location: \(value)"
        case .unsafeCleanupRoot(let value):
            return "refusing to clean unsafe automation root: \(value)"
        case .resetRequiresAppTemporary:
            return "automation profile reset requires app-temporary data root mode"
        }
    }
}

struct DeskPetAppEnvironment {
    enum Mode: Equatable {
        case normal
        case automation(profileID: String)

        var profileID: String? {
            if case .automation(let id) = self { return id }
            return nil
        }
    }

    var mode: Mode
    var paths: DeskPetAppPaths
    var automationDataRootMode: DeskPetAutomationDataRootMode?
    var secretStore: any SecretStore
    var uiStateBackend: AppUIStateStore.Backend

    var automationProfileID: String? { mode.profileID }
    var automationIndicatorInfo: DeskPetAutomationIndicatorInfo? {
        guard let profileID = automationProfileID,
              let automationDataRootMode else { return nil }
        return DeskPetAutomationIndicatorInfo(profileID: profileID,
                                             rootMode: automationDataRootMode,
                                             isolation: "ready")
    }

    static func fromProcess(arguments: [String] = CommandLine.arguments) throws -> DeskPetAppEnvironment {
        #if DEBUG
        // P17-D — fast-path DEBUG-only override. Production Release paths
        // ignore this env var entirely (`#if DEBUG`).
        if let isolatedRoot = isolatedDebugAppSupportRoot() {
            return try normal(applicationSupportRoot: isolatedRoot.appSupportRoot,
                               cachesRoot: isolatedRoot.cachesRoot,
                               temporaryDirectory: isolatedRoot.temporaryDirectory)
        }
        guard let profile = value(after: "--automation-profile", in: arguments) else {
            return try normal()
        }
        let resetProfile = arguments.contains("--automation-reset-profile")
        if let mode = value(after: "--automation-data-root-mode", in: arguments) {
            guard mode == "app-temporary" else {
                throw DeskPetAppEnvironmentError.invalidDataRootMode(mode)
            }
            return try automation(profileID: profile,
                                  dataRootMode: .appTemporary,
                                  resetProfile: resetProfile)
        }
        guard let root = value(after: "--data-root", in: arguments) else {
            throw DeskPetAppEnvironmentError.missingDataRoot
        }
        return try automation(profileID: profile,
                              dataRootMode: .explicit(URL(fileURLWithPath: root, isDirectory: true)),
                              resetProfile: false)
        #else
        return try normal()
        #endif
    }

    #if DEBUG
    /// P17-D — read the optional DEBUG-only isolated root env var.
    /// Returns nil if the env var is unset OR if the resolved path is
    /// not in a safe location (we refuse to redirect the production
    /// Application Support root to an arbitrary user-chosen path).
    private static func isolatedDebugAppSupportRoot() -> (appSupportRoot: URL,
                                                          cachesRoot: URL,
                                                          temporaryDirectory: URL)? {
        let env = ProcessInfo.processInfo.environment["DESKPET_APP_SUPPORT_ROOT"]
        guard let raw = env, !raw.isEmpty else { return nil }
        let root = URL(fileURLWithPath: raw, isDirectory: true).standardizedFileURL
        guard isAllowedIsolatedDebugRoot(root) else {
            FileHandle.standardError.write(
                "DESKPET_APP_SUPPORT_ROOT rejected: \(root.path) is not a safe location\n"
                    .data(using: .utf8) ?? Data())
            return nil
        }
        let appSupportRoot = root
            .appendingPathComponent("ApplicationSupport", isDirectory: true)
            .standardizedFileURL
        let cachesRoot = root
            .appendingPathComponent("Caches", isDirectory: true)
            .standardizedFileURL
        let temporaryDirectory = root
            .appendingPathComponent("Tmp", isDirectory: true)
            .standardizedFileURL
        return (appSupportRoot, cachesRoot, temporaryDirectory)
    }

    /// Allow only locations that are clearly temporary / review / test.
    /// Production `~/Library/Application Support/DeskPet/` is NEVER
    /// accepted via this path even in DEBUG builds.
    private static func isAllowedIsolatedDebugRoot(_ root: URL) -> Bool {
        let path = standardized(root).path
        guard path != "/", path != NSHomeDirectory() else { return false }
        let productionAppSupport = normalApplicationSupportRoot().path
        guard path != productionAppSupport,
              !path.hasPrefix(productionAppSupport + "/") else { return false }
        let allowedPrefixes = [
            "/private/tmp",
            "/tmp",
            standardized(FileManager.default.temporaryDirectory).path,
            standardized(URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)).path,
        ]
        if allowedPrefixes.contains(where: { path == $0 || path.hasPrefix($0 + "/") }) {
            return true
        }
        return path.contains("/DeskPet/review/")
    }
    #endif

    static func normal() throws -> DeskPetAppEnvironment {
        try normal(applicationSupportRoot: normalApplicationSupportRoot(),
                   cachesRoot: normalCachesRoot(),
                   temporaryDirectory: FileManager.default.temporaryDirectory)
    }

    static func normal(applicationSupportRoot: URL,
                       cachesRoot: URL,
                       temporaryDirectory: URL,
                       fileManager: FileManager = .default) throws -> DeskPetAppEnvironment {
        let supportRoot = applicationSupportRoot.standardizedFileURL
        let cachesRoot = cachesRoot.standardizedFileURL
        let temporaryRoot = temporaryDirectory.standardizedFileURL
            .appendingPathComponent("DeskPet", isDirectory: true)
        let paths = makePaths(profileID: nil,
                              profileRoot: nil,
                              supportRoot: supportRoot,
                              cachesRoot: cachesRoot,
                              temporaryRoot: temporaryRoot,
                              workspaceRoot: supportRoot.appendingPathComponent("workspace", isDirectory: true),
                              uiStateURL: nil)
        try createDirectories(for: paths, fileManager: fileManager)
        return DeskPetAppEnvironment(mode: .normal,
                                     paths: paths,
                                     automationDataRootMode: nil,
                                     secretStore: KeychainSecretStore(),
                                     uiStateBackend: .userDefaults(.standard))
    }

    static func automation(profileID rawProfileID: String, dataRoot: URL) throws -> DeskPetAppEnvironment {
        try automation(profileID: rawProfileID,
                       dataRootMode: .explicit(dataRoot),
                       resetProfile: false)
    }

    static func automation(profileID rawProfileID: String,
                           dataRootMode: DeskPetAutomationDataRootMode,
                           resetProfile: Bool = false,
                           temporaryDirectory: URL? = nil,
                           fileManager: FileManager = .default) throws -> DeskPetAppEnvironment {
        let profileID = try sanitizeProfileID(rawProfileID)
        if resetProfile, dataRootMode != .appTemporary {
            throw DeskPetAppEnvironmentError.resetRequiresAppTemporary
        }
        let root = try automationDataRoot(for: dataRootMode, temporaryDirectory: temporaryDirectory)
        guard root.path.hasPrefix("/") else {
            throw DeskPetAppEnvironmentError.dataRootMustBeAbsolute(root.path)
        }
        guard isAllowedAutomationDataRoot(root) else {
            throw DeskPetAppEnvironmentError.unsafeDataRoot(root.path)
        }
        let profileRoot = root.appendingPathComponent(profileID, isDirectory: true)
        if resetProfile {
            try resetAppTemporaryAutomationProfileRoot(profileRoot,
                                                       dataRoot: root,
                                                       fileManager: fileManager)
        }
        let supportRoot = profileRoot.appendingPathComponent("ApplicationSupport", isDirectory: true)
        let cachesRoot = profileRoot.appendingPathComponent("Caches", isDirectory: true)
        let temporaryRoot = profileRoot.appendingPathComponent("Tmp", isDirectory: true)
        let paths = makePaths(profileID: profileID,
                              profileRoot: profileRoot,
                              supportRoot: supportRoot,
                              cachesRoot: cachesRoot,
                              temporaryRoot: temporaryRoot,
                              workspaceRoot: profileRoot.appendingPathComponent("workspace", isDirectory: true),
                              uiStateURL: profileRoot.appendingPathComponent("ui_state.json"))
        try createDirectories(for: paths, fileManager: fileManager)
        try validateResolvedProfileRoot(profileRoot, dataRoot: root, fileManager: fileManager)
        try Data("DeskPet automation profile\n".utf8)
            .write(to: profileRoot.appendingPathComponent(".deskpet-automation-profile"), options: .atomic)
        return DeskPetAppEnvironment(mode: .automation(profileID: profileID),
                                     paths: paths,
                                     automationDataRootMode: dataRootMode,
                                     secretStore: InMemorySecretStore(),
                                     uiStateBackend: .file(paths.uiStateURL!))
    }

    static func cleanAutomationProfileRoot(_ profileRoot: URL) throws {
        let root = standardized(profileRoot)
        let marker = root.appendingPathComponent(".deskpet-automation-profile")
        guard FileManager.default.fileExists(atPath: marker.path),
              let parent = root.deletingLastPathComponent().path.nilIfEmpty,
              isAllowedAutomationDataRoot(URL(fileURLWithPath: parent, isDirectory: true)) else {
            throw DeskPetAppEnvironmentError.unsafeCleanupRoot(root.path)
        }
        try FileManager.default.removeItem(at: root)
    }

    private static func value(after flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag),
              arguments.indices.contains(arguments.index(after: index)) else {
            return nil
        }
        return arguments[arguments.index(after: index)]
    }

    private static func makePaths(profileID: String?,
                                  profileRoot: URL?,
                                  supportRoot: URL,
                                  cachesRoot: URL,
                                  temporaryRoot: URL,
                                  workspaceRoot: URL,
                                  uiStateURL: URL?) -> DeskPetAppPaths {
        DeskPetAppPaths(
            profileID: profileID,
            profileRoot: profileRoot,
            applicationSupportRoot: supportRoot,
            conversationsURL: supportRoot.appendingPathComponent("conversations.json"),
            memoriesURL: supportRoot.appendingPathComponent("memories.json"),
            tasksURL: supportRoot.appendingPathComponent("tasks.json"),
            relationshipURL: supportRoot.appendingPathComponent("relationship.json"),
            preferencesURL: supportRoot.appendingPathComponent("preferences.json"),
            providersURL: supportRoot.appendingPathComponent("providers.json"),
            scheduledTasksURL: supportRoot.appendingPathComponent("scheduled_tasks.json"),
            agentTaskLedgerURL: supportRoot.appendingPathComponent("agent_task_ledger.json"),
            agentTaskActivityURL: supportRoot.appendingPathComponent("agent_task_activity.jsonl"),
            agentRunEventsDirectory: supportRoot.appendingPathComponent("AgentRunEvents", isDirectory: true),
            agentCheckpointsDirectory: supportRoot.appendingPathComponent("AgentCheckpoints", isDirectory: true),
            agentSideEffectsDirectory: supportRoot.appendingPathComponent("AgentSideEffects", isDirectory: true),
            modelConformanceProfilesDirectory: supportRoot.appendingPathComponent("ModelConformanceProfiles", isDirectory: true),
            logsDirectory: profileRoot?.appendingPathComponent("Logs", isDirectory: true)
                ?? supportRoot.appendingPathComponent("Logs", isDirectory: true),
            diagnosticsURL: (profileRoot?.appendingPathComponent("Logs", isDirectory: true)
                ?? supportRoot.appendingPathComponent("Logs", isDirectory: true))
                .appendingPathComponent("diagnostics-redacted.txt"),
            cachesDirectory: cachesRoot,
            temporaryOutputDirectory: temporaryRoot,
            workspaceRoot: workspaceRoot,
            uiStateURL: uiStateURL,
            // P14.1 — durable task runtime persistence roots.
            durableTasksDirectory: supportRoot.appendingPathComponent("DurableTasks", isDirectory: true),
            durableGoalsDirectory: supportRoot.appendingPathComponent("Goals", isDirectory: true),
            durableInboxURL: supportRoot.appendingPathComponent("DurableInbox.jsonl"),
            durableSchedulerSnapshotsDirectory: supportRoot.appendingPathComponent("DurableSchedulerSnapshots", isDirectory: true),
            durableAuditLogURL: supportRoot.appendingPathComponent("DurableAuditLog.jsonl"))
    }

    private static func automationDataRoot(for mode: DeskPetAutomationDataRootMode,
                                           temporaryDirectory: URL?) throws -> URL {
        switch mode {
        case .explicit(let root):
            return standardized(root)
        case .appTemporary:
            let appTemporaryRoot = standardized(temporaryDirectory ?? FileManager.default.temporaryDirectory)
            return appTemporaryRoot
                .appendingPathComponent("DeskPetAutomation", isDirectory: true)
                .standardizedFileURL
        }
    }

    private static func createDirectories(for paths: DeskPetAppPaths,
                                          fileManager: FileManager = .default) throws {
        let directories = [
            paths.applicationSupportRoot,
            paths.agentRunEventsDirectory,
            paths.agentCheckpointsDirectory,
            paths.agentSideEffectsDirectory,
            paths.modelConformanceProfilesDirectory,
            paths.logsDirectory,
            paths.cachesDirectory,
            paths.temporaryOutputDirectory,
            paths.workspaceRoot,
            paths.profileRoot,
            paths.uiStateURL?.deletingLastPathComponent(),
            // P14.1 — durable task kernel persistence roots (R-B-01 wiring).
            paths.durableTasksDirectory,
            paths.durableGoalsDirectory,
            paths.durableSchedulerSnapshotsDirectory,
        ].compactMap { $0 }
        for directory in directories {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        }
    }

    private static func resetAppTemporaryAutomationProfileRoot(_ profileRoot: URL,
                                                               dataRoot: URL,
                                                               fileManager: FileManager) throws {
        let root = standardized(profileRoot)
        let parent = standardized(dataRoot)
        let forbidden = [
            "/",
            "/tmp",
            "/private/tmp",
            NSHomeDirectory(),
            normalApplicationSupportRoot().path,
            parent.path,
        ]
        guard !forbidden.contains(root.path),
              root.path.hasPrefix(parent.path + "/"),
              root.deletingLastPathComponent().path == parent.path else {
            throw DeskPetAppEnvironmentError.unsafeCleanupRoot(root.path)
        }
        guard fileManager.fileExists(atPath: root.path) else { return }
        if (try? fileManager.destinationOfSymbolicLink(atPath: root.path)) != nil {
            throw DeskPetAppEnvironmentError.unsafeCleanupRoot(root.path)
        }
        try validateResolvedProfileRoot(root, dataRoot: parent, fileManager: fileManager)
        let marker = root.appendingPathComponent(".deskpet-automation-profile")
        guard fileManager.fileExists(atPath: marker.path) else {
            throw DeskPetAppEnvironmentError.unsafeCleanupRoot(root.path)
        }
        try fileManager.removeItem(at: root)
    }

    private static func validateResolvedProfileRoot(_ profileRoot: URL,
                                                    dataRoot: URL,
                                                    fileManager: FileManager) throws {
        let root = standardized(profileRoot)
        let parent = standardized(dataRoot)
        guard root.path.hasPrefix(parent.path + "/"),
              root.path != parent.path,
              root.path != "/",
              root.path != "/tmp",
              root.path != "/private/tmp",
              root.path != NSHomeDirectory(),
              root.path != normalApplicationSupportRoot().path else {
            throw DeskPetAppEnvironmentError.unsafeDataRoot(root.path)
        }
        if (try? fileManager.destinationOfSymbolicLink(atPath: root.path)) != nil {
            throw DeskPetAppEnvironmentError.unsafeDataRoot(root.path)
        }
        let resolvedParent = parent.resolvingSymlinksInPath().standardizedFileURL
        let resolvedRoot = root.resolvingSymlinksInPath().standardizedFileURL
        guard resolvedRoot.path.hasPrefix(resolvedParent.path + "/"),
              resolvedRoot.path != resolvedParent.path else {
            throw DeskPetAppEnvironmentError.unsafeDataRoot(resolvedRoot.path)
        }
    }

    private static func sanitizeProfileID(_ raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let pattern = #"^[A-Za-z0-9_-]{1,64}$"#
        guard trimmed.range(of: pattern, options: .regularExpression) != nil else {
            throw DeskPetAppEnvironmentError.invalidProfileID(raw)
        }
        return trimmed
    }

    private static func isAllowedAutomationDataRoot(_ root: URL) -> Bool {
        let path = standardized(root).path
        guard path != "/", path != NSHomeDirectory() else { return false }
        let appSupport = normalApplicationSupportRoot().path
        guard path != appSupport, !path.hasPrefix(appSupport + "/") else { return false }
        let allowedPrefixes = [
            "/private/tmp",
            "/tmp",
            standardized(FileManager.default.temporaryDirectory).path,
            standardized(URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)).path,
        ]
        if allowedPrefixes.contains(where: { path == $0 || path.hasPrefix($0 + "/") }) {
            return true
        }
        return path.contains("/DeskPet/review/")
    }

    private static func normalApplicationSupportRoot() -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DeskPet", isDirectory: true)
            .standardizedFileURL
    }

    private static func normalCachesRoot() -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DeskPet", isDirectory: true)
            .standardizedFileURL
    }

    private static func standardized(_ url: URL) -> URL {
        URL(fileURLWithPath: url.path, isDirectory: true).standardizedFileURL
    }
}

@MainActor
final class AppUIStateStore: ObservableObject {
    enum Backend {
        case userDefaults(UserDefaults)
        case file(URL)
    }

    private struct Snapshot: Codable, Equatable {
        var sectionRaw: String
        var windowModeRaw: String
        var floatingAnchorX: Double?
        var floatingAnchorY: Double?
    }

    private enum Keys {
        static let section = "deskpet.section"
        static let windowMode = "deskpet.windowMode"
        static let hasFloatingAnchor = "DeskPet.FloatingChat.hasCustomAnchor"
        static let floatingAnchorX = "DeskPet.FloatingChat.anchor.x"
        static let floatingAnchorY = "DeskPet.FloatingChat.anchor.y"
    }

    let backend: Backend
    @Published var sectionRaw: String { didSet { persist() } }
    @Published var windowModeRaw: String { didSet { persist() } }
    @Published var floatingAnchor: CGPoint? { didSet { persist() } }

    init(backend: Backend = .userDefaults(.standard)) {
        self.backend = backend
        let snapshot = Self.loadSnapshot(from: backend)
        self.sectionRaw = snapshot.sectionRaw
        self.windowModeRaw = snapshot.windowModeRaw
        if let x = snapshot.floatingAnchorX, let y = snapshot.floatingAnchorY {
            self.floatingAnchor = CGPoint(x: x, y: y)
        } else {
            self.floatingAnchor = nil
        }
    }

    func setSection(_ section: AppSection) {
        sectionRaw = section.rawValue
    }

    func setWindowMode(_ mode: WindowMode) {
        windowModeRaw = mode.rawValue
    }

    private var snapshot: Snapshot {
        Snapshot(sectionRaw: sectionRaw,
                 windowModeRaw: windowModeRaw,
                 floatingAnchorX: floatingAnchor.map { Double($0.x) },
                 floatingAnchorY: floatingAnchor.map { Double($0.y) })
    }

    private static func loadSnapshot(from backend: Backend) -> Snapshot {
        switch backend {
        case .userDefaults(let defaults):
            let hasAnchor = defaults.bool(forKey: Keys.hasFloatingAnchor)
            return Snapshot(sectionRaw: defaults.string(forKey: Keys.section) ?? AppSection.chat.rawValue,
                            windowModeRaw: defaults.string(forKey: Keys.windowMode) ?? WindowMode.compact.rawValue,
                            floatingAnchorX: hasAnchor ? defaults.double(forKey: Keys.floatingAnchorX) : nil,
                            floatingAnchorY: hasAnchor ? defaults.double(forKey: Keys.floatingAnchorY) : nil)
        case .file(let url):
            guard let data = try? Data(contentsOf: url),
                  let decoded = try? JSONDecoder().decode(Snapshot.self, from: data) else {
                return Snapshot(sectionRaw: AppSection.chat.rawValue,
                                windowModeRaw: WindowMode.compact.rawValue,
                                floatingAnchorX: nil,
                                floatingAnchorY: nil)
            }
            return decoded
        }
    }

    private func persist() {
        switch backend {
        case .userDefaults(let defaults):
            defaults.set(sectionRaw, forKey: Keys.section)
            defaults.set(windowModeRaw, forKey: Keys.windowMode)
            if let floatingAnchor {
                defaults.set(true, forKey: Keys.hasFloatingAnchor)
                defaults.set(Double(floatingAnchor.x), forKey: Keys.floatingAnchorX)
                defaults.set(Double(floatingAnchor.y), forKey: Keys.floatingAnchorY)
            } else {
                defaults.removeObject(forKey: Keys.hasFloatingAnchor)
                defaults.removeObject(forKey: Keys.floatingAnchorX)
                defaults.removeObject(forKey: Keys.floatingAnchorY)
            }
        case .file(let url):
            do {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                        withIntermediateDirectories: true)
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                let data = try encoder.encode(snapshot)
                try data.write(to: url, options: .atomic)
            } catch {
                // UI state is recoverable; avoid surfacing path details in product UI.
            }
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
