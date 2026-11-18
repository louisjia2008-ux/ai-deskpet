import XCTest
import AppKit
@testable import DeskPet

/// P17 / R1-08 + R2-04 + R2-07 — the floating chat panel opens at the production ideal size
/// on first expand and REMEMBERS a user-driven resize across collapse→expand.
///
/// R2-07: the previous version of this suite re-implemented the clamp locally
/// (`clampForTest`) and its "resize sticks" test asserted `XCTAssertNotNil` on a
/// non-optional literal — it could not detect a regression. These tests drive the REAL
/// production seam (`FloatingChatExpandedSizeMemory`, the exact value the controller owns)
/// and simulate collapse/expand/resize sequences.
@MainActor
final class P17FloatingChatPanelGeometryTests: XCTestCase {
    func testIdealSizeIsProductionDocumentedValue() {
        XCTAssertEqual(FloatingChatPanelMetrics.expandedIdealSize,
                       CGSize(width: 420, height: 520),
                       "R1-08 — production geometry must stay 420×520 so EVID-06 is preserved")
    }

    func testFirstExpandUsesIdealSize() {
        let memory = FloatingChatExpandedSizeMemory()
        XCTAssertEqual(memory.expandedSize, FloatingChatPanelMetrics.expandedIdealSize)
    }

    func testResizeBelowMinIsClampedToMin() {
        var memory = FloatingChatExpandedSizeMemory()
        memory.noteResize(to: CGSize(width: 100, height: 100), state: .expanded)
        XCTAssertEqual(memory.expandedSize, FloatingChatPanelMetrics.expandedMinSize)
    }

    func testResizeAboveMaxIsClampedToMax() {
        var memory = FloatingChatExpandedSizeMemory()
        memory.noteResize(to: CGSize(width: 1200, height: 1200), state: .expanded)
        XCTAssertEqual(memory.expandedSize, FloatingChatPanelMetrics.expandedMaxSize)
    }

    /// The R2-04 regression test: resize while expanded → collapse → expand must return the
    /// user's size, not the seeded ideal size.
    func testUserResizeSticksAcrossCollapseExpand() {
        var memory = FloatingChatExpandedSizeMemory()
        let userChosen = CGSize(width: 520, height: 600)

        // 1. User drags the expanded panel bigger (what the live-resize observer feeds in).
        XCTAssertTrue(memory.noteResize(to: userChosen, state: .expanded),
                      "A live resize while expanded must update the memory")
        XCTAssertEqual(memory.expandedSize, userChosen)

        // 2. Collapse — the capsule frame must NOT overwrite the expanded memory.
        XCTAssertFalse(memory.noteResize(to: FloatingChatPanelMetrics.capsuleSize, state: .capsuleIdle),
                       "R2-04 — a capsule-sized frame must never overwrite the expanded memory")
        XCTAssertEqual(memory.expandedSize, userChosen)

        // 3. Re-expand — the remembered user size is used, NOT the ideal size.
        XCTAssertEqual(memory.expandedSize, userChosen,
                       "R2-04 — the user-chosen expanded size must survive collapse→expand")
        XCTAssertNotEqual(memory.expandedSize, FloatingChatPanelMetrics.expandedIdealSize)
    }

    func testTaskHUDAndHiddenFramesDoNotOverwriteMemory() {
        var memory = FloatingChatExpandedSizeMemory()
        memory.noteResize(to: CGSize(width: 500, height: 560), state: .expanded)
        for state: FloatingChatVisibilityState in [.hidden, .capsuleActive, .taskHUD] {
            XCTAssertFalse(memory.noteResize(to: FloatingChatPanelMetrics.taskHUDSize, state: state))
        }
        XCTAssertEqual(memory.expandedSize, CGSize(width: 500, height: 560))
    }

    func testRepeatedIdenticalResizeIsNotRecordedTwice() {
        var memory = FloatingChatExpandedSizeMemory()
        let size = CGSize(width: 480, height: 540)
        XCTAssertTrue(memory.noteResize(to: size, state: .expanded))
        XCTAssertFalse(memory.noteResize(to: size, state: .expanded),
                       "An unchanged frame must not be reported as a change")
    }

    /// R2-04 — source-scan backstop proving the controller actually OBSERVES live resizes.
    /// Without an observer the memory is circular (the exact defect R2-04 found), and no
    /// value-level test could detect that, because the production seam is never fed.
    func testControllerObservesLiveResizes() {
        let body = resolveText(named: "FloatingChatPanelController", relative: "FloatingChat")
        XCTAssertFalse(body.isEmpty, "FloatingChatPanelController.swift must be resolvable")
        XCTAssertTrue(body.contains("didEndLiveResizeNotification"),
                      "R2-04 — the controller must observe NSWindow.didEndLiveResizeNotification")
        XCTAssertTrue(body.contains("observeResize()"),
                      "R2-04 — the resize observer must be installed during init")
        XCTAssertTrue(body.contains("expandedSizeMemory.noteResize"),
                      "R2-04 — the observer must feed the production expanded-size memory")
        XCTAssertTrue(body.contains("expandedSizeMemory.expandedSize"),
                      "R2-04 — size(for: .expanded) must read the remembered size")
    }

    /// R2-03 — the floating chat host must pass `onOpenAISettings` DOWN UNCHANGED so a nil
    /// closure keeps the dead "打开 AI 设置" CTA hidden.
    func testFloatingChatHostDoesNotCoalesceOpenAISettingsClosure() {
        let body = resolveText(named: "FloatingChatWindowView", relative: "FloatingChat")
        XCTAssertFalse(body.isEmpty, "FloatingChatWindowView.swift must be resolvable")
        XCTAssertFalse(body.contains("onOpenAISettings ?? {}"),
                       "R2-03 — coalescing the optional to an empty closure re-introduces the dead CTA")
        XCTAssertTrue(body.contains("onOpenAISettings: onOpenAISettings)"),
                      "R2-03 — the closure must be threaded through unchanged")
    }
}
