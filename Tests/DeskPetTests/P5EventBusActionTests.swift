import XCTest
import Foundation
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

final class P5EventBusTests: XCTestCase {

    func testSubscribeReceivesEvent() async {
        let bus = RuntimeEventBus(clock: TestClock())
        let (id, stream) = await bus.subscribe()
        await bus.publish(.runtimeStarted)
        var received: RuntimeEventEnvelope?
        for await envelope in stream { received = envelope; break }
        XCTAssertEqual(received?.event, .runtimeStarted)
        await bus.unsubscribe(id)
    }

    func testUnsubscribeStopsDelivery() async {
        let bus = RuntimeEventBus(clock: TestClock())
        let (id, stream) = await bus.subscribe()
        await bus.unsubscribe(id)
        await bus.publish(.runtimeStarted)
        var count = 0
        for await _ in stream { count += 1 }
        XCTAssertEqual(count, 0)
    }

    func testCorrelationIDAndInjectedTimestamp() async {
        let when = Date(timeIntervalSinceReferenceDate: 100)
        let bus = RuntimeEventBus(clock: TestClock(start: when))
        let (_, stream) = await bus.subscribe()
        let correlation = UUID()
        await bus.publish(.requestSubmitted(correlation), correlationID: correlation)
        for await envelope in stream {
            XCTAssertEqual(envelope.correlationID, correlation)
            XCTAssertEqual(envelope.timestamp, when)
            break
        }
    }

    func testSubscriberCount() async {
        let bus = RuntimeEventBus(clock: TestClock())
        let (a, streamA) = await bus.subscribe()
        let (b, streamB) = await bus.subscribe()
        let two = await bus.subscriberCount()
        XCTAssertEqual(two, 2)
        await bus.unsubscribe(a)
        let one = await bus.subscriberCount()
        XCTAssertEqual(one, 1)
        await bus.unsubscribe(b)
        // Keep the streams alive until assertions complete (dealloc would auto-unsubscribe).
        withExtendedLifetime((streamA, streamB)) {}
    }
}

final class P5ActionDispatcherTests: XCTestCase {

    private func dispatcher(executor: ActionExecuting = P5RecordingActionExecutor(),
                            gate: PermissionGate = P5AllowPermissionGate()) -> ActionDispatcher {
        ActionDispatcher(executor: executor, gate: gate, audit: InMemoryAuditSink())
    }

    func testPriorityOrder() async {
        let executor = P5RecordingActionExecutor()
        let dispatcher = dispatcher(executor: executor)
        let now = Date()
        await dispatcher.enqueue(p5ActionEnvelope(.updatePresence(true), .ambient, createdAt: now))
        await dispatcher.enqueue(p5ActionEnvelope(.playMotion(.nod), .assistantResponse, createdAt: now))
        _ = await dispatcher.runAll()
        let labels = await executor.labels()
        XCTAssertEqual(labels, ["motion", "presence"])   // higher priority first
    }

    func testUserActionInterruptsAmbient() async {
        let executor = P5RecordingActionExecutor()
        let dispatcher = dispatcher(executor: executor)
        let now = Date()
        await dispatcher.enqueue(p5ActionEnvelope(.playMotion(.idle), .ambient, createdAt: now))
        await dispatcher.enqueue(p5ActionEnvelope(.speak("现在听你的"), .userInitiated, createdAt: now))
        _ = await dispatcher.runAll()
        let labels = await executor.labels()
        XCTAssertEqual(labels, ["speak"])                // ambient was interrupted, never executed
    }

    func testCancelledActionNotReportedCompleted() async {
        let executor = P5RecordingActionExecutor()
        let dispatcher = dispatcher(executor: executor)
        let id = UUID()
        await dispatcher.enqueue(p5ActionEnvelope(.playMotion(.nod), .assistantResponse, id: id))
        await dispatcher.cancel(id)
        let outcomes = await dispatcher.runAll()
        let executed = await executor.count()
        XCTAssertEqual(executed, 0)
        XCTAssertEqual(outcomes, [.cancelled(id: id)])
    }

    func testTimeoutSurfacesDistinctOutcome() async {
        let dispatcher = dispatcher(executor: P5SlowActionExecutor())
        let id = UUID()
        await dispatcher.enqueue(p5ActionEnvelope(.wait(seconds: 5), .assistantResponse, id: id, timeout: 0.05))
        let outcomes = await dispatcher.runAll()
        XCTAssertEqual(outcomes, [.timedOut(id: id)])
    }

    func testUnauthorizedSensitiveActionNotExecuted() async {
        let executor = P5RecordingActionExecutor()
        let dispatcher = dispatcher(executor: executor, gate: P5DenyPermissionGate())
        let id = UUID()
        await dispatcher.enqueue(p5ActionEnvelope(.requestPermission(capabilityID: "screen.continuous", reason: "x"),
                                                  .assistantResponse, id: id))
        let outcomes = await dispatcher.runAll()
        let executed = await executor.count()
        XCTAssertEqual(executed, 0)
        guard case .denied = outcomes.first else { return XCTFail("expected denied outcome") }
    }

    func testSamePresentationKindMerges() async {
        let executor = P5RecordingActionExecutor()
        let dispatcher = dispatcher(executor: executor)
        let now = Date()
        await dispatcher.enqueue(p5ActionEnvelope(.setExpression(.happy), .assistantResponse, createdAt: now))
        await dispatcher.enqueue(p5ActionEnvelope(.setExpression(.curious), .assistantResponse, createdAt: now))
        let pending = await dispatcher.pendingCount()
        XCTAssertEqual(pending, 1)                        // merged, queue did not grow
    }
}
