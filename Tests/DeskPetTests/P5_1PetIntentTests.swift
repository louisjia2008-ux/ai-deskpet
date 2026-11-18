import XCTest
@testable import DeskPet

@MainActor
final class P5_1PetIntentTests: XCTestCase {

    func testMappingMatchesAnimationFSMEvents() {
        XCTAssertEqual(PetUIIntentRouter.animationEvent(for: .windowOpened), .userMessageReceived)
        XCTAssertEqual(PetUIIntentRouter.animationEvent(for: .navigationChanged), .userMessageReceived)
        XCTAssertEqual(PetUIIntentRouter.animationEvent(for: .runtimeAttention), .userMessageReceived)
        XCTAssertEqual(PetUIIntentRouter.animationEvent(for: .focusStarted), .thinkingStarted)
        XCTAssertEqual(PetUIIntentRouter.animationEvent(for: .focusPaused), .thinkingFinished)
        XCTAssertEqual(PetUIIntentRouter.animationEvent(for: .taskCompleted), .responseFinished(emotion: .happy))
        XCTAssertEqual(PetUIIntentRouter.animationEvent(for: .focusCompleted), .responseFinished(emotion: .happy))
        XCTAssertEqual(PetUIIntentRouter.animationEvent(for: .permissionBlocked), .emotionChanged(.thinking))
    }

    func testNavigationChangedIsThrottled() {
        var clock: TimeInterval = 100
        var received: [PetAgentAnimationEvent] = []
        let router = PetUIIntentRouter(navThrottle: 0.6, now: { clock }, sink: { received.append($0) })

        router.send(.navigationChanged)        // delivered
        router.send(.navigationChanged)        // within window → throttled
        XCTAssertEqual(received.count, 1)

        clock += 0.7
        router.send(.navigationChanged)        // window passed → delivered
        XCTAssertEqual(received.count, 2)
    }

    func testNonThrottledIntentsAlwaysDeliver() {
        var received: [PetAgentAnimationEvent] = []
        let router = PetUIIntentRouter(navThrottle: 5, now: { 0 }, sink: { received.append($0) })
        router.send(.windowOpened)
        router.send(.taskCompleted)
        router.send(.taskCompleted)
        XCTAssertEqual(received.count, 3)
        XCTAssertEqual(router.deliveredCount, 3)
    }

    func testTaskCompletedDeliversHappyFinish() {
        var received: [PetAgentAnimationEvent] = []
        let router = PetUIIntentRouter(now: { 0 }, sink: { received.append($0) })
        router.send(.taskCompleted)
        XCTAssertEqual(received, [.responseFinished(emotion: .happy)])
    }

    func testNoopRouterDoesNothing() {
        let router = NoopPetIntentRouter()
        router.send(.windowOpened)
        router.send(.taskCompleted)
        // reaching here without effect/crash is the assertion
        XCTAssertTrue(true)
    }
}
