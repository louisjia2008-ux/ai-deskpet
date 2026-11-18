import Foundation

enum FloatingChatVisibilityState: Equatable, Codable, Sendable {
    case hidden
    case capsuleIdle
    case capsuleActive
    case expanded
    case taskHUD

    var isVisible: Bool {
        self != .hidden
    }

    var isCapsule: Bool {
        self == .capsuleIdle || self == .capsuleActive
    }
}
