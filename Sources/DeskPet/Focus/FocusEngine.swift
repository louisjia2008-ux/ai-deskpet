import Foundation
import Combine

/// Drives FocusMachine with a 1s timer and publishes state to SwiftUI. Also notifies the
/// desktop pet when focus is active so it switches to light-companion mode (doc §9.5).
@MainActor
final class FocusEngine: ObservableObject {

    @Published private(set) var phase: FocusPhase = .idle
    @Published private(set) var remaining: Int = 0
    @Published private(set) var elapsed: Int = 0
    @Published private(set) var completedRounds: Int = 0
    @Published private(set) var totalRounds: Int = 0
    @Published private(set) var isRunning = false
    @Published private(set) var isOvertime = false
    @Published var linkedTaskID: UUID?
    @Published var pendingContinuePrompt = false

    /// Called when focus becomes active/inactive — wired to the pet's behavior.
    var onActiveChange: (Bool) -> Void = { _ in }
    /// Called when a session finishes naturally, with the per-round work minutes (doc §12.1 习惯建议).
    var onFinished: (Int) -> Void = { _ in }

    private var machine: FocusMachine?
    private var timer: Timer?
    private var workMinutes = 0

    var isActive: Bool { isRunning && (phase == .work || phase == .shortBreak || phase == .longBreak) }

    func start(mode: FocusMode, taskID: UUID? = nil) {
        var m = FocusMachine(mode: mode)
        _ = m.start()
        machine = m
        switch mode {
        case .pomodoro(let w, _, _, _), .custom(let w, _, _, _): workMinutes = w
        case .taskDriven(let t): workMinutes = t
        }
        linkedTaskID = taskID
        totalRounds = m.totalRounds
        syncPublished()
        isRunning = true
        startTimer()
        onActiveChange(true)
    }

    func pause() {
        isRunning = false
        timer?.invalidate(); timer = nil
        onActiveChange(false)
    }

    func resume() {
        guard machine != nil, phase != .finished, phase != .idle else { return }
        isRunning = true
        startTimer()
        onActiveChange(true)
    }

    func skip() {
        guard var m = machine else { return }
        handle(m.skip()); machine = m; syncPublished()
    }

    func stop() {
        guard var m = machine else { return }
        _ = m.stop(); machine = m
        syncPublished()
        isRunning = false
        timer?.invalidate(); timer = nil
        onActiveChange(false)
    }

    /// Task-driven: keep going past the target after the prompt (doc §9.4).
    func continueFocus(extraMinutes: Int = 0) {
        guard var m = machine else { return }
        m.continueAfterTarget(extraMinutes: extraMinutes)
        pendingContinuePrompt = false
        machine = m; syncPublished()
    }

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    private func tick() {
        guard var m = machine else { return }
        handle(m.tick(seconds: 1))
        machine = m
        syncPublished()
    }

    private func handle(_ events: [FocusEvent]) {
        for e in events {
            switch e {
            case .askContinue: pendingContinuePrompt = true
            case .finished:
                isRunning = false
                timer?.invalidate(); timer = nil
                onActiveChange(false)
                onFinished(workMinutes)
            case .phaseChanged, .roundCompleted:
                break
            }
        }
    }

    private func syncPublished() {
        guard let m = machine else { return }
        phase = m.phase
        remaining = m.remaining
        elapsed = m.elapsed
        completedRounds = m.completedRounds
        totalRounds = m.totalRounds
        isOvertime = m.isOvertime
    }

    /// mm:ss for the active counter (counts down, or up while overtime).
    var clockText: String {
        let secs = isOvertime ? -remaining : remaining
        return String(format: "%02d:%02d", max(0, secs) / 60, max(0, secs) % 60)
    }
}
