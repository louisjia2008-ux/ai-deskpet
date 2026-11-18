import Foundation
import AICore

/// P19.1 / P1 — Quick Add defaults for cloud providers DeskPet ACTUALLY supports.
///
/// Per P19.1 §9 we trace each provider through:
///   `ProviderType` → `ProviderConfig` → `ProviderClientFactory.makeClient`
///   → `sendChat` / `streamChat` / `listModels` / `testConnection`.
///
/// The audit found that `.openAICompatible` (which covers OpenAI, LM Studio, and
/// any other OpenAI-compatible cloud) has full chat support. `.ollama` has full
/// chat support. `.anthropic`, `.gemini`, `.customHTTP` currently fall through
/// to `ManualProviderClient` which THROWS `unsupportedProvider` on
/// `sendChat` / `streamChat`. We therefore expose quick-add only for the
/// providers with real chat wiring. Anthropic / Gemini / CustomHTTP continue
/// to be reachable via the full manual editor for users who know what they're
/// doing, but the Quick Add surface never claims support that does not exist.
@MainActor
public enum ProviderQuickAddDefaults {

    /// Provider families surfaced in the Quick Add UI. Each family pre-fills
    /// the manual editor with a sensible base URL + common model IDs so users
    /// do not have to dig for them.
    public enum Family: String, CaseIterable, Identifiable, Sendable {
        // P19.6 — added MiniMax / GLM / DeepSeek Quick Add cards. All three
        // are documented in `docs/agent_os/PROVIDER_STREAMING_PROTOCOL.md`
        // and `docs/AGENT_FLOATING_CHAT_ARCHITECTURE.md` as supported cloud
        // providers that speak the OpenAI-compatible HTTP shape. Adding them
        // here means the user does not need to dig through the manual editor
        // to paste a custom base URL + API key. Per P19.1 §9 we only add
        // families whose underlying `.openAICompatible` client has real chat
        // wiring (the same path used by OpenAI itself).
        case openAI
        case ollama
        case lmStudio
        case MiniMax
        case glm
        case deepSeek

        public var id: String { rawValue }

        public var displayName: String {
            switch self {
            case .openAI: return "OpenAI"
            case .ollama: return "Ollama"
            case .lmStudio: return "LM Studio"
            case .MiniMax: return "MiniMax"
            case .glm: return "GLM（智谱）"
            case .deepSeek: return "DeepSeek"
            }
        }

        public var providerType: ProviderType {
            switch self {
            case .openAI: return .openAICompatible
            case .ollama: return .ollama
            case .lmStudio: return .openAICompatible
            case .MiniMax: return .openAICompatible
            case .glm: return .openAICompatible
            case .deepSeek: return .openAICompatible
            }
        }
    }

    /// Default base URL for the family. Users can override before saving.
    public static func defaultBaseURL(for family: Family) -> URL? {
        switch family {
        case .openAI: return URL(string: "https://api.openai.com/v1")
        case .ollama: return URL(string: "http://localhost:11434")
        case .lmStudio: return URL(string: "http://localhost:1234/v1")
        case .MiniMax: return URL(string: "https://api.minimaxi.com/v1")
        case .glm: return URL(string: "https://open.bigmodel.cn/api/paas/v4")
        case .deepSeek: return URL(string: "https://api.deepseek.com/v1")
        }
    }

    /// Default capabilities advertised for the family. Users can adjust in the
    /// editor.
    public static func defaultCapabilities(for family: Family) -> Set<ModelCapability> {
        switch family {
        case .openAI: return [.chat, .toolCalling]
        case .ollama: return [.chat, .local, .offline]
        case .lmStudio: return [.chat, .local, .offline]
        case .MiniMax: return [.chat, .toolCalling]
        case .glm: return [.chat, .toolCalling]
        case .deepSeek: return [.chat, .toolCalling]
        }
    }

    /// Common model IDs surfaced as placeholders. Users can still type a custom
    /// ID; these are just convenience hints for the "manualModelID" field.
    public static func commonModelHints(for family: Family) -> [String] {
        switch family {
        case .openAI:
            return ["gpt-4o", "gpt-4o-mini", "o4-mini", "gpt-4.1"]
        case .ollama:
            return ["qwen2.5:7b", "llama3.2:3b", "qwen3:8b", "mistral:7b"]
        case .lmStudio:
            return ["qwen2.5-7b-instruct", "llama-3.1-8b-instruct"]
        case .MiniMax:
            return ["MiniMax-Text-01", "abab6.5s-chat", "abab6.5-chat"]
        case .glm:
            return ["glm-4-plus", "glm-4-air", "glm-4-flash"]
        case .deepSeek:
            return ["deepseek-chat", "deepseek-reasoner"]
        }
    }

    /// Build a `ProviderConfig` for the family. The caller (the Quick Add UI)
    /// is expected to show the manual editor afterwards so the user can confirm
    /// the model ID, paste their API key (for cloud), and toggle `enabled`.
    public static func makeProvider(for family: Family,
                                    customName: String? = nil,
                                    baseURL: URL? = nil) -> ProviderConfig? {
        guard let url = baseURL ?? defaultBaseURL(for: family) else { return nil }
        return ProviderConfig(displayName: customName ?? family.displayName,
                             type: family.providerType,
                             baseURL: url,
                             enabled: false,
                             capabilities: defaultCapabilities(for: family))
    }
}