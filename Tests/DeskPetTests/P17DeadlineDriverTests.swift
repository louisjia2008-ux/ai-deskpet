import XCTest
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P17-C — dead-line driven live retry driver + scheduler nextDeadline API.
//
// Verifies:
//   - `RuntimeRetryScheduler.nextDeadline()` returns the earliest queued
//     deadline, ignoring past due entries.
//   - `RuntimeRetryScheduler.nextDeadline()` is nil when queue is empty.
//   - `cancelWakeup` drops the corresponding deadline.
//   - The legacy `.polling` driver mode continues to work (back-compat).
//   - The new `.deadline(ceilingSeconds:)` mode is wired without breaking
//     `RuntimeLifecycleController.start()` / `stop()`.

final class P17DeadlineDriverTests: XCTestCase {

    // MARK: - nextDeadline() semantics

    func testNextDeadline_returnsEarliestFutureDeadline() async throws {
        let now = Date()
        let scheduler = RuntimeRetryScheduler(
            clock: { now },
            onWakeup: { _, _ in })
        await scheduler.registerWakeup(taskID: UUID(), deadline: now.addingTimeInterval(60))
        await scheduler.registerWakeup(taskID: UUID(), deadline: now.addingTimeInterval(5))
        await scheduler.registerWakeup(taskID: UUID(), deadline: now.addingTimeInterval(30))
        let next = await scheduler.nextDeadline()
        XCTAssertNotNil(next)
        let delta = next!.timeIntervalSince(now)
        XCTAssertEqual(delta, 5, accuracy: 0.01,
                       "nextDeadline must return the earliest future deadline")
    }

    func testNextDeadline_ignoresPastDueEntries() async throws {
        let now = Date()
        let scheduler = RuntimeRetryScheduler(
            clock: { now },
            onWakeup: { _, _ in })
        await scheduler.registerWakeup(taskID: UUID(), deadline: now.addingTimeInterval(-30))
        let next = await scheduler.nextDeadline()
        XCTAssertNil(next, "A scheduler with only past-due wakeups has no future deadline")
    }

    func testNextDeadline_isNilWhenQueueEmpty() async throws {
        let scheduler = RuntimeRetryScheduler(
            clock: { Date() },
            onWakeup: { _, _ in })
        let next = await scheduler.nextDeadline()
        XCTAssertNil(next)
    }

    func testCancelRemovesDeadline() async throws {
        let now = Date()
        let scheduler = RuntimeRetryScheduler(
            clock: { now },
            onWakeup: { _, _ in })
        let id = UUID()
        await scheduler.registerWakeup(taskID: id, deadline: now.addingTimeInterval(5))
        let before = await scheduler.nextDeadline()
        XCTAssertNotNil(before)
        await scheduler.cancelWakeup(taskID: id)
        let after = await scheduler.nextDeadline()
        XCTAssertNil(after, "cancel must drop the corresponding deadline")
    }

    // MARK: - Back-compat: legacy .polling mode still works

    func testLegacyPollingMode_stillStarts() async throws {
        // Default (no liveDriverMode arg) is `.polling` — confirm the
        // lifecycle continues to behave as before.
        let controller = RuntimeLifecycleController(coordinator: p5Coordinator())
        await controller.start()
        let state = await controller.currentState()
        XCTAssertEqual(state, .idle)
        await controller.stop()
    }

    func testExplicitPollingMode_stillStarts() async throws {
        let controller = RuntimeLifecycleController(
            coordinator: p5Coordinator(),
            liveDriverMode: .polling)
        await controller.start()
        let state = await controller.currentState()
        XCTAssertEqual(state, .idle)
        await controller.stop()
    }

    // MARK: - New .deadline mode

    func testDeadlineMode_startsAndStopsCleanly() async throws {
        let controller = RuntimeLifecycleController(
            coordinator: p5Coordinator(),
            liveDriverMode: .deadline(ceilingSeconds: 2.0))
        await controller.start()
        let state = await controller.currentState()
        XCTAssertEqual(state, .idle)
        await controller.stop()
        let stopped = await controller.currentState()
        XCTAssertEqual(stopped, .stopped)
    }

    func testDeadlineMode_toleratesLongIdleThenStop() async throws {
        let controller = RuntimeLifecycleController(
            coordinator: p5Coordinator(),
            liveDriverMode: .deadline(ceilingSeconds: 1.0))
        await controller.start()
        // No wakeups for 2.5s — driver should remain alive and re-reconcile.
        try? await Task.sleep(nanoseconds: 2_500_000_000)
        let stateAfterIdle = await controller.currentState()
        XCTAssertEqual(stateAfterIdle, .idle)
        await controller.stop()
    }

    func testDeadlineMode_invokesOnWakeupForDueWakeup() async throws {
        // The onWakeup closure is wired to `coordinator.driveSingleRetry`,
        // which is itself a private primitive. To assert the wiring, we
        // observe that `registerWakeup` followed by `driveDueWork` invokes
        // the closure for wakeups whose deadline has elapsed.
        let firedCollector = FiredCollector()
        let scheduler = RuntimeRetryScheduler(
            clock: { Date() },
            onWakeup: { taskID, _ in await firedCollector.record(taskID) })

        let taskID = UUID()
        // Deadline 100ms in the past — immediately due.
        await scheduler.registerWakeup(
            taskID: taskID,
            deadline: Date().addingTimeInterval(-0.1))

        // Explicit drive — confirms the scheduler dispatches onWakeup.
        _ = await scheduler.driveDueWork()

        let fired = await firedCollector.waitFor(taskID: taskID, timeout: 1.0)
        XCTAssertTrue(fired, "driveDueWork must invoke onWakeup for due wakeup")
    }
}

// MARK: - Test helpers

actor FiredCollector {
    private var fired: Set<UUID> = []

    func record(_ id: UUID) { fired.insert(id) }

    func waitFor(taskID: UUID, timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if fired.contains(taskID) { return true }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return fired.contains(taskID)
    }
}
