import Foundation

/// Turns a SemanticResponse into a CharacterPresentation (doc §14). Applies the Speaking Mode +
/// Expression Budget and segments into bubbles — but NEVER alters facts: it only trims decorative
/// markers (cute particles / emoji / extra exclamations), never digits, results or uncertainty
/// (doc §14.5). The model's text substance passes through unchanged.
public struct CharacterRenderer: Sendable {

    public init() {}

    private static let cuteParticles: Set<Character> = ["呀", "啦", "哦", "嘛", "呢", "喔", "咯", "哟", "～"]

    public func render(_ response: SemanticResponse, persona: Persona, emotion: EmotionState,
                       speakingMode: CharacterSpeakingMode, animationIntent: AnimationIntent,
                       priority: CharacterPresentation.Priority = .normal) -> CharacterPresentation {
        // Serious modes (warning/permission/failure/agentWorking) zero out the cute budget (§14.3).
        let budget = speakingMode.isSerious ? ExpressionBudget.serious : persona.expressionBudget
        let trimmed = applyBudget(response.text, budget)
        let bubbles = segment(trimmed, maxBubbles: maxBubbles(for: response.kind))
        return CharacterPresentation(
            bubbles: bubbles, speakingMode: speakingMode, emotion: emotion.dominant,
            animationIntent: animationIntent, suggestions: response.suggestions,
            viaCloud: response.viaCloud, priority: priority)
    }

    // MARK: Expression budget (decoration only — facts untouched)

    private func applyBudget(_ text: String, _ b: ExpressionBudget) -> String {
        var s = limit(text, isTarget: { $0 == "！" || $0 == "!" }, max: b.maxExclamations, replaceWith: "。")
        s = limit(s, isTarget: { Self.cuteParticles.contains($0) }, max: b.maxCuteParticles, replaceWith: nil)
        s = limit(s, isTarget: { Self.isEmoji($0) }, max: b.maxEmoji, replaceWith: nil)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Keep the first `max` occurrences of a target char; beyond that, replace or drop. Non-target
    /// characters (incl. all digits/letters) are always preserved verbatim.
    private func limit(_ s: String, isTarget: (Character) -> Bool, max: Int, replaceWith: Character?) -> String {
        var count = 0
        var out = ""
        out.reserveCapacity(s.count)
        for ch in s {
            if isTarget(ch) {
                count += 1
                if count <= max { out.append(ch) }
                else if let r = replaceWith { out.append(r) }
            } else {
                out.append(ch)
            }
        }
        return out
    }

    private static func isEmoji(_ ch: Character) -> Bool {
        ch.unicodeScalars.contains { $0.properties.isEmojiPresentation || ($0.properties.isEmoji && $0.value > 0x2000) }
    }

    // MARK: Semantic segmentation (doc §14.4 — 不按字数硬切)

    private func maxBubbles(for kind: SemanticResponse.Kind) -> Int {
        switch kind {
        case .chat: return 3
        case .plan, .unavailable, .permissionRequest, .error: return 2
        }
    }

    private func segment(_ text: String, maxBubbles: Int) -> [String] {
        guard !text.isEmpty else { return [] }
        var sentences: [String] = []
        var current = ""
        for ch in text {
            current.append(ch)
            if ch == "。" || ch == "！" || ch == "？" || ch == "\n" {
                let s = current.trimmingCharacters(in: .whitespacesAndNewlines)
                if !s.isEmpty { sentences.append(s) }
                current = ""
            }
        }
        let tail = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tail.isEmpty { sentences.append(tail) }
        if sentences.isEmpty { return [text] }
        if sentences.count <= maxBubbles { return sentences }
        // Merge overflow into the final bubble so nothing is lost.
        let head = Array(sentences.prefix(maxBubbles - 1))
        let rest = sentences.suffix(from: maxBubbles - 1).joined(separator: "")
        return head + [rest]
    }
}
