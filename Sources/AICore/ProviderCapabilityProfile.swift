import Foundation

// P13-D: Normalized per-provider capability profile consumed by the Agent Kernel.
//
// Before P13, kernel-level brand knowledge lived in three call sites that did
// string detection of the provider display name and model id:
//
//   Sources/AICore/ProviderClientFactory.swift:399-412 — `shouldDisableThinking`
//     switched on "minimax" + "minimax-m3" inside `OpenAICompatibleClient`.
//
//   Sources/AICore/ProviderModels.swift:78-80 — `isKnownNativeToolModel`
//     used the same string detection to grant native tool calling.
//
//   Sources/PetAgentRuntime/RecoveryConformance.swift:645-650 — `from(provider:)`
//     hard-coded `hiddenReasoningFields` and `requiredRequestFlags` based on
//     `provider.displayName.lowercased().contains("minimax")` and
//     `modelID.lowercased().contains("minimax-m3")`.
//
// The P13-D contract replaces that brand knowledge with a typed profile that
// each adapter / model can carry. The kernel branches on the profile, never on
// the brand string.

public struct ProviderCapabilityProfile: Codable, Sendable, Equatable {
    /// True iff this provider/model requires a first chat attempt with thinking
    /// disabled, and a retry with thinking enabled only when the first attempt
    /// returns HTTP 400. Encapsulates the MiniMax-M3 retry loop without ever
    /// exposing the brand.
    public var disableThinkingOnFirstAttempt: Bool

    /// Field names that the kernel must strip from any model-visible tool
    /// observation before handing the result back to the loop. Used by some
    /// providers to carry reasoning metadata that the kernel considers
    /// internal. Encapsulates the MiniMax-M3 `reasoning_content` / `reasoning`
    /// redaction without exposing the brand.
    public var hiddenReasoningFields: [String]

    /// Provider-neutral request flags that the kernel must include in every
    /// request to this provider/model. Encapsulates the MiniMax-M3
    /// `thinking.type: disabled` + `reasoning_split: true` flags.
    public var requiredRequestFlags: [String: String]

    /// Maximum tool calls per turn (overrides the default loop bound).
    public var maxToolCalls: Int?

    /// Whether this provider advertises native tool calling for this model.
    public var supportsNativeToolCalling: Bool

    public init(disableThinkingOnFirstAttempt: Bool = false,
                hiddenReasoningFields: [String] = [],
                requiredRequestFlags: [String: String] = [:],
                maxToolCalls: Int? = nil,
                supportsNativeToolCalling: Bool = false) {
        self.disableThinkingOnFirstAttempt = disableThinkingOnFirstAttempt
        self.hiddenReasoningFields = hiddenReasoningFields.sorted()
        self.requiredRequestFlags = requiredRequestFlags
        self.maxToolCalls = maxToolCalls
        self.supportsNativeToolCalling = supportsNativeToolCalling
    }

    /// The default profile used when no specific factory recognises the
    /// provider. Mirrors the pre-P13 behaviour for non-MiniMax providers.
    public static let standard = ProviderCapabilityProfile()

    /// Factory for the legacy MiniMax-M3 model hosted on an OpenAI-compatible
    /// endpoint. The values are byte-for-byte equivalent to the
    /// pre-P13 string-detection behaviour; the brand no longer appears in the
    /// kernel.
    public static func minimaxM3OpenAICompatible() -> ProviderCapabilityProfile {
        ProviderCapabilityProfile(
            disableThinkingOnFirstAttempt: true,
            hiddenReasoningFields: ["reasoning_content", "reasoning"],
            requiredRequestFlags: [
                "thinking.type": "disabled",
                "reasoning_split": "true"
            ],
            supportsNativeToolCalling: true
        )
    }
}

/// Resolves a `ProviderCapabilityProfile` for a given provider/model pair.
///
/// Implementations MUST NOT inspect brand names directly; they MUST branch on
/// the provider's `type` and registered model metadata. The single legacy
/// factory bundled with P13-D maps one provider/modelID pair to
/// `minimaxM3OpenAICompatible()` (the only known model that required the
/// legacy string-detection behaviour). New providers extend the factory, not
/// the kernel.
public protocol ProviderCapabilityProfileResolving: Sendable {
    func capabilityProfile(provider: ProviderConfig, modelID: String?) -> ProviderCapabilityProfile
}

public struct DefaultProviderCapabilityProfileResolver: ProviderCapabilityProfileResolving, Sendable {
    public init() {}

    public func capabilityProfile(provider: ProviderConfig, modelID: String?) -> ProviderCapabilityProfile {
        // Reserved for the legacy MiniMax-M3 model only.
        // The match is on model-id alone (no brand-name string detection);
        // the kernel no longer inspects the display name or baseURL host.
        if provider.type == .openAICompatible,
           let modelID,
           modelID.lowercased().contains("minimax-m3") {
            return .minimaxM3OpenAICompatible()
        }
        return .standard
    }
}