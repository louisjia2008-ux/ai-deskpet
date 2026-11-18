import Foundation

/// Per-function, session-scoped cloud authorization (doc §11.3). Granting persists only for the
/// current continuous session (held in memory; reset on relaunch). Screenshots/files are NOT
/// covered here — they require a separate per-use confirmation every time (doc §11.3).
public struct CloudAuthorization: Sendable, Equatable {

    public enum Function: String, CaseIterable, Sendable {
        case chat       // continuous cloud chat
        case document   // long-document reasoning
        // NOTE: vision/screenshot intentionally absent — always per-use confirmed, never cached.
        public var label: String {
            switch self {
            case .chat: return "云端对话"
            case .document: return "长文档推理"
            }
        }
    }

    private var granted: Set<Function> = []
    public init() {}

    public func isAuthorized(_ f: Function) -> Bool { granted.contains(f) }
    public var anyGranted: Bool { !granted.isEmpty }

    public mutating func grant(_ f: Function) { granted.insert(f) }
    public mutating func revoke(_ f: Function) { granted.remove(f) }
    public mutating func reset() { granted.removeAll() }
}
