import Foundation

/// Deterministic, offline placeholder for the local LLM (doc §11.2 本地默认). It produces a
/// VALID structured response from simple intent rules so the whole chat/bubble/perception
/// pipeline can be built and tested now; a real on-device model (llama.cpp / MLX) drops in
/// behind this same `respond` contract later. Clearly not final intelligence — like the
/// placeholder sprite, it validates engineering, not the model.
public struct LocalEngine: Sendable {

    public init() {}

    public func respond(to req: AIRequest) -> AIResponse {
        let intent = classify(req.prompt)
        var emotion: PetEmotion = .neutral
        var action: PetAction = .none
        var reply: String
        var suggestions: [String] = []

        switch intent {
        case .greeting:
            reply = "嗨～我在的，今天想做点什么？"; emotion = .happy; action = .wave
        case .thanks:
            reply = "嘿嘿，不客气啦"; emotion = .shy; action = .nod
        case .question:
            reply = answerHint(req); emotion = .thinking; action = .read
            suggestions = ["展开讲讲", "换个角度", "记成任务"]
        case .encourage:
            reply = "你已经很努力啦，再坚持一下下～"; emotion = .excited; action = .cheer
        case .farewell:
            reply = "好的，我自己玩一会儿，需要随时叫我"; emotion = .neutral; action = .play
        case .smalltalk:
            reply = mirror(req.prompt); emotion = .happy; action = .nod
        }

        // Surface that perception context was used, transparently (doc §11.4).
        // P18 — extend the relevance gate beyond `.question`. Frontend app context
        // (L1) is now surfaced when (a) the intent is a question, OR (b) the user has
        // already issued >= 2 user turns in the conversation, OR (c) the user just
        // asked the model to look at the screen (`screenText` is non-nil). Window
        // titles are surfaced only when the bundle is whitelisted via the caller's
        // `PerceptionPolicy`, which is enforced in `OverlayWindowController.perceivedContext(_:)`.
        // Screen text remains gated by `req.useScreen == true` upstream; we never
        // inject screen text outside an explicit user request.
        let userTurnCount = req.history.filter { $0.role == .user }.count
        let surfaceAmbient = intent == .question || userTurnCount >= 2 || req.context.screenText != nil
        if let app = req.context.frontmostApp, surfaceAmbient {
            suggestions.append("结合 \(app) 看看")
        }
        if let title = req.context.windowTitle, surfaceAmbient {
            suggestions.append("结合窗口 \(title) 看看")
        }
        if req.context.screenText != nil {
            reply += "（我看了你让我看的内容）"
        }

        return AIResponse(id: req.id, ok: true, reply: reply,
                          emotion: emotion, action: action, suggestions: suggestions)
    }

    // MARK: Intent classification (rule-based placeholder)

    enum Intent { case greeting, thanks, question, encourage, farewell, smalltalk }

    func classify(_ text: String) -> Intent {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return .smalltalk }
        for kw in ["你好", "嗨", "在吗", "早", "hi", "hello"] where t.localizedCaseInsensitiveContains(kw) { return .greeting }
        for kw in ["谢谢", "感谢", "thx", "thanks"] where t.localizedCaseInsensitiveContains(kw) { return .thanks }
        for kw in ["加油", "鼓励", "累了", "坚持"] where t.contains(kw) { return .encourage }
        for kw in ["再见", "拜拜", "晚安", "bye"] where t.localizedCaseInsensitiveContains(kw) { return .farewell }
        if t.contains("？") || t.contains("?") || t.contains("吗") || t.contains("怎么") || t.contains("为什么") {
            return .question
        }
        return .smalltalk
    }

    private func answerHint(_ req: AIRequest) -> String {
        "这个问题我先记下要点啦，复杂推理可以切到云端模型更稳哦"
    }

    private func mirror(_ text: String) -> String {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count <= 12 ? "嗯嗯，\(t)～" : "我听到啦，我们慢慢聊"
    }
}
