import Foundation

/// Focus modes (doc §9.4). Minutes are stored; the engine converts to seconds.
enum FocusMode: Equatable, Sendable {
    case pomodoro(work: Int, brk: Int, rounds: Int, longBreak: Int)  // 固定番茄
    case custom(work: Int, brk: Int, rounds: Int, longBreak: Int)    // 自定义
    case taskDriven(targetWork: Int)                                  // 任务驱动：计时只记录

    static let pom25 = FocusMode.pomodoro(work: 25, brk: 5, rounds: 4, longBreak: 15)
    static let pom45 = FocusMode.pomodoro(work: 45, brk: 10, rounds: 3, longBreak: 20)

    var label: String {
        switch self {
        case .pomodoro(let w, let b, _, _): return "番茄 \(w)/\(b)"
        case .custom: return "自定义"
        case .taskDriven: return "任务驱动"
        }
    }
}

enum FocusPhase: Equatable, Sendable {
    case idle, work, shortBreak, longBreak, finished
    var label: String {
        switch self {
        case .idle: return "未开始"
        case .work: return "专注"
        case .shortBreak: return "休息"
        case .longBreak: return "长休息"
        case .finished: return "已完成"
        }
    }
}

/// Events the engine reacts to (sound cue, pet pose change, asking the user, …).
enum FocusEvent: Equatable, Sendable {
    case phaseChanged(FocusPhase)
    case roundCompleted(Int)
    case askContinue        // task-driven target reached — ASK, never force-stop (doc §9.4)
    case finished
}

/// Pure, deterministic focus phase state machine. No timers, no UI — `tick` is driven by the
/// engine. This is the unit-tested core of the focus system.
struct FocusMachine: Equatable, Sendable {

    private(set) var mode: FocusMode
    private(set) var phase: FocusPhase = .idle
    private(set) var remaining: Int = 0       // seconds left in phase (counts down)
    private(set) var elapsed: Int = 0         // seconds elapsed in phase (counts up)
    private(set) var completedRounds: Int = 0
    private var askedContinue = false

    init(mode: FocusMode) { self.mode = mode }

    var totalRounds: Int {
        switch mode {
        case .pomodoro(_, _, let r, _), .custom(_, _, let r, _): return r
        case .taskDriven: return 0
        }
    }
    var isOvertime: Bool { remaining < 0 }

    mutating func start() -> [FocusEvent] {
        phase = .work
        elapsed = 0
        remaining = workSeconds()
        askedContinue = false
        return [.phaseChanged(.work)]
    }

    /// Advance by `seconds`. Returns events that occurred.
    mutating func tick(seconds: Int = 1) -> [FocusEvent] {
        guard phase == .work || phase == .shortBreak || phase == .longBreak else { return [] }
        elapsed += seconds
        remaining -= seconds

        switch mode {
        case .taskDriven:
            // Never auto-advance: at target, ask once, then keep counting (overtime).
            if remaining <= 0 && !askedContinue {
                askedContinue = true
                return [.askContinue]
            }
            return []
        case .pomodoro, .custom:
            guard remaining <= 0 else { return [] }
            return advancePhase()
        }
    }

    /// User-initiated skip to the next phase.
    mutating func skip() -> [FocusEvent] { advancePhase() }

    /// Task-driven: user chose to keep going after the prompt.
    mutating func continueAfterTarget(extraMinutes: Int = 0) {
        if extraMinutes > 0 { remaining += extraMinutes * 60 }
        askedContinue = false
    }

    mutating func stop() -> [FocusEvent] {
        phase = .finished
        return [.finished]
    }

    // MARK: Internals

    private mutating func advancePhase() -> [FocusEvent] {
        var events: [FocusEvent] = []
        switch phase {
        case .work:
            completedRounds += 1
            events.append(.roundCompleted(completedRounds))
            if completedRounds >= totalRounds {
                phase = .longBreak; remaining = longBreakSeconds(); elapsed = 0
                events.append(.phaseChanged(.longBreak))
            } else {
                phase = .shortBreak; remaining = breakSeconds(); elapsed = 0
                events.append(.phaseChanged(.shortBreak))
            }
        case .shortBreak:
            phase = .work; remaining = workSeconds(); elapsed = 0
            events.append(.phaseChanged(.work))
        case .longBreak:
            phase = .finished; remaining = 0; elapsed = 0
            events.append(.phaseChanged(.finished)); events.append(.finished)
        default:
            break
        }
        return events
    }

    private func workSeconds() -> Int {
        switch mode {
        case .pomodoro(let w, _, _, _), .custom(let w, _, _, _): return w * 60
        case .taskDriven(let t): return t * 60
        }
    }
    private func breakSeconds() -> Int {
        switch mode {
        case .pomodoro(_, let b, _, _), .custom(_, let b, _, _): return b * 60
        case .taskDriven: return 0
        }
    }
    private func longBreakSeconds() -> Int {
        switch mode {
        case .pomodoro(_, _, _, let lb), .custom(_, _, _, let lb): return lb * 60
        case .taskDriven: return 0
        }
    }
}
