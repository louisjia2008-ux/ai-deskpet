import XCTest
import Foundation
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

final class P5BehaviorPolicyTests: XCTestCase {

    func testCompanionIsDefault() {
        XCTAssertEqual(BehaviorPolicy().mode, .companion)
        XCTAssertTrue(BehaviorPolicy().decide(environment: .normal).allowProactive)
    }

    func testQuietSuppressesProactive() {
        let decision = BehaviorPolicy(mode: .quiet).gateProactive(
            urgency: 0.2, companionshipValue: 0.9, privacyRisk: 0, environment: .normal, cooldownActive: false)
        guard case .suppress = decision else { return XCTFail("quiet should suppress") }
    }

    func testCompanionAllowsWhenValuable() {
        let decision = BehaviorPolicy().gateProactive(
            urgency: 0.3, companionshipValue: 0.7, privacyRisk: 0, environment: .normal, cooldownActive: false)
        XCTAssertEqual(decision, .allow)
    }

    func testFullscreenSuppresses() {
        let decision = BehaviorPolicy(mode: .companion).decide(environment: EnvironmentContext(isFullscreen: true))
        XCTAssertFalse(decision.allowProactive)
    }

    func testLowBatteryDegrades() {
        let decision = BehaviorPolicy(mode: .companion).decide(environment: EnvironmentContext(lowBattery: true))
        XCTAssertTrue(decision.degraded)
        XCTAssertLessThanOrEqual(decision.maxConsecutiveProactive, 1)
    }
}

final class P5BehaviorStateMachineTests: XCTestCase {

    func testSpeakingPath() throws {
        var machine = CharacterBehaviorStateMachine()
        try machine.handle(.start)
        try machine.handle(.userMessage)
        try machine.handle(.beginThinking)
        try machine.handle(.beginSpeaking)
        XCTAssertEqual(machine.state, .speaking)
        try machine.handle(.finished)
        XCTAssertEqual(machine.state, .idle)
    }

    func testPermissionPath() throws {
        var machine = CharacterBehaviorStateMachine(state: .idle)
        try machine.handle(.userMessage)
        try machine.handle(.beginThinking)
        try machine.handle(.needPermission)
        XCTAssertEqual(machine.state, .waitingForPermission)
        try machine.handle(.permissionResolved)
        XCTAssertEqual(machine.state, .acting)
        try machine.handle(.finished)
        XCTAssertEqual(machine.state, .idle)
    }

    func testInterruptPath() throws {
        var machine = CharacterBehaviorStateMachine(state: .idle)
        try machine.handle(.userMessage)
        try machine.handle(.beginThinking)
        try machine.handle(.interrupt)
        XCTAssertEqual(machine.state, .interrupted)
        try machine.handle(.recovered)
        XCTAssertEqual(machine.state, .idle)
    }

    func testErrorRecoveryPath() throws {
        var machine = CharacterBehaviorStateMachine(state: .idle)
        try machine.handle(.userMessage)
        try machine.handle(.recoverFromError)
        XCTAssertEqual(machine.state, .errorRecovery)
        try machine.handle(.recovered)
        XCTAssertEqual(machine.state, .idle)
    }

    func testInvalidTransitionThrows() {
        var machine = CharacterBehaviorStateMachine(state: .dormant)
        XCTAssertThrowsError(try machine.handle(.userMessage)) { error in
            guard case BehaviorTransitionError.invalid(let from, let event) = error else {
                return XCTFail("expected invalid transition")
            }
            XCTAssertEqual(from, .dormant)
            XCTAssertEqual(event, "userMessage")
        }
    }

    func testSleepingSuppressesAmbientAndNeverAutoActs() throws {
        var machine = CharacterBehaviorStateMachine(state: .idle)
        try machine.handle(.sleep)
        XCTAssertEqual(machine.state, .sleeping)
        XCTAssertTrue(machine.state.suppressesAmbient)
        XCTAssertFalse(machine.canHandle(.beginActing))     // cannot auto-enter acting
        try machine.handle(.userMessage)                    // a direct tap/message wakes it
        XCTAssertEqual(machine.state, .listening)
    }
}

final class P5PresentationDriverTests: XCTestCase {

    func testThinkingTriggersThinkingExpression() async {
        let driver = RecordingPresentationDriver()
        let command = CharacterBehaviorStateMachine.presentationCommand(for: .thinking)
        await driver.setExpression(command.expression)
        let last = await driver.lastExpression
        XCTAssertEqual(last, .thinking)
    }

    func testSpeakingSetsSpeakingTrue() async {
        let driver = RecordingPresentationDriver()
        await driver.setSpeaking(true)
        let speaking = await driver.isSpeaking
        XCTAssertTrue(speaking)
    }

    func testResetToIdleClearsSpeaking() async {
        let driver = RecordingPresentationDriver()
        await driver.setSpeaking(true)
        await driver.resetToIdle()
        let speaking = await driver.isSpeaking
        let resets = await driver.resetCount
        XCTAssertFalse(speaking)
        XCTAssertEqual(resets, 1)
    }

    func testUpdateEmotionMapsDominant() async {
        let driver = RecordingPresentationDriver()
        await driver.updateEmotion(.neutral)
        let emotion = await driver.lastEmotion
        XCTAssertEqual(emotion, .neutral)
    }

    func testStubDriverDoesNotCrashOnAnyCommand() async {
        let driver = NoOpLive2DPresentationDriver()
        await driver.setExpression(.happy)
        await driver.playMotion(.wave)
        await driver.setSpeaking(true)
        await driver.setAttentionTarget(AttentionTarget(x: 1, y: 2))
        await driver.updateEmotion(.neutral)
        await driver.resetToIdle()
        await driver.setReduceMotion(true)
        XCTAssertTrue(true)   // reaching here means no crash; Live2D remains a stub
    }
}
