import Foundation

/// Data classification for sync (doc §15.1 分类型同步). Anything not represented here (private
/// chats, screenshots, OCR text, voice cache) is never persisted, hence never synced.
public enum SyncCategory: String, CaseIterable, Codable, Sendable {
    case settings, tasks, focusStats, relationship   // default: iCloud auto-sync
    case chat, memory                                 // default: local-only, opt-in

    /// Whether this category syncs by default (doc §15.1).
    public var syncsByDefault: Bool {
        switch self {
        case .settings, .tasks, .focusStats, .relationship: return true
        case .chat, .memory: return false
        }
    }
    public var label: String {
        switch self {
        case .settings: return "设置"
        case .tasks: return "任务"
        case .focusStats: return "专注统计"
        case .relationship: return "关系与解锁"
        case .chat: return "聊天正文"
        case .memory: return "长期记忆正文"
        }
    }
}

/// The user's effective sync allowance.
public struct SyncPolicy: Codable, Equatable, Sendable {
    public var enabled: Set<SyncCategory>
    public var iCloudEnabled: Bool

    /// Defaults reflect doc §15.1 (settings/tasks/focus/relationship on; chat/memory off).
    public init(enabled: Set<SyncCategory>? = nil, iCloudEnabled: Bool = true) {
        self.enabled = enabled ?? Set(SyncCategory.allCases.filter(\.syncsByDefault))
        self.iCloudEnabled = iCloudEnabled
    }
    public func maySync(_ c: SyncCategory) -> Bool { iCloudEnabled && enabled.contains(c) }
}

/// Conflict resolution (doc §15.1 以事件累计或合法最高状态合并，避免同步倒退).
public enum MergeRules {
    /// Affinity never regresses on merge.
    public static func mergeAffinity(_ a: RelationshipState, _ b: RelationshipState) -> RelationshipState {
        RelationshipState(score: max(a.score, b.score))
    }
    /// Unlocks/accessories are the union of both sides (never lose an unlock).
    public static func mergeAccessories(_ a: Set<Accessory>, _ b: Set<Accessory>) -> Set<Accessory> {
        a.union(b)
    }
    /// Generic "newest wins" for timestamped records.
    public static func newest<T>(_ a: (T, Date), _ b: (T, Date)) -> T {
        a.1 >= b.1 ? a.0 : b.0
    }
}

/// Schema migration gate (doc §15.2 迁移检查；更新失败时保留可回滚路径).
public enum SchemaVersion {
    public static let current = 1
}

public enum MigrationCheck {
    public enum Outcome: Equatable, Sendable {
        case ok                       // same version
        case migrate(from: Int)       // older backup → migrate forward
        case incompatibleNewer(Int)   // backup from a newer app → refuse, keep rollback path
    }
    public static func evaluate(backupVersion: Int, current: Int = SchemaVersion.current) -> Outcome {
        if backupVersion == current { return .ok }
        if backupVersion < current { return .migrate(from: backupVersion) }
        return .incompatibleNewer(backupVersion)
    }
}
