import XCTest
import AppKit
import AICore
@testable import DeskPet

final class CharacterSurfaceTests: XCTestCase {
    func testOccupancyDistinguishesTransparentCornersAndNativeYAxis() {
        let mask = CharacterOccupancy(width:2,height:2,alpha:[255,0,0,255])
        let frame = CGRect(x:-1400,y:200,width:100,height:200)
        XCTAssertTrue(mask.contains(CGPoint(x:-1375,y:350),in:frame))
        XCTAssertFalse(mask.contains(CGPoint(x:-1325,y:350),in:frame))
        XCTAssertTrue(mask.contains(CGPoint(x:-1325,y:250),in:frame))
        XCTAssertFalse(mask.contains(CGPoint(x:0,y:0),in:frame))
        XCTAssertFalse(CharacterOccupancy(width:2,height:2,alpha:[]).contains(CGPoint(x:-1375,y:350),in:frame))
    }
    func testVisualBoundsAndBubbleAnchorUseOccupiedGeometry() {
        let mask = CharacterOccupancy(width:4,height:4,alpha:[0,0,0,0,0,255,0,0,0,255,0,0,0,0,0,0])
        XCTAssertEqual(mask.visualBounds(in:CGRect(x:100,y:200,width:80,height:160)),CGRect(x:120,y:240,width:20,height:80))
    }
    func testModelSelectionIsRelativeAndContained() {
        let root = URL(fileURLWithPath:"/private/tmp/deskpet-surface-test")
        XCTAssertNotNil(CharacterModelSelection(identity:"自选角色",relativePath:"模型/My Model.model3.json").source(within:root))
        XCTAssertNil(CharacterModelSelection(identity:"test",relativePath:"/private/tmp/outside/model.json").source(within:root))
        XCTAssertNil(CharacterModelSelection(identity:"test",relativePath:"../model.json").source(within:root))
        XCTAssertNil(CharacterModelSelection(identity:"test",relativePath:"script.js").source(within:root))
    }
    func testCapabilitiesNeverInventHeadOrWalkAssets() {
        let capabilities = CharacterModelCapabilities(payload:["motions":[["group":"Idle","index":0]],"expressions":["happy"]])
        XCTAssertTrue(capabilities.hitAreas.isEmpty)
        XCTAssertNil(capabilities.motion(for:"walkLeft"))
        XCTAssertEqual(capabilities.motion(for:"idle")?.group,"Idle")
        XCTAssertFalse(capabilities.supportsStandardMouth)
    }
    @MainActor func testCanonicalSurfaceHasOneLive2DHostAndNoSpriteView() {
        let surface = CharacterSurface(frame:CGRect(x:0,y:0,width:300,height:260))
        defer { surface.shutdown() }
        XCTAssertEqual(CharacterSurface.rendererIdentity,"deskpet.live2d")
        XCTAssertEqual(surface.subviews.filter { $0 === surface.host.bridge.webView }.count, 1)
        XCTAssertFalse(surface.subviews.contains { String(describing:type(of:$0)) == "SKView" })
        surface.setFeet(to:CGPoint(x:150,y:20),facing:1)
        XCTAssertFalse(surface.hitTestCharacter(CGPoint(x:150,y:50)))
    }
    @MainActor func testProductionControllerConstructsLive2DSurfaceWithoutSpriteKit() {
        let overlay = OverlayWindowController(state:PetState(),screens:ScreenManager(),modelRoot:URL(fileURLWithPath:"/private/tmp/deskpet-surface-test"))
        defer { overlay.stopLifecycleResources(); overlay.surface.shutdown() }
        XCTAssertTrue(overlay.surface.window?.contentView is OverlayContentView)
        func count(_ name: String, in view: NSView) -> Int {
            (String(describing:type(of:view)) == name ? 1 : 0) + view.subviews.reduce(0) { $0 + count(name,in:$1) }
        }
        XCTAssertEqual(count("WKWebView",in:overlay.surface),1)
        XCTAssertEqual(count("SKView",in:overlay.surface),0)
    }
    @MainActor func testEmotionWithoutMotionIsIndependentOfActivity() {
        let surface = CharacterSurface(frame:.zero)
        defer { surface.shutdown() }
        surface.apply(intent:CharacterAnimationIntent(state:.sleeping,priority:35,source:.desktopInteraction))
        surface.react(emotion:.happy,action:.none)
        XCTAssertEqual(surface.characterState.emotion,.happy)
        XCTAssertEqual(surface.currentIntent.state,.sleeping)
    }
    @MainActor func testPresencePriorityAndDragLandingExpiry() {
        let surface = CharacterSurface(frame:.zero)
        defer { surface.shutdown() }
        surface.apply(intent:CharacterAnimationIntent(state:.sleeping,priority:35,source:.desktopInteraction))
        surface.apply(activity:.idle)
        XCTAssertEqual(surface.currentIntent.state,.sleeping)
        surface.apply(intent:CharacterAnimationIntent(state:.dragged,priority:90,source:.desktopInteraction))
        surface.apply(intent:CharacterAnimationIntent(state:.landing,priority:80,duration:0.32,source:.desktopInteraction,createdAt:0))
        XCTAssertEqual(surface.currentIntent.state,.landing)
        surface.update(deltaTime:0.4)
        XCTAssertNotEqual(surface.currentIntent.state,.landing)
        surface.setVisible(false,animated:false)
        XCTAssertFalse(surface.visibility)
    }
    func testDragDiscriminatesClickAndMovement() {
        var tracker = PetClickGestureTracker(downGlobal:CGPoint(x:-200,y:100),startedAt:0)
        tracker.recordDrag(to:CGPoint(x:-180,y:100))
        XCTAssertFalse(tracker.isClick(upGlobal:CGPoint(x:-200,y:100),endedAt:0.2))
    }
    func testSingleConfigMigrationAndInvalidVersion() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        XCTAssertNil(try CharacterModelConfiguration.load(root: root).character)
        let old = Data(#"{"primary":{"identity":"Chosen","relativePath":"chosen.zip"},"companion":{"identity":"Old partner","relativePath":"old.zip"}}"#.utf8)
        let file = root.appendingPathComponent(CharacterModelConfiguration.filename)
        try old.write(to: file)
        let migrated = try CharacterModelConfiguration.load(root: root)
        XCTAssertEqual(migrated.character?.identity, "Chosen")
        XCTAssertEqual(migrated.version, 1)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("characters.pre-single.json")), old)
        XCTAssertEqual(try CharacterModelConfiguration.load(root: root), migrated)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        XCTAssertNil(object["companion"])
        for invalid in [#"{"version":2,"character":null}"#, #"{"version":1,"character":{"identity":"Bad","relativePath":"../bad.zip"}}"#, #"{"unexpected":true}"#] {
            try Data(invalid.utf8).write(to: file)
            XCTAssertThrowsError(try CharacterModelConfiguration.load(root: root))
        }
    }
    func testExistingManagedRootAliasResolvesWithoutAllowingEscape() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let alias = root.appendingPathComponent("alias")
        let models = root.appendingPathComponent("models")
        try FileManager.default.createDirectory(at: models, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: models)
        XCTAssertNotNil(CharacterModelSelection(identity: "Chosen", relativePath: "model.zip").source(within: alias))
        try Data([1]).write(to: root.appendingPathComponent("model.zip"))
        try FileManager.default.createSymbolicLink(at: models.appendingPathComponent("escape"), withDestinationURL: root)
        XCTAssertNil(CharacterModelSelection(identity: "Bad", relativePath: "escape/model.zip").source(within: alias))
    }
    func testHistoricalPartnerActionDecodesAsSoloPlay() throws {
        let action = try JSONDecoder().decode(PetAction.self, from: Data(#""hugDragon""#.utf8))
        XCTAssertEqual(action, .play)
        XCTAssertEqual(String(data: try JSONEncoder().encode(action), encoding: .utf8), #""play""#)
        XCTAssertFalse(PetAction.allCases.map(\.rawValue).contains("hugDragon"))
    }
}
