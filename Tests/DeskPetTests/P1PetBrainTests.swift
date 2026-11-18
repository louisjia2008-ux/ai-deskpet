import XCTest
import Foundation
@testable import DeskPet
@testable import AICore
@testable import PetBrainCore

// MARK: - Test doubles (FakeModel / FakeAgentGateway / spies — no UI needed, gate item 14)

private final class CallSpy: @unchecked Sendable {
    var modelCalls = 0
    var agentCalls = 0
    var lastRequest: ModelRequest?
}

private struct SpyModel: ModelProviding {
    let spy: CallSpy
    let reply: String
    func respond(to request: ModelRequest) async -> SemanticResponse {
        spy.modelCalls += 1
        spy.lastRequest = request
        return SemanticResponse(text: reply, kind: .chat, route: .character,
                                emotionProposal: EmotionProposal(deltas: [.valence: 0.15], trigger: .userMessage))
    }
}

private struct SpyAgent: AgentGateway {
    let spy: CallSpy
    var result: AgentStartResult
    func start(_ request: AgentRequest) async -> AgentStartResult {
        spy.agentCalls += 1
        return result
    }
}

// MARK: - Routing (P1 tests 1–3)

final class P1RoutingTests: XCTestCase {

    private func makeRuntime(_ spy: CallSpy, reply: String = "你好呀，今天想做什么") -> InProcessPetBrainRuntime {
        InProcessPetBrainRuntime(model: SpyModel(spy: spy, reply: reply),
                                 agent: SpyAgent(spy: spy, result: .unavailable(reason: "P1 无 Runtime")))
    }

    func testCharacterRouteCallsModelNotAgent() async {
        let spy = CallSpy()
        let rt = makeRuntime(spy)
        let pres = await rt.handle(InputEvent(kind: .userMessage(text: "你好")))
        XCTAssertEqual(spy.modelCalls, 1)
        XCTAssertEqual(spy.agentCalls, 0)          // character route never starts an agent
        XCTAssertFalse(pres.bubbles.isEmpty)
        XCTAssertTrue(pres.bubbles.joined().contains("今天想做什么"))  // model substance reaches UI
    }

    func testDesktopAssistantRouteIsPlanOnly() async {
        let spy = CallSpy()
        let rt = makeRuntime(spy)
        let pres = await rt.handle(InputEvent(kind: .userMessage(text: "帮我设个提醒")))
        XCTAssertEqual(spy.modelCalls, 0)          // P1 assistant does NOT execute / call model
        XCTAssertEqual(spy.agentCalls, 0)
        XCTAssertTrue(pres.bubbles.joined().contains("计划"))   // plan only, no execution
    }

    func testAgentRouteReturnsUnavailable() async {
        let spy = CallSpy()
        let rt = makeRuntime(spy)
        let pres = await rt.handle(InputEvent(kind: .userMessage(text: "帮我审计这个项目并重构")))
        XCTAssertEqual(spy.agentCalls, 1)          // consulted the gateway…
        XCTAssertEqual(spy.modelCalls, 0)
        XCTAssertTrue(pres.bubbles.joined().contains("还没接上"))  // …which is unavailable
    }
}

// MARK: - Emotion (P1 tests 4–6)

final class P1EmotionTests: XCTestCase {

    func testProposalCannotBypassReducer() {
        // There is no public API to mutate EmotionState; the only way to change it is the reducer,
        // and a huge proposal is clamped — so a model cannot swing emotion arbitrarily (decision 3).
        let reducer = EmotionReducer(maxDeltaPerApply: 0.2)
        let after = reducer.apply(EmotionProposal(deltas: [.valence: 9.0], trigger: .userMessage),
                                  to: .neutral, elapsed: 0)
        XCTAssertEqual(after.value(.valence), 0.7, accuracy: 0.0001)   // 0.5 + cap(0.2)
    }

    func testSingleChangeIsCapped() {
        let reducer = EmotionReducer(maxDeltaPerApply: 0.1)
        let after = reducer.apply(EmotionProposal(deltas: [.arousal: 0.8], trigger: .interaction),
                                  to: .neutral, elapsed: 0)
        XCTAssertLessThanOrEqual(after.value(.arousal) - 0.5, 0.1 + 1e-9)
    }

    func testEmotionDecaysTowardNeutralOverTime() {
        let reducer = EmotionReducer(maxDeltaPerApply: 0.3, decayPerSecond: 0.05)
        let excited = reducer.apply(EmotionProposal(deltas: [.valence: 0.3], trigger: .userMessage),
                                    to: .neutral, elapsed: 0)
        let later = reducer.decayed(excited, seconds: 2)
        XCTAssertLessThan(later.value(.valence), excited.value(.valence))
        XCTAssertGreaterThanOrEqual(later.value(.valence), 0.5)   // never overshoots neutral
    }
}

// MARK: - Character Renderer (P1 tests 7–11)

final class P1RendererTests: XCTestCase {
    private let renderer = CharacterRenderer()

    private func render(_ text: String, mode: CharacterSpeakingMode,
                        kind: SemanticResponse.Kind = .chat) -> String {
        let resp = SemanticResponse(text: text, kind: kind, route: .character)
        let p = renderer.render(resp, persona: .canonical, emotion: .neutral,
                                speakingMode: mode, animationIntent: .explain)
        return p.bubbles.joined(separator: "")
    }

    func testFactsNumbersAndUncertaintyPreserved() {
        let out = render("测试通过 3 项，覆盖率 87%，还有 1 项不确定。", mode: .tutor)
        XCTAssertTrue(out.contains("3"))
        XCTAssertTrue(out.contains("87%"))
        XCTAssertTrue(out.contains("1"))
        XCTAssertTrue(out.contains("不确定"))
    }

    func testSeriousModeStripsCuteExpression() {
        let out = render("出错啦呀～哦😢 需要你看一下。", mode: .warning)
        for cute in ["啦", "呀", "～", "哦", "😢"] {
            XCTAssertFalse(out.contains(cute), "serious mode must not contain \(cute)")
        }
        XCTAssertTrue(out.contains("需要你看一下"))   // substance kept
    }

    func testPermissionTemplateIsAccurateAndNonCoercive() {
        let text = "需要访问日历以创建事件，是否允许？"
        let out = render(text, mode: .permissionRequest, kind: .permissionRequest)
        XCTAssertEqual(out, text)                 // unchanged: no added flourish or coercion
        XCTAssertFalse(out.contains("！"))
    }

    func testExpressionBudgetTrimsParticles() {
        let out = render("好啦好哦好呀好呢好咯", mode: .casual)
        let particles: Set<Character> = ["啦", "哦", "呀", "呢", "咯"]
        let count = out.filter { particles.contains($0) }.count
        XCTAssertLessThanOrEqual(count, ExpressionBudget.default.maxCuteParticles)
    }

    func testNewUserInputCancelsPendingLowPriorityBubble() {
        var queue = PresentationQueue()
        let low = CharacterPresentation(bubbles: ["闲聊气泡"], speakingMode: .casual, emotion: .happy,
                                        animationIntent: .listen, priority: .low)
        let normal = CharacterPresentation(bubbles: ["重要回复"], speakingMode: .tutor, emotion: .neutral,
                                           animationIntent: .explain, priority: .normal)
        queue.enqueue(low); queue.enqueue(normal)
        queue.interruptForUserInput()
        XCTAssertEqual(queue.pending.count, 1)
        XCTAssertEqual(queue.pending.first?.priority, .normal)
    }
}

// MARK: - Legacy chat compatibility (P1 tests 12–13)

@MainActor
final class P1LegacyChatTests: XCTestCase {

    func testLegacyConversationJSONStillLoads() throws {
        // Pre-M5 shape: no `archived` / `updatedAt`.
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskpet-legacy-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let legacy = """
        [{"id":"\(UUID().uuidString)","kind":"normal","title":"旧对话",
          "messages":[{"id":"\(UUID().uuidString)","role":"user","text":"以前的消息","viaCloud":false,
                       "timestamp":"2026-01-01T00:00:00Z"}]}]
        """
        try Data(legacy.utf8).write(to: url)
        let loaded = ChatStore(fileURL: url).load()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.title, "旧对话")
        XCTAssertEqual(loaded.first?.messages.first?.text, "以前的消息")
        XCTAssertEqual(loaded.first?.archived, false)   // defaulted, no crash
    }

    func testMainChatPathProducesPetBubbleThroughPetBrain() async {
        // The chat "main path" still yields a pet reply — now via PetBrain, model substance intact.
        let spy = CallSpy()
        let rt = InProcessPetBrainRuntime(model: SpyModel(spy: spy, reply: "我在呢，一起加油"),
                                          agent: FakeAgentGateway())
        let pres = await rt.handle(InputEvent(kind: .userMessage(text: "在吗")))
        XCTAssertTrue(pres.bubbles.joined().contains("我在呢"))
    }
}
