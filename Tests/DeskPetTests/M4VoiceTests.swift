import XCTest
@testable import AICore

final class VoicePolicyTests: XCTestCase {

    private let tags = VoiceTags(emotion: .happy)

    func testMutedIsAlwaysSilent() {
        let a = VoicePolicy.decide(level: .muted, autoMuted: false, kind: .chatter, text: "hi", tags: tags)
        XCTAssertEqual(a, .silent)
    }

    func testAutoMuteOverridesFullVoice() {
        let a = VoicePolicy.decide(level: .full, autoMuted: true, kind: .reminder, text: "该专注了", tags: tags)
        XCTAssertEqual(a, .silent)   // meeting/fullscreen/night/focus → silent (doc §8.3)
    }

    func testEffectsOnlyUsesEffectsNotSpeech() {
        if case .effect(let n) = VoicePolicy.decide(level: .effectsOnly, autoMuted: false,
                                                    kind: .chatter, text: "在呢", tags: tags) {
            XCTAssertEqual(n, "chirp")
        } else { XCTFail("expected effect") }
        // Reading is not voiced at the effects-only level.
        XCTAssertEqual(VoicePolicy.decide(level: .effectsOnly, autoMuted: false,
                                          kind: .reading, text: "长文", tags: tags), .silent)
    }

    func testFullVoiceSpeaksWithParams() {
        if case .speak(let t, let rate, let pitch, let vol) = VoicePolicy.decide(
            level: .full, autoMuted: false, kind: .chatter, text: "你好", tags: tags) {
            XCTAssertEqual(t, "你好")
            XCTAssertGreaterThan(rate, 0)
            XCTAssertGreaterThan(pitch, 0)
            XCTAssertGreaterThan(vol, 0)
        } else { XCTFail("expected speak") }
    }

    func testEmotionShapesPitchAndRate() {
        let happy = VoiceTags(emotion: .happy).synthParams()
        let sad = VoiceTags(emotion: .sad).synthParams()
        XCTAssertGreaterThan(happy.pitch, sad.pitch)   // happy higher
        XCTAssertGreaterThan(happy.rate, sad.rate)     // happy faster
    }

    func testSpeedMultiplierIsClamped() {
        let fast = VoiceTags(emotion: .neutral, speed: 5).synthParams()
        XCTAssertLessThanOrEqual(fast.rate, 2.0)
        let slow = VoiceTags(emotion: .neutral, speed: 0.01).synthParams()
        XCTAssertGreaterThanOrEqual(slow.rate, 0.5)
    }
}
