import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P14-J — Property / stress tests.
//
// Generates deterministic seeded random sequences of state transitions and
// verifies that all P14 invariants hold after every step.

@MainActor
final class P14_JPropertyStressTests: XCTestCase {

    /// Seeded PRNG (splitmix64) for reproducible stress runs.
    struct SplitMix64: RandomNumberGenerator {
        var state: UInt64
        init(seed: UInt64) { self.state = seed }
        mutating func next() -> UInt64 {
            state &+= 0x9E3779B97F4A7C15
            var z = state
            z = (z ^ (z &>> 30)) &* 0xBF58476D1CE4E5B9
            z = (z ^ (z &>> 27)) &* 0x94D049BB133111EB
            return z ^ (z &>> 31)
        }
    }

    /// All non-terminal states from which transitions are exercised.
    static let transitions: [(from: DurableTaskState, to: DurableTaskState, weight: Int)] = [
        (.queued, .running, 5),
        (.queued, .cancelled, 1),
        (.running, .waitingForTool, 3),
        (.running, .waitingForApproval, 2),
        (.running, .waitingForUserInput, 2),
        (.running, .waitingForRetry, 2),
        (.running, .paused, 1),
        (.running, .interrupted, 2),
        (.running, .completed, 4),
        (.running, .failed, 2),
        (.running, .cancelled, 2),
        (.waitingForTool, .running, 4),
        (.waitingForTool, .failed, 1),
        (.waitingForTool, .cancelled, 1),
        (.waitingForTool, .interrupted, 1),
        (.waitingForApproval, .running, 3),
        (.waitingForApproval, .failed, 1),
        (.waitingForApproval, .cancelled, 1),
        (.waitingForApproval, .interrupted, 1),
        (.waitingForUserInput, .running, 3),
        (.waitingForUserInput, .failed, 1),
        (.waitingForUserInput, .cancelled, 1),
        (.waitingForUserInput, .interrupted, 1),
        (.waitingForRetry, .queued, 2),
        (.waitingForRetry, .running, 3),
        (.waitingForRetry, .failed, 1),
        (.waitingForRetry, .cancelled, 1),
        (.waitingForRetry, .interrupted, 1),
        (.paused, .running, 3),
        (.paused, .cancelled, 1),
        (.paused, .interrupted, 1),
        (.interrupted, .running, 3),
        (.interrupted, .failed, 1),
        (.interrupted, .cancelled, 1),
        (.interrupted, .queued, 1),
    ]

    /// Pick a transition given the current state. Returns nil when no
    /// outbound transition exists (terminal state).
    static func pickTransition(from state: DurableTaskState,
                                rng: inout SplitMix64) -> DurableTaskState? {
        let candidates = transitions.filter { $0.from == state }
        if candidates.isEmpty { return nil }
        let totalWeight = candidates.reduce(0) { $0 + $1.weight }
        let pick = Int(rng.next() % UInt64(max(totalWeight, 1)))
        var running = 0
        for c in candidates {
            running += c.weight
            if pick < running { return c.to }
        }
        return candidates.last?.to ?? state
    }

    func testJ01_deterministicTransitionSequencesHoldInvariants() async throws {
        let seeds: [UInt64] = [1, 42, 1337, 0xDEADBEEF, 0xC0FFEE]
        let sequenceLength = 200
        var totalRuns = 0
        var invariantViolations = 0
        for seed in seeds {
            var rng = SplitMix64(seed: seed)
            let dir = p14_makeTempDir("j01-\(seed)")
            let store = DurableTaskStore(baseDirectory: dir)
            await store.load()
            let taskID = UUID()
            _ = await store.upsert(DurableTaskRecord(taskID: taskID, title: "stress"))
            var current = DurableTaskState.queued
            for _ in 0..<sequenceLength {
                guard let next = Self.pickTransition(from: current, rng: &rng) else {
                    // Terminal state — no outbound transitions. Reset.
                    _ = await store.upsert(DurableTaskRecord(taskID: taskID,
                                                              title: "stress-reset"))
                    current = .queued
                    continue
                }
                let result = await store.applyTransition(taskID: taskID, to: next)
                if result == nil {
                    // Illegal transition — must NOT corrupt state.
                    let after = await store.task(id: taskID)
                    XCTAssertEqual(after?.status, current,
                                   "Illegal transition must not change status (seed \(seed))")
                } else {
                    current = next
                }
                // Invariant: once terminal, status.isTerminal must stay true.
                if current.isTerminal {
                    let after = await store.task(id: taskID)
                    XCTAssertTrue(after?.status.isTerminal ?? false,
                                  "Terminal state must remain terminal (seed \(seed))")
                }
                totalRuns += 1
            }
        }
        XCTAssertEqual(invariantViolations, 0,
                       "\(invariantViolations) invariant violations across \(totalRuns) transitions")
    }

    func testJ02_concurrentTransitionsRespectTerminalExactlyOnce() async throws {
        let trials = 100
        var violations = 0
        for trial in 0..<trials {
            let dir = p14_makeTempDir("j02-\(trial)")
            let store = DurableTaskStore(baseDirectory: dir)
            await store.load()
            let taskID = UUID()
            _ = await store.upsert(DurableTaskRecord(taskID: taskID, title: "concurrent"))
            _ = await store.applyTransition(taskID: taskID, to: .running)
            // Fire 20 concurrent attempts to terminalize.
            let results = await withTaskGroup(of: DurableTaskRecord?.self,
                                              returning: [DurableTaskRecord?].self) { group in
                for _ in 0..<20 {
                    group.addTask {
                        await store.applyTransition(taskID: taskID, to: .completed)
                    }
                }
                var collected: [DurableTaskRecord?] = []
                for await r in group { collected.append(r) }
                return collected
            }
            let successes = results.compactMap { $0 }
            if successes.count != 1 { violations += 1 }
        }
        XCTAssertEqual(violations, 0,
                       "Expected exactly 1 successful terminalization per trial across \(trials) trials")
    }

    func testJ03_inboxConcurrentAppendsAreLossless() async throws {
        // Multiple concurrent appends to the durable inbox must all land.
        let url = p14_makeTempDir("j03").appendingPathComponent("inbox.jsonl")
        let store = DurableInboxStore(baseDirectory: url)
        await store.load()
        let taskID = UUID()
        let count = 50
        let results = await withTaskGroup(of: Bool.self,
                                          returning: [Bool].self) { group in
            for i in 0..<count {
                group.addTask {
                    let event = InboxEvent(taskID: taskID,
                                            kind: .taskSignal,
                                            payload: .number(Double(i)))
                    return await store.appendIfNew(event)
                }
            }
            var collected: [Bool] = []
            for await r in group { collected.append(r) }
            return collected
        }
        let appended = results.filter { $0 }.count
        XCTAssertEqual(appended, count, "Every concurrent append must succeed")
        let pending = await store.unconsumedEvents(forTask: taskID)
        XCTAssertEqual(pending.count, count)
    }
}
