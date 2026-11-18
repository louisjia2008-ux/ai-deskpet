import XCTest
import Foundation
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

final class P5RuntimeLifecycleTests: XCTestCase {

    func testStartGoesIdle() async {
        let controller = RuntimeLifecycleController(coordinator: p5Coordinator())
        await controller.start()
        let state = await controller.currentState()
        XCTAssertEqual(state, .idle)
    }

    func testRepeatStartDoesNotReinitialize() async {
        let controller = RuntimeLifecycleController(coordinator: p5Coordinator())
        await controller.start()
        await controller.start()
        let count = await controller.startCountForTesting()
        XCTAssertEqual(count, 1)
    }

    func testStopIsIdempotent() async {
        let controller = RuntimeLifecycleController(coordinator: p5Coordinator())
        await controller.start()
        await controller.stop()
        await controller.stop()
        let state = await controller.currentState()
        XCTAssertEqual(state, .stopped)
    }

    func testSubmitRejectedAfterStop() async {
        let controller = RuntimeLifecycleController(coordinator: p5Coordinator())
        await controller.start()
        await controller.stop()
        do {
            _ = try await controller.submit(.userMessage(text: "hi"))
            XCTFail("submit should be rejected after stop")
        } catch RuntimeLifecycleError.notRunning(let state) {
            XCTAssertEqual(state, .stopped)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testSuspendResume() async {
        let controller = RuntimeLifecycleController(coordinator: p5Coordinator())
        await controller.start()
        await controller.suspend()
        let suspended = await controller.currentState()
        XCTAssertEqual(suspended, .suspended)

        do {
            _ = try await controller.submit(.userMessage(text: "hi"))
            XCTFail("submit should be rejected while suspended")
        } catch RuntimeLifecycleError.notRunning {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }

        await controller.resume()
        let resumed = await controller.currentState()
        XCTAssertEqual(resumed, .idle)
    }

    func testNoOrphanTaskAfterStop() async {
        let controller = RuntimeLifecycleController(coordinator: p5Coordinator(conversation: P5SlowConversation()))
        await controller.start()
        _ = try? await controller.submit(.userMessage(text: "讲久一点"))
        await controller.stop()
        let active = await controller.activeRequestCount()
        let state = await controller.currentState()
        XCTAssertEqual(active, 0)
        XCTAssertEqual(state, .stopped)
    }

    func testRunForResultProducesPresentation() async throws {
        let controller = RuntimeLifecycleController(coordinator: p5Coordinator(model: P5RespondModel(text: "在呢")))
        await controller.start()
        let result = try await controller.runForResult(.userMessage(text: "你好"))
        XCTAssertNotNil(result.presentation)
    }
}
