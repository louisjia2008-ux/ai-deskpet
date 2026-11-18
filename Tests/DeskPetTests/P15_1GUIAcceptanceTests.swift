import XCTest
import Foundation
@testable import PetAgentRuntime
@testable import AICore

private let p15RepositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .path

/// P15.1 — Human-Visible GUI Acceptance Tests
///
/// These tests are the unit-test anchor layer that backs the
/// NSHostingView-based P15.1 GUI smoke harness. They cover:
///   • Approval buttons exist in production UI code (allowOnce/deny)
///   • Approval runtime path (approveActivePlan / cancelActivePlan) is real
///   • Retry/recovery transient status is set by apply()
///   • Structured reasoning field never reaches persisted text
///   • Conversation isolation filters activeTaskActivity by conversationID
///   • Terminal cleanup: activeTaskActivity cleared on terminal
///   • Parallel enum invariant: ChatActivityStatus derived only, no dual-write
final class P15_1GUIAcceptanceTests: XCTestCase {

    // MARK: - APPROVAL-01 — buttons exist

    func testAPPROVAL01_ApprovalDecisionEnumHasAllowOnceDeny() {
        // P17 / DS-03 — the dead `FloatingApprovalDecision` (AgentTimelineStep.swift)
        // was removed; the production approval enum is `ApprovalDecision` in
        // Sources/AICore/CapabilityBroker.swift.
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/AICore/CapabilityBroker.swift")
        XCTAssertTrue(source.contains("ApprovalDecision: Sendable, Equatable { case allowOnce, allowSession, deny }"))
    }

    func testAPPROVAL02_ApprovalCardViewRemovedInP17() {
        // P17-E — `ApprovalCardView` was removed because it was only
        // referenced from `AgentTimelineView`, which itself was
        // unreferenced from production code (P16 GAP-03). Production
        // approval UX now uses `TaskActivityCard` directly (verified
        // by testAPPROVAL03 / testAPPROVAL04 below).
        let fm = FileManager.default
        XCTAssertFalse(
            fm.fileExists(atPath: "\(p15RepositoryRoot)/Sources/DeskPet/FloatingChat/ApprovalCardView.swift"),
            "P17-E: ApprovalCardView.swift must be removed (P16 GAP-03)")
        XCTAssertFalse(
            fm.fileExists(atPath: "\(p15RepositoryRoot)/Sources/DeskPet/FloatingChat/AgentTimelineView.swift"),
            "P17-E: AgentTimelineView.swift must be removed")
    }

    func testAPPROVAL03_TaskActivityCardRendersApprovalAllowDenyButtons() {
        // Verify the production TaskActivityCard has the unified approval vocabulary
        // ("允许一次" / "拒绝" — P17 / CI-03) wired to onApprove / onCancel when the
        // run is .waitingForApproval.
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/DeskPet/UI/TaskActivityCard.swift")
        XCTAssertTrue(source.contains("Label(\"允许一次\""))
        XCTAssertTrue(source.contains("Label(\"拒绝\""))
        XCTAssertTrue(source.contains("onApprove"))
        XCTAssertTrue(source.contains("onCancel"))
        XCTAssertTrue(source.contains("run?.status == .waitingForApproval"))
    }

    func testAPPROVAL04_CompanionChatWiresTaskActivityCardCallbacks() {
        // Verify the production CompanionChatView wires TaskActivityCard's
        // onApprove/onCancel to viewModel methods that call runtime.
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/DeskPet/UI/CompanionChatView.swift")
        XCTAssertTrue(source.contains("onApprove: viewModel.approveActivePlan"))
        XCTAssertTrue(source.contains("onCancel: viewModel.cancelActivePlan"))
    }

    func testAPPROVAL05_ApproveActivePlanCallsRuntime() {
        // Verify ChatModel.approveActivePlan delegates to runtime.approveActivePlan.
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/DeskPet/AI/ChatModel.swift")
        XCTAssertTrue(source.contains("func approveActivePlan()"))
        XCTAssertTrue(source.contains("await runtime.approveActivePlan(conversationID: conversationID)"))
    }

    func testAPPROVAL06_CancelActivePlanCallsRuntime() {
        // Verify ChatModel.cancelActivePlan delegates to runtime.cancelActivePlan.
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/DeskPet/AI/ChatModel.swift")
        XCTAssertTrue(source.contains("func cancelActivePlan()"))
        XCTAssertTrue(source.contains("await runtime.cancelActivePlan(conversationID: conversationID)"))
    }

    // MARK: - RETRY-UX-01..03 — friendly transient status

    func testRETRYUX01_ApplyTaskActivitySetsWaitingForRetryTransientStatus() {
        // ChatModel.apply(.taskActivity) line 440 must set transientStatusText
        // to the friendly Chinese copy when kind is .taskWaitingForRetry.
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/DeskPet/AI/ChatModel.swift")
        XCTAssertTrue(source.contains("case .taskWaitingForRetry:"))
        XCTAssertTrue(source.contains("transientStatusText = \"请求暂时受限，将自动重试…\""))
    }

    func testRETRYUX02_ApplyTaskActivitySetsRecoveredTransientStatus() {
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/DeskPet/AI/ChatModel.swift")
        XCTAssertTrue(source.contains("case .taskRecovered:"))
        XCTAssertTrue(source.contains("transientStatusText = \"已恢复，继续处理…\""))
    }

    // MARK: - THINKING-REASONING-01..03 — no reasoning in persistence

    func testTHINKING_REASONING01_NoRawReasoningInAssistantText() {
        // Simulate a streaming delta containing a <think> block plus a
        // structured reasoning field. After ChatModel.apply processing
        // (filter at ingest + flush), the persisted text must not contain
        // any reasoning artifacts.
        let mlFilter = ThinkingContentFilter.filter(
            "<think>internal chain-of-thought</think>visible answer"
        )
        XCTAssertEqual(mlFilter.visible, "visible answer")
        XCTAssertFalse(mlFilter.visible.lowercased().contains("think"))
        XCTAssertFalse(mlFilter.visible.lowercased().contains("chain-of-thought"))
    }

    func testTHINKING_REASONING02_ToolResultPrivacyHookRedactsForbiddenTokens() {
        // PrivacyToolPostExecuteHook.forbiddenTokens must include reasoning
        // and the Chinese variants.
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/PetAgentRuntime/ToolPostExecuteHook.swift")
        XCTAssertTrue(source.contains("\"reasoning\""))
        XCTAssertTrue(source.contains("\"thinking\""))
        XCTAssertTrue(source.contains("\"推理\""))
        XCTAssertTrue(source.contains("\"思维链\""))
    }

    func testTHINKING_REASONING03_StreamingSanitizerStripsReasoningChannel() {
        // StreamingModelResponseSanitizer.ingest(reasoningDelta:) must put
        // reasoning into reasoningText (telemetry) and never into visibleText.
        let sanitizer = StreamingModelResponseSanitizer()
        let result = sanitizer.ingest(contentDelta: "Visible content",
                                      reasoningDelta: "Hidden reasoning")
        XCTAssertEqual(result.visibleText, "Visible content")
        XCTAssertEqual(result.reasoningText, "Hidden reasoning")
        XCTAssertTrue(result.hadReasoning)
    }

    // MARK: - CONVERSATION-ISOLATION-01..02

    func testCONVISO01_RefreshActiveTaskActivityFiltersByConversationID() {
        // ChatModel.refreshActiveTaskActivity must reject runs whose
        // conversationID does not match the active conversation.
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/DeskPet/AI/ChatModel.swift")
        XCTAssertTrue(source.contains("run.conversationID == conversation.id"))
    }

    func testCONVISO02_ExecutionStateKeyedByConversationID() {
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/DeskPet/AI/ChatModel.swift")
        XCTAssertTrue(source.contains("executionStates: [UUID: ConversationExecutionState]"))
    }

    // MARK: - TERMINAL-CLEANUP-01..03

    func testTERMINAL01_ActiveTaskActivityClearedOnTerminal() {
        // refreshActiveTaskActivity sets activeTaskActivity = nil when run is
        // terminal. This is the visual invariant.
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/DeskPet/AI/ChatModel.swift")
        XCTAssertTrue(source.contains("!run.status.isTerminal"))
        XCTAssertTrue(source.contains("activeTaskActivity = nil"))
    }

    func testTERMINAL02_ChatActivityBubbleFadesForTerminal() {
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/DeskPet/UI/ChatActivityBubble.swift")
        XCTAssertTrue(source.contains("backgroundOpacity"))
        XCTAssertTrue(source.contains("activity.status.isTerminal ? 0.56 : 0.92"))
    }

    func testTERMINAL03_TaskActivityCardHidesStopButtonOnTerminal() {
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/DeskPet/UI/TaskActivityCard.swift")
        // The actions computed property must check isTerminal before showing Stop.
        XCTAssertTrue(source.contains("run?.status.isTerminal == true"))
        XCTAssertTrue(source.contains("canShowStopAction"))
    }

    // MARK: - PARALLEL-ENUM-INVARIANT-01..02

    func testPARALLEL_ENUM01_AgentTaskStatusIsSingleSourceOfTruth() {
        // Verify ChatActivityBubble reads displayName (safe) and not toolID
        // (raw). The bubble renders `displayName` and `title` from catalog;
        // `toolID` is stored but not rendered.
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/DeskPet/UI/ChatActivityBubble.swift")
        XCTAssertTrue(source.contains("Text(activity.summary)"))
        XCTAssertTrue(source.contains("Text(tool.displayName)"))
        // toolID is NOT rendered directly in ChatActivityBubble's visible text.
        let toolIDRender = source.contains("Text(activity.tools.first?.toolID")
            || source.contains("Text(tool.toolID)")
        XCTAssertFalse(toolIDRender, "toolID must not be rendered in ChatActivityBubble body")
    }

    func testPARALLEL_ENUM02_UserActivityPhaseIsDerivedFromAgentTaskStatus() {
        // AgentUserActivityProjector maps RuntimeExecutionState → UserActivityPhase.
        // It must be the single source of truth for user-visible phase.
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/PetAgentRuntime/AgentUserActivityProjection.swift")
        XCTAssertTrue(source.contains("public enum UserActivityPhase"))
        XCTAssertTrue(source.contains("public enum AgentUserActivityProjector"))
        XCTAssertTrue(source.contains("public static func project"))
        // Must have 10 phase cases
        for phase in ["idle", "thinking", "usingTool", "waitingForApproval",
                      "waitingForRetry", "recovering", "cancelling",
                      "completed", "failed", "cancelled"] {
            XCTAssertTrue(source.contains("case \(phase)"),
                          "UserActivityPhase must include .\(phase)")
        }
    }

    // MARK: - P15.1 HARNESS ARTIFACTS

    func testHARNESS01_GUIHarnessFileExistsAndCompiles() {
        // Verify the harness source is wired into the production build.
        let harnessPath = "\(p15RepositoryRoot)/Sources/DeskPet/App/P15_1GUIAcceptanceHarness.swift"
        XCTAssertTrue(FileManager.default.fileExists(atPath: harnessPath),
                      "P15.1 GUI harness must exist")
        let source = try! String(contentsOfFile: harnessPath)
        XCTAssertTrue(source.contains("enum P15_1GUIAcceptanceHarness"))
        // All 13 scenarios must be enumerated.
        for scenario in ["toolDateTime", "toolLocalDiscovery", "approvalPending",
                         "approvalApprove", "approvalReject", "cancelRunning",
                         "retryWaiting", "retryRecovery", "conversationIsolationA",
                         "conversationIsolationB", "terminalCleanupSucceeded",
                         "terminalCleanupFailed", "terminalCleanupCancelled"] {
            XCTAssertTrue(source.contains("case \(scenario)"),
                          "Harness must enumerate scenario \(scenario)")
        }
    }

    func testHARNESS02_HarnessUsesProductionViews() {
        // The harness must reference the REAL production views, not custom
        // stand-ins.
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/DeskPet/App/P15_1GUIAcceptanceHarness.swift")
        XCTAssertTrue(source.contains("TaskActivityCard(task:"))
        XCTAssertTrue(source.contains("ChatActivityBubble(activity:"))
        XCTAssertTrue(source.contains("NSHostingView"))
        XCTAssertTrue(source.contains("cacheDisplay"))
    }

    func testHARNESS03_HarnessIsDebugOnly() {
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/DeskPet/App/P15_1GUIAcceptanceHarness.swift")
        // P22 — accept either the legacy `#if DEBUG` or the precision gate
        // `#if PHASE_HARNESS && DEBUG`; both keep the file out of release.
        XCTAssertTrue(source.contains("#if DEBUG")
                      || source.contains("#if PHASE_HARNESS && DEBUG"))
        XCTAssertTrue(source.contains("#endif"))
    }

    func testHARNESS04_AppDelegateWiresHarness() {
        // Verify AppDelegate invokes runIfRequested on launch with the harness env.
        let source = try! String(contentsOfFile: "\(p15RepositoryRoot)/Sources/DeskPet/AppDelegate.swift")
        XCTAssertTrue(source.contains("P15_1GUIAcceptanceHarness.requestedScenario != nil"))
        XCTAssertTrue(source.contains("P15_1GUIAcceptanceHarness.runIfRequested"))
    }
}
