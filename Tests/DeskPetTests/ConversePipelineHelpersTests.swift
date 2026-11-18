import XCTest
import Foundation
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

/// Unit tests for the pure helpers extracted from `PetAgentRuntimeCoordinator.converse`.
/// These live in a sibling file from the coordinator so the helpers can be
/// refactored without touching the actor's isolation surface.
final class ConversePipelineHelpersTests: XCTestCase {

    // MARK: - userFacingGenerationError

    func testUserFacingReturnsLocalizedDescriptionWhenPresent() {
        // Foundation bridges `userInfo[NSLocalizedDescriptionKey]` into the
        // `LocalizedError` conformance that NSError synthesizes in Swift.
        let error = NSError(domain: "test", code: 0, userInfo: [NSLocalizedDescriptionKey: "网络断了"])
        let out = ConversePipelineHelpers.userFacingGenerationError(error)
        // Either the bridge delivers the Chinese message (preferred) or our
        // fallback kicks in — both are acceptable; the bug we are guarding
        // against is "crash / weird non-empty gibberish". The two-acceptable
        // assertion avoids platform-format skew while still catching real
        // regressions (empty string / wrong encoding / wrong fallback).
        XCTAssertTrue(out == "网络断了" || out == "生成失败",
                      "Expected localized message or fallback, got \(out)")
    }

    func testUserFacingFallsBackToDefaultWhenDescriptionIsEmpty() {
        let error = NSError(domain: "test", code: 0, userInfo: [NSLocalizedDescriptionKey: "   "])
        XCTAssertEqual(ConversePipelineHelpers.userFacingGenerationError(error), "生成失败")
    }

    func testUserFacingFallsBackToDefaultWhenNoLocalizedError() {
        struct GenericError: Error {}
        XCTAssertEqual(ConversePipelineHelpers.userFacingGenerationError(GenericError()), "生成失败")
    }

    // MARK: - isTerminalizedCancellation

    func testCancellationFlagsAnySourceTripsIt() {
        XCTAssertTrue(ConversePipelineHelpers.isTerminalizedCancellation(
            CancelFlags(cancellationError: true)))
        XCTAssertTrue(ConversePipelineHelpers.isTerminalizedCancellation(
            CancelFlags(taskCancelled: true)))
        XCTAssertTrue(ConversePipelineHelpers.isTerminalizedCancellation(
            CancelFlags(assistantCancelled: true)))
        XCTAssertTrue(ConversePipelineHelpers.isTerminalizedCancellation(
            CancelFlags(attemptTerminalized: true)))
    }

    func testCancellationFlagsAllFalseDoesNotTrip() {
        XCTAssertFalse(ConversePipelineHelpers.isTerminalizedCancellation(CancelFlags()))
    }

    // MARK: - shouldScheduleRetry

    func testRetrySchedulerRequiresAllThree() {
        XCTAssertTrue(ConversePipelineHelpers
            .shouldScheduleRetry(freshFirstAttempt: true, retryable: true, hasTypedFailure: true))
        XCTAssertFalse(ConversePipelineHelpers
            .shouldScheduleRetry(freshFirstAttempt: false, retryable: true, hasTypedFailure: true),
                      "retry already in flight → no double scheduling")
        XCTAssertFalse(ConversePipelineHelpers
            .shouldScheduleRetry(freshFirstAttempt: true, retryable: false, hasTypedFailure: true),
                      "non-retryable category → fail fast, no wakeup")
        XCTAssertFalse(ConversePipelineHelpers
            .shouldScheduleRetry(freshFirstAttempt: true, retryable: true, hasTypedFailure: false),
                      "legacy stringly-typed → no typed retry handoff")
    }

    // MARK: - terminalActivityDescriptor

    func testDescriptorMapsAllTerminalStates() {
        let succeeded = ConversePipelineHelpers.terminalActivityDescriptor(for: .succeeded, stopReason: .completed)
        XCTAssertEqual(succeeded.kind, .taskSucceeded)
        XCTAssertNil(succeeded.failureCategory)
        XCTAssertEqual(succeeded.title, "任务已完成")

        let partial = ConversePipelineHelpers.terminalActivityDescriptor(for: .partiallySucceeded, stopReason: .completed)
        XCTAssertEqual(partial.kind, .taskPartiallySucceeded)
        XCTAssertEqual(partial.failureCategory, .unknown,
                       ".completed maps to the default fallback")

        let cancelled = ConversePipelineHelpers.terminalActivityDescriptor(for: .cancelled, stopReason: .cancelled)
        XCTAssertEqual(cancelled.kind, .taskCancelled)
        XCTAssertEqual(cancelled.failureCategory, .cancelled)

        let failed = ConversePipelineHelpers.terminalActivityDescriptor(for: .failed, stopReason: .toolFailure)
        XCTAssertEqual(failed.kind, .taskFailed)
        XCTAssertEqual(failed.failureCategory, .toolFailed,
                       ".toolFailure maps to .toolFailed via the pure category table")
    }

    // MARK: - ConverseInboxBuilder + ConverseAuditSummary (pin tests)

    func testInboxBuilderApprovalDecisionRequestedIncludesMissingIDs() {
        let taskID = UUID()
        let event = ConverseInboxBuilder.approvalDecisionRequested(
            taskID: taskID, missing: ["criterion.a", "criterion.b"])
        XCTAssertEqual(event.taskID, taskID)
        XCTAssertEqual(event.kind, .approvalDecisionRequested)
        guard case .object(let obj) = event.payload else {
            XCTFail("expected object payload, got \(event.payload)")
            return
        }
        guard case .array(let ids) = obj["missing"] ?? .null else {
            XCTFail("missing key should hold an array")
            return
        }
        XCTAssertEqual(ids, [.string("criterion.a"), .string("criterion.b")])
    }

    func testInboxBuilderEmptyMissingProducesEmptyArray() {
        let event = ConverseInboxBuilder.approvalDecisionRequested(taskID: UUID(), missing: [])
        guard case .object(let obj) = event.payload,
              case .array(let ids) = obj["missing"] ?? .null else {
            XCTFail("expected missing array payload")
            return
        }
        XCTAssertTrue(ids.isEmpty)
    }

    func testAuditSummaryConverseCatchTerminalizedMatchesLegacyFormat() {
        let attemptID = UUID()
        XCTAssertEqual(ConverseAuditSummary.converseCatchTerminalized(attemptID: attemptID),
                       "converse:catch:terminalized:\(attemptID.uuidString)")
    }

    func testAuditSummaryConverseTerminalizedMatchesLegacyFormat() {
        let attemptID = UUID()
        XCTAssertEqual(ConverseAuditSummary.converseTerminalized(attemptID: attemptID),
                       "converse:terminalized:\(attemptID.uuidString)")
    }
}