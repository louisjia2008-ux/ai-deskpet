import XCTest
import CoreGraphics
@testable import DeskPet

final class SpeechLibraryTests: XCTestCase {

    func testCategoryWeightsSumToOne() {
        let total = SpeechCategory.allCases.reduce(0) { $0 + $1.weight }
        XCTAssertEqual(total, 1.0, accuracy: 0.0001)
    }

    func testPickCategoryRespectsCumulativeBands() {
        XCTAssertEqual(SpeechLibrary.pickCategory(roll: 0.0), .companionship)   // 0.00–0.40
        XCTAssertEqual(SpeechLibrary.pickCategory(roll: 0.39), .companionship)
        XCTAssertEqual(SpeechLibrary.pickCategory(roll: 0.50), .encouragement)  // 0.40–0.70
        XCTAssertEqual(SpeechLibrary.pickCategory(roll: 0.80), .banter)         // 0.70–0.90
        XCTAssertEqual(SpeechLibrary.pickCategory(roll: 0.95), .assistant)      // 0.90–1.00
    }

    func testLineSelectionStaysInBounds() {
        XCTAssertFalse(SpeechLibrary.line(for: .companionship, roll: 0.0).isEmpty)
        XCTAssertFalse(SpeechLibrary.line(for: .assistant, roll: 0.999).isEmpty)
    }
}

@MainActor
final class ProactivityEngineTests: XCTestCase {

    func testSpeaksAfterIntervalThenEntersQuietAfterTwo() {
        let e = ProactivityEngine()
        e.minInterval = 10; e.maxInterval = 10; e.quietPeriod = 60
        let ctx = BehaviorContext()
        // t=0 first eligible speak (lastSpeak is -inf).
        guard case .speak = e.decide(now: 0, context: ctx, engagement: 1, roll: 0.0) else {
            return XCTFail("expected first speak")
        }
        // Within the interval → no speak.
        XCTAssertEqual(e.decide(now: 5, context: ctx, engagement: 1, roll: 0.0), .none)
        // Second speak at the interval → triggers quiet period.
        guard case .speak = e.decide(now: 10, context: ctx, engagement: 1, roll: 0.0) else {
            return XCTFail("expected second speak")
        }
        // Now quiet for quietPeriod despite interval elapsing.
        XCTAssertEqual(e.decide(now: 25, context: ctx, engagement: 1, roll: 0.0), .none)
    }

    func testConvergenceSuppressesSpeech() {
        // During forced convergence the pet must never speak (it may still self-entertain).
        let e = ProactivityEngine()
        e.minInterval = 1; e.maxInterval = 1
        var ctx = BehaviorContext()
        ctx.absoluteQuiet = true
        for t in stride(from: 0.0, through: 300.0, by: 7.0) {
            if case .speak = e.decide(now: t, context: ctx, engagement: 1, roll: 0.0) {
                return XCTFail("must not speak while converging")
            }
        }
    }

    func testEngagementShortensInterval() {
        let e = ProactivityEngine()
        e.minInterval = 30; e.maxInterval = 120
        let ctx = BehaviorContext()
        XCTAssertEqual(e.speakInterval(engagement: 1, context: ctx), 30, accuracy: 0.001)
        XCTAssertEqual(e.speakInterval(engagement: 0, context: ctx), 120, accuracy: 0.001)
    }

    func testWorkAppDoublesInterval() {
        let e = ProactivityEngine()
        e.minInterval = 30; e.maxInterval = 30
        var ctx = BehaviorContext()
        ctx.frontmostBundleID = "com.apple.dt.Xcode"
        XCTAssertEqual(e.speakInterval(engagement: 1, context: ctx), 60, accuracy: 0.001)
    }
}

@MainActor
final class EngagementTrackerTests: XCTestCase {
    func testEngagementTrackerClampsAndDecays() {
        let tracker = EngagementTracker()
        for _ in 0..<10 { tracker.interaction() }
        XCTAssertLessThanOrEqual(tracker.score, 1.0)
        let high = tracker.score
        tracker.decay(dt: 5)
        XCTAssertLessThanOrEqual(tracker.score, high)
    }
}
