import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P16 — legality extensions for CharacterBehaviorStateMachine. The four new rows make the
// dormant machine production-viable: idle/observing can begin thinking or acting without a
// user message first (scheduled tasks), thinking can finish into idle (empty response), and
// acting can begin speaking (streamed reply after a task completes).

final class P16BehaviorMachineLegalityTests: XCTestCase {

    func testIdleBeginThinkingIsLegal() {
        var m = CharacterBehaviorStateMachine(state: .idle)
        XCTAssertNoThrow(try m.handle(.beginThinking))
        XCTAssertEqual(m.state, .thinking)
    }

    func testObservingBeginThinkingIsLegal() {
        var m = CharacterBehaviorStateMachine(state: .observing)
        XCTAssertNoThrow(try m.handle(.beginThinking))
        XCTAssertEqual(m.state, .thinking)
    }

    func testIdleBeginActingIsLegal() {
        var m = CharacterBehaviorStateMachine(state: .idle)
        XCTAssertNoThrow(try m.handle(.beginActing))
        XCTAssertEqual(m.state, .acting)
    }

    func testObservingBeginActingIsLegal() {
        var m = CharacterBehaviorStateMachine(state: .observing)
        XCTAssertNoThrow(try m.handle(.beginActing))
        XCTAssertEqual(m.state, .acting)
    }

    func testThinkingFinishedReturnsIdle() {
        var m = CharacterBehaviorStateMachine(state: .thinking)
        XCTAssertNoThrow(try m.handle(.finished))
        XCTAssertEqual(m.state, .idle)
    }

    func testActingBeginSpeakingIsLegal() {
        var m = CharacterBehaviorStateMachine(state: .acting)
        XCTAssertNoThrow(try m.handle(.beginSpeaking))
        XCTAssertEqual(m.state, .speaking)
    }

    func testDormantBeginActingRemainsIllegal() {
        let next = CharacterBehaviorStateMachine.next(from: .dormant, event: .beginActing)
        XCTAssertNil(next, "previously-illegal (.dormant, .beginActing) must remain so")
    }

    func testLegalSequenceListeningThinkingActingSpeakingFinishedIdle() throws {
        var m = CharacterBehaviorStateMachine(state: .idle)
        try m.handle(.userMessage)        // → .listening
        try m.handle(.beginThinking)      // → .thinking
        try m.handle(.beginActing)        // → .acting
        try m.handle(.beginSpeaking)      // → .speaking
        try m.handle(.finished)           // → .idle
        XCTAssertEqual(m.state, .idle)
    }
}

@MainActor
final class P16ContainerBehaviorAdvancerTests: XCTestCase {

    func testAdvancerDrivesContainerWithoutIssuingPresentation() async {
        let driver = RecordingPresentationDriver()
        let container = await p16MakeContainer(driver: driver)
        await container.bootstrap()
        let advancer = ContainerBehaviorAdvancer(container: container)
        let beforeMotions = await driver.motions
        _ = await advancer.advance(.start)
        _ = await advancer.advance(.userMessage)
        let afterMotions = await driver.motions
        XCTAssertEqual(beforeMotions.count, afterMotions.count,
                       "issuePresentation=false must skip driver.playMotion calls")
        XCTAssertEqual(advancer.currentState, .listening)
    }

    func testAdvancerIssuesPresentationWhenOptedIn() async {
        let driver = RecordingPresentationDriver()
        let container = await p16MakeContainer(driver: driver)
        await container.bootstrap()
        _ = await container.advanceBehavior(.start)
        let mid = await driver.motions.count
        _ = await container.advanceBehavior(.userMessage)
        let after = await driver.motions.count
        XCTAssertGreaterThan(after, mid, "default-true path must drive the driver")
    }
}

@MainActor
private func p16MakeContainer(driver: any CharacterPresentationDriver) async -> AgentRuntimeContainer {
    await AgentRuntimeContainer(
        tier: .developerID,
        context: P5FakeContext(),
        model: P5RespondModel(),
        conversation: P5FakeConversation(),
        executor: p16PassthroughExecutor,
        ledger: NoopAgentTaskLedgerStore(),
        presentationDriver: driver,
        loopDecisionProviderFactory: nil)
}

private let p16PassthroughExecutor: ToolExecuting = Executor()

private struct Executor: ToolExecuting {
    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        ToolOutcome(ok: true, output: "", error: nil)
    }
}
