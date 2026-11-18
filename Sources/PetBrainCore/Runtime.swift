import Foundation

// Injected dependencies — all protocols so PetBrainCore never touches concrete model/agent/storage
// implementations (architecture gate: external deps via protocol injection only).

public protocol ModelProviding: Sendable {
    func respond(to request: ModelRequest) async -> SemanticResponse
}

/// Agent seam. P1 has no real runtime; `FakeAgentGateway` reports unavailable (D2).
public protocol AgentGateway: Sendable {
    func start(_ request: AgentRequest) async -> AgentStartResult
}

public struct FakeAgentGateway: AgentGateway {
    public var reason: String
    public init(reason: String = "Agent Runtime 尚未接入（P1）") { self.reason = reason }
    public func start(_ request: AgentRequest) async -> AgentStartResult { .unavailable(reason: reason) }
}

/// Storage seam (D6): all persistent reads go through a Repository, never raw JSON in business logic.
public protocol PetBrainRepository: Sendable {
    func memoryHints(forCloud: Bool) async -> [String]
}

public protocol PetBrainClock: Sendable {
    func now() -> Date
}
public struct SystemClock: PetBrainClock {
    public init() {}
    public func now() -> Date { Date() }
}

/// Top-level seam (D1): swap `InProcessPetBrainRuntime` for a future `XPCPetBrainRuntime` without
/// touching the UI.
public protocol PetBrainRuntime: Sendable {
    func handle(_ event: InputEvent) async -> CharacterPresentation
}

/// Single-actor PetBrain (D1 ④): all mutable state (emotion) is serialized here; only the reducer
/// can change emotion (decision 3). Pure-logic dependencies are injected.
public actor InProcessPetBrainRuntime: PetBrainRuntime {

    private let persona: Persona
    private var emotion: EmotionState
    private var lastEmotionUpdate: Date

    private let planner = DialoguePlanner()
    private let renderer = CharacterRenderer()
    private let reducer: EmotionReducer

    private let model: ModelProviding
    private let agent: AgentGateway
    private let clock: PetBrainClock

    public init(persona: Persona = .canonical,
                reducer: EmotionReducer = EmotionReducer(),
                model: ModelProviding,
                agent: AgentGateway,
                clock: PetBrainClock = SystemClock()) {
        self.persona = persona
        self.emotion = .neutral
        self.lastEmotionUpdate = clock.now()
        self.reducer = reducer
        self.model = model
        self.agent = agent
        self.clock = clock
    }

    /// Read-only snapshot for the UI (UI must never write emotion).
    public func currentEmotion() -> EmotionState { emotion }

    public func handle(_ event: InputEvent) async -> CharacterPresentation {
        let plan = planner.plan(for: event)
        let response = await execute(plan: plan, event: event)

        // Emotion is updated ONLY through the reducer (decision 3 / §6.2).
        let now = clock.now()
        let elapsed = max(0, now.timeIntervalSince(lastEmotionUpdate))
        if let proposal = response.emotionProposal {
            emotion = reducer.apply(proposal, to: emotion, elapsed: elapsed)
        } else {
            emotion = reducer.decayed(emotion, seconds: elapsed)
        }
        lastEmotionUpdate = now

        return renderer.render(response, persona: persona, emotion: emotion,
                               speakingMode: plan.speakingMode, animationIntent: plan.animationIntent)
    }

    // MARK: Route execution (P1: only character route hits a model; assistant/agent are stubs)

    private func execute(plan: DialoguePlan, event: InputEvent) async -> SemanticResponse {
        let userText: String = {
            if case .userMessage(let t) = event.kind { return t }
            return ""
        }()

        switch plan.route {
        case .character:
            let req = ModelRequest(text: userText, route: .character,
                                   isPrivate: event.conversationClass == .privateChat,
                                   useScreen: event.useScreen, requiresMemory: plan.requiresMemory)
            return await model.respond(to: req)

        case .desktopAssistant:
            // P1: plan only, NO real system action (spec B.6 / prohibitions 3–4).
            return SemanticResponse(
                text: "我可以帮你记下这件事：「\(userText)」。不过桌面操作还在接入中，现在只能先帮你列出计划，不会真的执行。",
                kind: .plan, route: .desktopAssistant)

        case .agent:
            let result = await agent.start(AgentRequest(goal: userText))
            switch result {
            case .unavailable(let reason):
                return SemanticResponse(
                    text: "这是个需要我启动后台帮手的大任务，但帮手还没接上（\(reason)）。我可以先陪你把思路理清楚。",
                    kind: .unavailable, route: .agent)
            case .started(let id):
                return SemanticResponse(text: "好的，我开始处理了（会话 \(id.uuidString.prefix(8))）。",
                                        kind: .plan, route: .agent)
            }
        }
    }
}
