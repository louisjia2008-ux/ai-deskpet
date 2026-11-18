import Foundation

/// Validates/normalizes a model's structured output so an out-of-vocabulary emotion or action
/// can never reach the renderer (doc §11.5 — 枚举校验). Also the safe decoder for raw JSON that a
/// real LLM backend might emit with unknown fields.
public enum StructuredResponse {

    /// Decode a loose JSON object into a validated AIResponse, normalizing unknown enum values.
    public static func normalize(id: String, json: [String: Any]) -> AIResponse {
        let reply = (json["reply"] as? String) ?? ""
        let emotion = PetEmotion(rawValue: (json["emotion"] as? String) ?? "") ?? .neutral
        let action = PetAction(rawValue: (json["action"] as? String) ?? "") ?? .none
        let suggestions = (json["suggestions"] as? [String]) ?? []
        let ok = (json["ok"] as? Bool) ?? !reply.isEmpty
        return AIResponse(id: id, ok: ok, reply: reply, emotion: emotion,
                          action: action, suggestions: Array(suggestions.prefix(4)))
    }

    /// True iff every enum field is in-vocabulary (used to flag a misbehaving backend).
    public static func isStrictlyValid(emotion: String, action: String) -> Bool {
        PetEmotion(rawValue: emotion) != nil && PetAction(rawValue: action) != nil
    }
}
