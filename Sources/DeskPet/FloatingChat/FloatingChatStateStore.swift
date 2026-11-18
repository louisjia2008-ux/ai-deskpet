import Combine
import Foundation

@MainActor
final class FloatingChatStateStore: ObservableObject {
    static let defaultInactivityTimeout: TimeInterval = 45

    @Published var visibilityState: FloatingChatVisibilityState
    @Published var isResponding: Bool
    @Published var modelBadge: String
    @Published var draft: String
    /// P17 / CX-02 — true while the user's pointer is inside the panel. The inactivity
    /// auto-collapse pauses while this is true so the user can read/edit without the panel
    /// shrinking underneath them.
    @Published var isPointerInside: Bool

    let inactivityTimeout: TimeInterval
    private(set) var lastActivity: Date

    init(visibilityState: FloatingChatVisibilityState = .capsuleIdle,
         isResponding: Bool = false,
         modelBadge: String = "未配置 AI",
         draft: String = "",
         inactivityTimeout: TimeInterval = FloatingChatStateStore.defaultInactivityTimeout,
         now: Date = Date(),
         isPointerInside: Bool = false) {
        self.visibilityState = visibilityState
        self.isResponding = isResponding
        self.modelBadge = modelBadge
        self.draft = draft
        self.inactivityTimeout = inactivityTimeout
        self.lastActivity = now
        self.isPointerInside = isPointerInside
    }

    func showCapsule(now: Date = Date()) {
        visibilityState = .capsuleIdle
        markUserActivity(now: now)
    }

    func activateCapsule(now: Date = Date()) {
        guard visibilityState.isCapsule else { return }
        visibilityState = .capsuleActive
        markUserActivity(now: now)
    }

    func deactivateCapsule(now: Date = Date()) {
        guard visibilityState == .capsuleActive else { return }
        visibilityState = .capsuleIdle
        markUserActivity(now: now)
    }

    func expand(now: Date = Date()) {
        visibilityState = .expanded
        markUserActivity(now: now)
    }

    func collapseToCapsule(now: Date = Date()) {
        visibilityState = .capsuleIdle
        markUserActivity(now: now)
    }

    func hide(now: Date = Date()) {
        visibilityState = .hidden
        markUserActivity(now: now)
    }

    func toggleExpanded(now: Date = Date()) {
        switch visibilityState {
        case .expanded:
            collapseToCapsule(now: now)
        case .hidden, .capsuleIdle, .capsuleActive, .taskHUD:
            expand(now: now)
        }
    }

    func markUserActivity(now: Date = Date()) {
        lastActivity = now
    }

    func setPointerInside(_ inside: Bool, now: Date = Date()) {
        guard isPointerInside != inside else { return }
        isPointerInside = inside
        if inside { markUserActivity(now: now) }
    }

    func shouldCollapseForInactivity(now: Date = Date()) -> Bool {
        guard visibilityState == .expanded, !isResponding else { return false }
        guard draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        // P17 / CX-02 — pointer inside the panel pauses auto-collapse.
        guard !isPointerInside else { return false }
        return now.timeIntervalSince(lastActivity) >= inactivityTimeout
    }

    @discardableResult
    func collapseIfInactive(now: Date = Date()) -> Bool {
        guard shouldCollapseForInactivity(now: now) else { return false }
        collapseToCapsule(now: now)
        return true
    }
}
