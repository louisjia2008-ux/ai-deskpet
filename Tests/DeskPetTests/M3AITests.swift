import XCTest
import Foundation
@testable import DeskPet
@testable import AICore

final class StructuredResponseTests: XCTestCase {

    func testNormalizesUnknownEnumsToSafeDefaults() {
        let resp = StructuredResponse.normalize(id: "x", json: [
            "reply": "好的", "emotion": "evil", "action": "selfdestruct", "suggestions": ["a", "b"],
        ])
        XCTAssertEqual(resp.emotion, .neutral)   // unknown → safe default
        XCTAssertEqual(resp.action, .none)
        XCTAssertEqual(resp.reply, "好的")
    }

    func testValidEnumsPassThrough() {
        let resp = StructuredResponse.normalize(id: "x", json: [
            "reply": "嗨", "emotion": "happy", "action": "wave",
        ])
        XCTAssertEqual(resp.emotion, .happy)
        XCTAssertEqual(resp.action, .wave)
    }

    func testStrictValidityCheck() {
        XCTAssertTrue(StructuredResponse.isStrictlyValid(emotion: "happy", action: "wave"))
        XCTAssertFalse(StructuredResponse.isStrictlyValid(emotion: "happy", action: "boom"))
    }

    func testSuggestionsCappedAtFour() {
        let resp = StructuredResponse.normalize(id: "x", json: [
            "reply": "r", "suggestions": ["1", "2", "3", "4", "5", "6"],
        ])
        XCTAssertEqual(resp.suggestions.count, 4)
    }
}

final class LocalEngineTests: XCTestCase {

    func testGreetingIntentProducesValidStructuredReply() {
        let r = LocalEngine().respond(to: AIRequest(kind: .chat, prompt: "你好呀"))
        XCTAssertTrue(r.ok)
        XCTAssertEqual(r.emotion, .happy)
        XCTAssertEqual(r.action, .wave)
        XCTAssertFalse(r.reply.isEmpty)
    }

    func testQuestionIntentSuggestsAndSurfacesContext() {
        let req = AIRequest(kind: .chat, prompt: "这个为什么会报错？",
                            context: PerceivedContext(frontmostApp: "Xcode"))
        let r = LocalEngine().respond(to: req)
        XCTAssertEqual(r.emotion, .thinking)
        XCTAssertTrue(r.suggestions.contains { $0.contains("Xcode") })
    }

    func testScreenContextIsAcknowledged() {
        let req = AIRequest(kind: .chat, prompt: "看看这个",
                            context: PerceivedContext(screenText: "编译错误：找不到符号"))
        XCTAssertTrue(LocalEngine().respond(to: req).reply.contains("看了"))
    }
}

final class ModelRouterTests: XCTestCase {

    func testShortPromptRoutesLocal() {
        XCTAssertEqual(ModelRouter().route(prompt: "今天天气不错"), .local)
    }

    func testHardKeywordRecommendsCloud() {
        XCTAssertEqual(ModelRouter().route(prompt: "帮我推导这个证明"), .cloudRecommended)
    }

    func testNeverGoesCloudWithoutAuthorization() {
        let r = ModelRouter()
        let dest = r.destination(for: .cloudRecommended, cloudAuthorized: false)
        XCTAssertEqual(dest, .localWithCloudSuggestion)   // no silent upload (doc §11.2)
        XCTAssertEqual(r.destination(for: .cloudRecommended, cloudAuthorized: true), .cloud)
    }
}

final class CloudAuthAndPerceptionTests: XCTestCase {

    func testCloudAuthIsPerFunction() {
        var auth = CloudAuthorization()
        XCTAssertFalse(auth.isAuthorized(.chat))
        auth.grant(.chat)
        XCTAssertTrue(auth.isAuthorized(.chat))
        XCTAssertFalse(auth.isAuthorized(.document))
        auth.reset()
        XCTAssertFalse(auth.anyGranted)
    }

    func testPerceptionLevelGates() {
        var p = PerceptionPolicy()                    // default L1
        XCTAssertTrue(p.canReadApp)
        XCTAssertFalse(p.canReadTitle(ofBundleID: "com.apple.dt.Xcode"))  // L2 not enabled
        XCTAssertFalse(p.canReadScreen(explicitConsent: true))

        p.maxLevel = .title
        p.titleWhitelist = ["com.apple.dt.Xcode"]
        XCTAssertTrue(p.canReadTitle(ofBundleID: "com.apple.dt.Xcode"))
        XCTAssertFalse(p.canReadTitle(ofBundleID: "com.apple.Safari"))    // not whitelisted

        p.maxLevel = .screen
        XCTAssertFalse(p.canReadScreen(explicitConsent: false))           // needs explicit consent
        XCTAssertTrue(p.canReadScreen(explicitConsent: true))
        XCTAssertFalse(p.screenTextMayPersist())                         // never persisted (§11.5)
    }
}

@MainActor
final class ChatStoreTests: XCTestCase {

    func testPrivateAndTemporaryNeverPersist() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskpet-chat-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = ChatStore(fileURL: url)

        var normal = Conversation(kind: .normal, title: "n")
        normal.messages.append(ChatMessage(role: .user, text: "hi"))
        var priv = Conversation(kind: .privateChat, title: "p")
        priv.messages.append(ChatMessage(role: .user, text: "secret"))
        var temp = Conversation(kind: .temporary, title: "t")
        temp.messages.append(ChatMessage(role: .user, text: "ephemeral"))

        try store.save([normal, priv, temp])
        let loaded = ChatStore(fileURL: url).load()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.kind, .normal)
    }
}
