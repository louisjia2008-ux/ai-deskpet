import XCTest
import Foundation
@testable import PetAgentRuntime
@testable import AICore
@testable import PetBrainCore

/// Unit tests for the synchronous ConversationTurn state machine. The
/// chunk-loop state lives here (no actor re-entry) so the per-chunk
/// transitions are deterministic and easy to assert.
final class ConversationTurnTests: XCTestCase {

    func testEmptyInit() {
        let t = ConversationTurn()
        XCTAssertEqual(t.buffer, "")
        XCTAssertEqual(t.emotion, .neutral)
        XCTAssertFalse(t.viaCloud)
        XCTAssertEqual(t.outputSeq, 0)
        XCTAssertNil(t.pendingTypedFailure)
        XCTAssertFalse(t.terminated)
    }

    func testConsumeDeltaAppendsAndBumpsSequence() {
        var t = ConversationTurn()
        let bail = t.consume(chunk: .delta(sequence: 1, text: "你好"))
        XCTAssertFalse(bail)
        XCTAssertEqual(t.buffer, "你好")
        XCTAssertEqual(t.outputSeq, 1)

        let second = t.consume(chunk: .delta(sequence: 5, text: "世界"))
        XCTAssertFalse(second)
        XCTAssertEqual(t.buffer, "你好世界")
        XCTAssertEqual(t.outputSeq, 5, "provider sequence wins over the monotonic counter")
    }

    func testConsumeCompletedStoresEmotionAndCloud() {
        var t = ConversationTurn()
        t.consume(chunk: .delta(sequence: 1, text: "hi"))
        t.consume(chunk: .completed(emotion: .happy, viaCloud: true))
        XCTAssertEqual(t.emotion, .happy)
        XCTAssertTrue(t.viaCloud)
    }

    func testConsumeTypedErrorCapturesFailure() {
        var t = ConversationTurn()
        let typed = LlmFailure(code: .rateLimited, message: "慢一点")
        let bail = t.consume(chunk: .typedError(typed))
        XCTAssertTrue(bail, "typed error must signal the chunk loop to bail")
        XCTAssertEqual(t.pendingTypedFailure, typed)
    }

    func testConsumeMetadataDoesNotChangeBuffer() {
        var t = ConversationTurn()
        t.consume(chunk: .delta(sequence: 1, text: "hi"))
        t.consume(chunk: .metadata(.trueStreaming))
        XCTAssertEqual(t.buffer, "hi")
        XCTAssertEqual(t.outputSeq, 1)
    }

    func testResolveFailureNoTypedFailsTerminal() {
        var t = ConversationTurn()
        let d = t.resolveFailure(error: NSError(domain: "x", code: 1))
        if case .failTerminal(let r, let typed, let durable) = d {
            XCTAssertEqual(r, "生成失败")
            XCTAssertNil(typed)
            XCTAssertNil(durable)
        } else {
            XCTFail("expected .failTerminal, got \(d)")
        }
    }

    func testResolveFailureTypedFailsTerminalWithDurable() {
        var t = ConversationTurn()
        let typed = LlmFailure(code: .rateLimited, message: "模型不可用")
        t.consume(chunk: .typedError(typed))
        // `pendingTypedFailure` is the user-facing message source (mirrors
        // the inline production behavior — typedFailure.message takes
        // precedence over the thrown error's LocalizedDescription).
        let d = t.resolveFailure(error: NSError(domain: "x", code: 1))
        if case .failTerminal(let r, let got, let durable) = d {
            XCTAssertEqual(r, "模型不可用")
            XCTAssertEqual(got, typed)
            XCTAssertNotNil(durable)
            XCTAssertEqual(durable?.phase, "provider")
        } else {
            XCTFail("expected .failTerminal with typed payload, got \(d)")
        }
    }

    func testIsTerminalizedHonorsAllFourSources() {
        XCTAssertTrue(ConversationTurn.isTerminalized(CancelFlags(cancellationError: true)))
        XCTAssertTrue(ConversationTurn.isTerminalized(CancelFlags(taskCancelled: true)))
        XCTAssertTrue(ConversationTurn.isTerminalized(CancelFlags(assistantCancelled: true)))
        XCTAssertTrue(ConversationTurn.isTerminalized(CancelFlags(attemptTerminalized: true)))
        XCTAssertFalse(ConversationTurn.isTerminalized(CancelFlags()))
    }
}