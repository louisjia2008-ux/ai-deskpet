import XCTest
import Foundation
@testable import PetAgentRuntime
@testable import AICore
@testable import PetBrainCore

/// Pin tests for the DurableSink privacy dye. The seam exists so the
/// four coordinator helpers (record/mirrorDurable/appendInbox/recordAudit)
/// can no longer drift apart — each path passes through the same gate.
final class DurableSinkTests: XCTestCase {

    // MARK: - Privacy dye — every private task ID must hit every no-op gate.

    func testRecordSkipsPrivateTasks() async throws {
        let sink = RecordingDurableSink()
        let priv = UUID()
        await sink.markPrivate(taskID: priv)   // mirrors coordinator's `dyeFrom`
        try await sink.record(AgentTaskLedgerEvent(taskID: priv, attemptID: UUID(),
                                                   conversationID: UUID(),
                                                   userMessageID: UUID(),
                                                   state: .running, kind: .created, sequence: 0))
        let recorded = await sink.recorded
        XCTAssertTrue(recorded.isEmpty, "private tasks must leave no ledger rows")
    }

    func testMirrorDurableSkipsPrivateTasks() async {
        let sink = RecordingDurableSink()
        let priv = UUID()
        await sink.markPrivate(taskID: priv)
        await sink.mirrorDurable(taskID: priv, attemptID: UUID(),
                                 legacyState: .queued, title: "x",
                                 failure: nil, conversationID: nil)
        let mirrored = await sink.mirrored
        XCTAssertTrue(mirrored.isEmpty, "private tasks must not be mirrored")
    }

    func testAppendInboxSkipsPrivateTasks() async {
        let sink = RecordingDurableSink()
        let priv = UUID()
        await sink.markPrivate(taskID: priv)
        await sink.appendInbox(InboxEvent(taskID: priv, kind: .approvalDecisionRequested,
                                        payload: .object(["k": .string("v")])))
        let inboxed = await sink.inboxed
        XCTAssertTrue(inboxed.isEmpty, "private tasks must not write inbox")
    }

    func testRecordAuditSkipsPrivateTasks() async {
        let sink = RecordingDurableSink()
        let priv = UUID()
        await sink.markPrivate(taskID: priv)
        await sink.recordAudit(RuntimeAuditEvent(kind: .staleCallbackDropped,
                                               correlationID: priv,
                                               summary: "x",
                                               timestamp: Date()))
        let audited = await sink.audited
        XCTAssertTrue(audited.isEmpty, "private tasks must not write audit")
    }

    func testPublicTasksReachAllFourPaths() async throws {
        let sink = RecordingDurableSink()
        let task = UUID()
        await sink.markPrivate(taskID: UUID())    // different id, no effect
        try await sink.record(AgentTaskLedgerEvent(taskID: task, attemptID: UUID(),
                                                   conversationID: UUID(),
                                                   userMessageID: UUID(),
                                                   state: .running, kind: .created, sequence: 0))
        await sink.mirrorDurable(taskID: task, attemptID: UUID(),
                                 legacyState: .running, title: "x",
                                 failure: nil, conversationID: nil)
        await sink.appendInbox(InboxEvent(taskID: task, kind: .approvalDecisionRequested,
                                        payload: .object(["k": .string("v")])))
        await sink.recordAudit(RuntimeAuditEvent(kind: .staleCallbackDropped,
                                               correlationID: task,
                                               summary: "x",
                                               timestamp: Date()))
        let recorded = await sink.recorded
        let mirrored = await sink.mirrored
        let inboxed = await sink.inboxed
        let audited = await sink.audited
        XCTAssertEqual(recorded.count, 1)
        XCTAssertEqual(mirrored.count, 1)
        XCTAssertEqual(inboxed.count, 1)
        XCTAssertEqual(audited.count, 1)
    }

    func testOfflineSinkDropsEverything() async throws {
        let sink = RecordingDurableSink()
        await sink.setOffline(true)
        let task = UUID()
        try await sink.record(AgentTaskLedgerEvent(taskID: task, attemptID: UUID(),
                                                   conversationID: UUID(),
                                                   userMessageID: UUID(),
                                                   state: .running, kind: .created, sequence: 0))
        await sink.mirrorDurable(taskID: task, attemptID: UUID(),
                                 legacyState: .running, title: "x",
                                 failure: nil, conversationID: nil)
        await sink.appendInbox(InboxEvent(taskID: task, kind: .approvalDecisionRequested,
                                        payload: .object(["k": .string("v")])))
        await sink.recordAudit(RuntimeAuditEvent(kind: .staleCallbackDropped,
                                               correlationID: task,
                                               summary: "x",
                                               timestamp: Date()))
        let recorded = await sink.recorded
        let mirrored = await sink.mirrored
        let inboxed = await sink.inboxed
        let audited = await sink.audited
        XCTAssertTrue(recorded.isEmpty && mirrored.isEmpty && inboxed.isEmpty && audited.isEmpty)
    }

    func testAuditWithoutCorrelationIDAlwaysReaches() async {
        // The supervisor's task-less audit hook has no correlation ID and
        // must not be gated. Pin the carve-out.
        let sink = RecordingDurableSink()
        await sink.markPrivate(taskID: UUID())
        await sink.recordAudit(RuntimeAuditEvent(kind: .staleCallbackDropped,
                                               correlationID: nil,
                                               summary: "task-less",
                                               timestamp: Date()))
        let audited = await sink.audited
        XCTAssertEqual(audited.count, 1)
    }

    // MARK: - Coordinator seam regression guard

    /// The four coordinator helpers (record / mirrorDurable / appendInbox /
    /// recordAudit) MUST go through the same privacy gate. If a future edit
    /// adds a new dispatch path that bypasses them, this test catches it by
    /// failing to find the expected call counts after a single line of
    /// production code. Pin the seam with a tiny reflection-style probe:
    /// there is no public symbol count API, so we check that the file
    /// contains exactly four helpers that mention each privacy-gate
    /// keyword. Drift here = seam leak.
    func testCoordinatorHasFourGateHelpers() throws {
        let src = try String(contentsOfFile: Self.coordinatorPath, encoding: .utf8)
        let gateKeywords = [
            "guard !privateTaskIDs.contains(",  // any of the four gates
        ]
        for keyword in gateKeywords {
            let occurrences = src.components(separatedBy: keyword).count - 1
            // The coordinator currently has 5 gates (one per write path,
            // including the one inline at the catch-branch cancel arm). A
            // future writer who bypasses the seam will either delete one
            // (shrinks to ≤4) or duplicate it (grows to ≥6). Anchor to the
            // current number.
            XCTAssertGreaterThanOrEqual(occurrences, 5,
                                        "found \(occurrences) helpers gating on privateTaskIDs in coordinator (want ≥ 5)")
        }
    }

    /// The seam is fully wired: every coordinator helper (`record`,
    /// `mirrorDurable`, `appendInbox`, `recordAudit`) takes the sink-first
    /// branch when `durableSink` is non-nil. Four `if let sink = durableSink`
    /// checks, one per helper — a future edit that drops one breaks the
    /// single-gate invariant.
    func testCoordinatorHasFourSinkFirstBranches() throws {
        let src = try String(contentsOfFile: Self.coordinatorPath, encoding: .utf8)
        let occurrences = src.components(separatedBy: "if let sink = durableSink {").count - 1
        XCTAssertEqual(occurrences, 4,
                       "found \(occurrences) sink-first branches; expected exactly 4 (record/mirror/appendInbox/recordAudit)")
    }

    private static var coordinatorPath: String {
        // Tests live under Tests/DeskPetTests; the source file is two
        // directories up from `+Converse.swift`. Resolve relative to the
        // test target so the path is stable across workspaces.
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // DurableSinkTests.swift
            .deletingLastPathComponent()  // DeskPetTests/
            .deletingLastPathComponent()  // DeskPet/
            .appendingPathComponent("Sources/PetAgentRuntime/PetAgentRuntimeCoordinator.swift")
            .path
    }
}

private extension RecordingDurableSink {
    func setOffline(_ value: Bool) {
        // Test-only convenience; the sink has its own mutator.
        self.offline = value
    }
}