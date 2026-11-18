import Foundation

/// Holds presentations awaiting delivery. A new user input cancels any pending LOW-priority output
/// (e.g. an idle proactive bubble) so the pet doesn't talk over a fresh request (doc §14.7).
public struct PresentationQueue: Sendable {
    public private(set) var pending: [CharacterPresentation] = []
    public init() {}

    public mutating func enqueue(_ p: CharacterPresentation) { pending.append(p) }

    /// On new user input, drop low-priority pending presentations (interrupt, §14.7).
    public mutating func interruptForUserInput() {
        pending.removeAll { $0.priority == .low }
    }

    public mutating func dequeue() -> CharacterPresentation? {
        pending.isEmpty ? nil : pending.removeFirst()
    }
}
