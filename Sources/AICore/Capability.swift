import Foundation

/// Capability taxonomy + grant model (doc 03 §2–§5). Fine-grained only — broad `file_access`
/// style identifiers are forbidden. Pure value types; the stateful broker lives in CapabilityBroker.swift.

public enum RiskLevel: Int, Sendable, Codable, Comparable, CaseIterable {
    case p0, p1, p2, p3, p4
    public static func < (l: Self, r: Self) -> Bool { l.rawValue < r.rawValue }
    public var label: String { "P\(rawValue)" }
}

public enum DataDirection: String, Sendable, Codable, Equatable {
    case none, read, write, upload, delete
}

public struct Capability: Sendable, Codable, Equatable, Hashable {
    public let id: String            // e.g. "filesystem.workspace.read"
    public let risk: RiskLevel
    public let direction: DataDirection
    public init(id: String, risk: RiskLevel, direction: DataDirection) {
        self.id = id; self.risk = risk; self.direction = direction
    }
}

/// The known capabilities (doc 03 §2). Anything not registered here is rejected by the broker.
public enum CapabilityCatalog {
    public static let all: [Capability] = [
        // P0
        Capability(id: "character.animation", risk: .p0, direction: .none),
        Capability(id: "timer.local", risk: .p0, direction: .none),
        Capability(id: "state.read", risk: .p0, direction: .none),
        Capability(id: "get_current_datetime", risk: .p0, direction: .none),
        Capability(id: "get_system_profile", risk: .p0, direction: .none),
        Capability(id: "get_frontmost_application", risk: .p0, direction: .none),
        // P1 — limited read
        Capability(id: "filesystem.userSelected.read", risk: .p1, direction: .read),
        Capability(id: "filesystem.workspace.read", risk: .p1, direction: .read),
        Capability(id: "screen.frontmostWindow.captureOnce", risk: .p1, direction: .read),
        Capability(id: "screen.environment.read", risk: .p1, direction: .read),
        Capability(id: "calendar.events.read", risk: .p1, direction: .read),
        Capability(id: "reminders.read", risk: .p1, direction: .read),
        Capability(id: "location.approximate.read", risk: .p1, direction: .read),
        // P2 — reversible writes
        Capability(id: "reminder.local.create", risk: .p2, direction: .write),
        Capability(id: "reminders.create", risk: .p2, direction: .write),
        Capability(id: "calendar.event.create", risk: .p2, direction: .write),
        Capability(id: "calendar.event.modify", risk: .p2, direction: .write),
        Capability(id: "filesystem.workspace.write", risk: .p2, direction: .write),
        Capability(id: "application.launch", risk: .p2, direction: .write),
        Capability(id: "schedule.create", risk: .p2, direction: .write),
        // P3 — external effect
        Capability(id: "network.search", risk: .p3, direction: .read),
        Capability(id: "network.fetch", risk: .p3, direction: .read),
        Capability(id: "places.search.read", risk: .p3, direction: .read),
        Capability(id: "places.details.read", risk: .p3, direction: .read),
        Capability(id: "routes.estimate.read", risk: .p3, direction: .read),
        Capability(id: "web.page.read", risk: .p3, direction: .read),
        Capability(id: "web.structured_data.read", risk: .p3, direction: .read),
        Capability(id: "place.openInMaps", risk: .p3, direction: .write),
        Capability(id: "place.openDirections", risk: .p3, direction: .write),
        Capability(id: "place.openOfficialWebsite", risk: .p3, direction: .write),
        Capability(id: "place.startPhoneHandoff", risk: .p3, direction: .write),
        Capability(id: "network.upload", risk: .p3, direction: .upload),
        Capability(id: "shell.build", risk: .p3, direction: .write),
        Capability(id: "shell.test", risk: .p3, direction: .write),
        Capability(id: "git.commit", risk: .p3, direction: .write),
        Capability(id: "mail.send", risk: .p3, direction: .upload),
        Capability(id: "browser.control", risk: .p3, direction: .write),
        // P4 — high risk (mostly disabled in v1)
        Capability(id: "filesystem.moveToTrash", risk: .p4, direction: .delete),
        Capability(id: "shell.arbitrary", risk: .p4, direction: .write),
        Capability(id: "shell.packageInstall", risk: .p4, direction: .write),
        Capability(id: "git.push", risk: .p4, direction: .upload),
        Capability(id: "accessibility.global", risk: .p4, direction: .write),
        Capability(id: "screen.continuous", risk: .p4, direction: .read),
        Capability(id: "keychain.generalRead", risk: .p4, direction: .read),
        Capability(id: "contacts.read", risk: .p4, direction: .read),
    ]
    private static let index: [String: Capability] = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })
    public static func lookup(_ id: String) -> Capability? { index[id] }

    /// Known protocol identifiers that are intentionally not advertised by the current native
    /// production assembly. They remain in `all` so old ledgers and policy records decode without
    /// data loss. An explicitly registered, schema-validated AgentTool may still surface its own
    /// manifest through `ToolCatalogSnapshot`.
    public static let unavailableByDefault: Set<String> = [
        "network.fetch",
        "network.search",
        "web.page.read",
    ]
}

/// Distribution SKU ceiling (D5). App Store hard-caps at P2; Developer ID can reach P4.
public enum DistributionTier: String, Sendable, Codable {
    case appStore, developerID
    public var ceiling: RiskLevel { self == .appStore ? .p2 : .p4 }
    /// Capabilities permanently ungrantable in this SKU regardless of user consent.
    public func isPermanentlyDenied(_ cap: Capability) -> Bool { cap.risk > ceiling }

    /// The SKU for THIS binary, fixed at compile time (D5). There is deliberately
    /// no runtime override — no UserDefaults key, no CLI flag, no environment
    /// variable may change it (a MAS binary with a runtime switch would violate
    /// the "no hidden capability switch" rule, doc 01 §4).
    ///
    /// - Developer builds (SwiftPM, Xcode Debug/Release): `.developerID`.
    /// - App Store builds: define `APPSTORE` (see project.yml "AppStore lane"
    ///   notes) and this becomes `.appStore` everywhere — broker, gate,
    ///   policy, and security kernel follow without further edits.
    public static var current: DistributionTier {
        #if APPSTORE
        return .appStore
        #else
        return .developerID
        #endif
    }
}

public struct CapabilityScope: Sendable, Codable, Equatable {
    public var paths: [String]
    public var windows: [String]
    public var apps: [String]
    public var domains: [String]
    public var maxItems: Int?
    public var maxBytes: Int?
    public var allowUpload: Bool
    public var allowDelete: Bool
    public var allowFurtherRequests: Bool

    public init(paths: [String] = [], windows: [String] = [], apps: [String] = [], domains: [String] = [],
                maxItems: Int? = nil, maxBytes: Int? = nil, allowUpload: Bool = false,
                allowDelete: Bool = false, allowFurtherRequests: Bool = false) {
        self.paths = paths; self.windows = windows; self.apps = apps; self.domains = domains
        self.maxItems = maxItems; self.maxBytes = maxBytes; self.allowUpload = allowUpload
        self.allowDelete = allowDelete; self.allowFurtherRequests = allowFurtherRequests
    }
    public static let empty = CapabilityScope()
}

public enum GrantDuration: Sendable, Codable, Equatable {
    case onceImmediate
    case task
    case timeboxed(seconds: Int)
    case session
    func expiry(from now: Date) -> Date {
        switch self {
        case .onceImmediate: return now.addingTimeInterval(30)
        case .timeboxed(let s): return now.addingTimeInterval(TimeInterval(s))
        case .task, .session: return now.addingTimeInterval(3600)
        }
    }
}

public struct GrantRequest: Sendable, Equatable {
    public var capabilityID: String
    public var scope: CapabilityScope
    public var reason: String
    public var taskID: UUID?
    public var duration: GrantDuration
    public init(capabilityID: String, scope: CapabilityScope = .empty, reason: String,
                taskID: UUID? = nil, duration: GrantDuration = .onceImmediate) {
        self.capabilityID = capabilityID; self.scope = scope; self.reason = reason
        self.taskID = taskID; self.duration = duration
    }
}

public struct CapabilityToken: Sendable, Codable, Equatable, Hashable {
    public let raw: String
    public let taskID: UUID?
    public let expiresAt: Date
    /// Capability this token was minted for. Nil = legacy token (pre-binding);
    /// new tokens always set it and executors must enforce equality.
    public let capabilityID: String?
    public init(raw: String, taskID: UUID?, expiresAt: Date, capabilityID: String? = nil) {
        self.raw = raw; self.taskID = taskID; self.expiresAt = expiresAt; self.capabilityID = capabilityID
    }
}

/// IPC wire-protocol constants shared by app ↔ helpers. Bump `version` only with
/// backward-compatible decoders (all messages carry the field with a default).
public enum IPCProtocol {
    public static let version = 1
    /// Max single newline-delimited JSON line (4 MiB). Larger lines are dropped
    /// to bound memory when a helper emits garbage/infinite output.
    public static let maxLineBytes = 4 * 1024 * 1024
}

public struct CapabilityGrant: Sendable, Codable, Equatable {
    public var capability: Capability
    public var scope: CapabilityScope
    public var duration: GrantDuration
    public var token: CapabilityToken
    public var taskID: UUID?
    public var grantedAt: Date
}
