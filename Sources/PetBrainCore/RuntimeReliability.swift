import Foundation

// Native agent-runtime reliability infrastructure (vendor-neutral). These mechanisms belong to our
// own runtime; no type here carries any external-runtime vendor semantics.

/// Exponential backoff with a hard cap and a give-up limit.
public struct BackoffPolicy: Sendable {
    public var base: TimeInterval
    public var multiplier: Double
    public var cap: TimeInterval
    public var maxAttempts: Int
    public init(base: TimeInterval = 0.5, multiplier: Double = 2, cap: TimeInterval = 30, maxAttempts: Int = 6) {
        self.base = base; self.multiplier = multiplier; self.cap = cap; self.maxAttempts = maxAttempts
    }
    public func delay(attempt: Int) -> TimeInterval? {
        guard attempt < maxAttempts else { return nil }
        return min(cap, base * pow(multiplier, Double(attempt)))
    }
}

/// Drops already-seen events by sequence number. nil seq (unsequenced) always passes.
public struct EventDeduplicator: Sendable {
    private var seen: Set<Int> = []
    public init() {}
    public mutating func accept(seq: Int?) -> Bool {
        guard let seq else { return true }
        return seen.insert(seq).inserted
    }
}

/// Rejects out-of-order / stale events (monotonic seq expected).
public struct EventSequencer: Sendable {
    private var maxSeen: Int = -1
    public init() {}
    public mutating func inOrder(seq: Int?) -> Bool {
        guard let seq else { return true }
        defer { maxSeen = max(maxSeen, seq) }
        return seq > maxSeen
    }
}

/// Bounded runtime event queue → backpressure (drop-oldest) so a streaming flood can't unbound
/// memory or swamp the UI. Generic over the event payload.
public struct RuntimeEventQueue<Element: Sendable>: Sendable {
    public let capacity: Int
    public private(set) var items: [Element] = []
    public private(set) var dropped = 0
    public init(capacity: Int) { self.capacity = capacity }
    public mutating func enqueue(_ e: Element) {
        if items.count >= capacity { items.removeFirst(); dropped += 1 }
        items.append(e)
    }
    public mutating func drain() -> [Element] { defer { items.removeAll() }; return items }
}

/// Deterministic terminal-state race handling: once a task is terminal, later terminal events
/// cannot change it — the first terminal wins.
public enum TerminalStateResolver {
    public static func resolve(current: AgentTaskState, incoming: AgentTaskState) -> AgentTaskState {
        current.isTerminal ? current : incoming
    }
}

/// Pure task-state reduction: apply one AgentTaskEvent to a state, returning the next state (or the
/// same state if the transition is invalid). The coordinator embeds equivalent logic plus the
/// ledger; this standalone reducer makes the transition law independently testable.
public enum TaskStateReducer {
    public static func reduce(_ state: AgentTaskState, _ event: AgentTaskEvent) -> AgentTaskState {
        guard case .stateChanged(let to) = event else { return state }
        guard !state.isTerminal else { return state }                 // terminal is sticky
        return AgentTaskMachine.canTransition(from: state, to: to) ? to : state
    }
}
