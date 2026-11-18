import XCTest
import AppKit
import AICore
@testable import DeskPet

@MainActor
final class CompanionAppearanceTests: XCTestCase {
    func testOldAppearancePreferencesDecodeWithoutLosingOtherValues() throws {
        let old = Data(#"{"petSize":"large","animationIntensity":"low","avoidDock":false,"allowIdleBreathing":false}"#.utf8)
        let prefs = try JSONDecoder().decode(AppearanceAnimationPreferences.self, from: old)
        XCTAssertEqual(prefs.resolvedCharacterHeight, 360)
        XCTAssertEqual(prefs.animationIntensity, .low)
        XCTAssertFalse(prefs.avoidDock)
        XCTAssertFalse(prefs.allowIdleBreathing)
    }
    func testCustomHeightPersistsAndPresetClearsCustomValue() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("preferences.json")
        let prefs = PreferencesModel(fileURL: url)
        prefs.setCharacterHeight(330)
        XCTAssertEqual(PreferencesModel(fileURL: url).appearance.resolvedCharacterHeight, 330)
        prefs.setCharacterHeight(.infinity)
        XCTAssertEqual(prefs.appearance.resolvedCharacterHeight, 330)
        prefs.setCharacterHeight(900)
        XCTAssertEqual(prefs.appearance.resolvedCharacterHeight, 420)
        prefs.setPetSize(.small)
        let reloaded = PreferencesModel(fileURL: url)
        XCTAssertNil(reloaded.appearance.characterHeight)
        XCTAssertEqual(reloaded.appearance.resolvedCharacterHeight, 160)
    }
    func testLongTextEllipsisFitsActualNarrowWidth() {
        for width: CGFloat in [90, 140, 254] {
            let result = SpeechBubbleLayout.lines(for: String(repeating: "这是一段很长的中文 https://example.test/long-path 文本。", count: 12), maxWidth: width, maxLines: 4, fontSize: 14)
            XCTAssertTrue(result.truncated)
            XCTAssertEqual(result.lines.count, 4)
            XCTAssertTrue(result.lines.last!.hasSuffix("…"))
            for line in result.lines {
                XCTAssertLessThanOrEqual((line as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 14)]).width, width + 0.5)
            }
            XCTAssertGreaterThan(result.totalMeasuredHeight, 50)
        }
    }
    func testBubbleFitsAllEdgesAtEachCharacterSize() {
        for height: CGFloat in [120, 240, 420] {
            let bounds = CGRect(x: 0, y: 0, width: 360, height: height + 190)
            let visual = CharacterSurface.visualSize(height: height)
            for x in [CGFloat(12), bounds.width - visual.width - 12] {
                for y in [CGFloat(16), bounds.height - visual.height - 12] {
                    let character = CGRect(origin: CGPoint(x: x, y: y), size: visual)
                    let placement = CompanionBubblePlacement.frame(size: CGSize(width: 308, height: 116), character: character, within: bounds)
                    XCTAssertTrue(bounds.insetBy(dx: 12, dy: 12).contains(placement.frame))
                    XCTAssertFalse(placement.frame.intersects(character))
                    XCTAssertEqual(placement.above, y == 16)
                }
            }
        }
    }
    func testSurfaceUsesChosenHeightWithoutAddingAnotherWebView() {
        let surface = CharacterSurface(frame: CGRect(x: 0, y: 0, width: 400, height: 650))
        let original = surface.host.bridge.webView
        for height: CGFloat in [120, 240, 420] {
            surface.preferredHeight = height
            surface.setFeet(to: CGPoint(x: 200, y: 20), facing: 1)
            XCTAssertEqual(surface.host.frame.height, height)
            XCTAssertEqual(surface.host.frame.minY, 20)
            XCTAssertTrue(surface.host.bridge.webView === original)
        }
        surface.shutdown()
    }
    func testModelAppearanceSelectionPersistsWithoutChangingOldDefaults() throws {
        let old = Data(#"{"identity":"kitty","relativePath":"kitty.zip"}"#.utf8)
        var selection = try JSONDecoder().decode(CharacterModelSelection.self, from: old)
        XCTAssertNil(selection.appearanceExpressions)
        selection.appearanceExpressions = ["Watermark"]
        let restored = try JSONDecoder().decode(CharacterModelSelection.self, from: JSONEncoder().encode(selection))
        XCTAssertEqual(restored, selection)
        selection.appearanceExpressions = ["Watermark", "Watermark"]
        XCTAssertNil(selection.source(within: FileManager.default.temporaryDirectory))
    }
    func testEquipmentMetadataDoesNotBecomeFloatingTextOnLive2D() {
        let surface = CharacterSurface(frame: CGRect(x: 0, y: 0, width: 360, height: 520))
        surface.setAccessories([.hairclip])
        XCTAssertFalse(surface.subviews.compactMap { ($0 as? NSTextField)?.stringValue }.contains { $0.contains("发夹") })
        surface.setStudyMode(true)
        XCTAssertTrue(surface.subviews.compactMap { ($0 as? NSTextField)?.stringValue }.contains("专注中"))
        surface.shutdown()
    }

    func testFluffySemanticExpressionsPreserveShyAndExcited() {
        let available = ["love", "Blushing", "Cry", "Star", "Angry", "Leaning forward", "Playing games", "Watermark"]
        var state = CharacterSurfaceState()
        for (emotion, name): (PetEmotion, String) in [(.happy,"love"),(.shy,"Blushing"),(.sad,"Cry"),(.excited,"Star"),(.thinking,"Leaning forward")] {
            state.reactionEmotion = emotion
            XCTAssertEqual(CharacterExpressionResolver.expression(for: state, available: available), name)
        }
        state.reactionEmotion = nil; state.emotion = .annoyed
        XCTAssertEqual(CharacterExpressionResolver.expression(for: state, available: available), "Angry")
        state.reactionAction = .play
        XCTAssertEqual(CharacterExpressionResolver.expression(for: state, available: available), "Playing games")
    }
    func testUnsupportedEmotionDoesNotRandomlyChooseWardrobeOrWatermark() {
        var state = CharacterSurfaceState()
        for emotion in [CharacterAnimationEmotion.neutral, .sleepy, .surprised] {
            state.emotion = emotion
            XCTAssertNil(CharacterExpressionResolver.expression(for: state, available: ["Hat","Watermark","dizzy","Reduce"]))
        }
        state.expressionPreview = "Watermark"
        XCTAssertNil(CharacterExpressionResolver.expression(for: state, available: ["Watermark"]))
        state.expressionPreview = "dizzy"
        XCTAssertEqual(CharacterExpressionResolver.expression(for: state, available: ["dizzy"]), "dizzy")
    }
    func testSemanticExpressionReactionExpiresWithoutLeavingOldMood() {
        let surface = CharacterSurface(frame: CGRect(x: 0, y: 0, width: 360, height: 520))
        surface.react(emotion: .shy, action: .none)
        surface.update(deltaTime: 1)
        XCTAssertEqual(CharacterExpressionResolver.expression(for: surface.characterState, available: ["Blushing"]), "Blushing")
        surface.update(deltaTime: 3.1)
        XCTAssertNil(surface.characterState.reactionEmotion)
        XCTAssertEqual(surface.characterState.emotion, .neutral)
        XCTAssertNil(CharacterExpressionResolver.expression(for: surface.characterState, available: ["Blushing"]))
        surface.shutdown()
    }

}
