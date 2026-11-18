import XCTest
import AppKit
@testable import DeskPet
import AICore

/// P19.1 / P1 — Provider Quick Add defaults.
///
/// Per P19.1 §9, Quick Add must only surface providers DeskPet ACTUALLY
/// supports for chat (not just test-connection). This test pins the family
/// list and the per-family defaults.
@MainActor
final class P19_1ProviderQuickAddDefaultsTests: XCTestCase {

    func testFamilyListIncludesAllSixCloudProviders() {
        // P19.1 §9 — only providers whose `.openAICompatible` (or `.ollama`)
        // client has real chat wiring appear in Quick Add so the UI never
        // claims support that does not exist. P19.6 added MiniMax / GLM /
        // DeepSeek as documented OpenAI-compatible cloud providers
        // (`docs/agent_os/PROVIDER_STREAMING_PROTOCOL.md` + `docs/AGENT_FLOATING_CHAT_ARCHITECTURE.md`).
        XCTAssertEqual(ProviderQuickAddDefaults.Family.allCases.count, 6)
        let ids = Set(ProviderQuickAddDefaults.Family.allCases.map(\.rawValue))
        XCTAssertEqual(ids, ["openAI", "ollama", "lmStudio", "MiniMax", "glm", "deepSeek"])
    }

    func testOpenAIFamilyUsesOpenAICompatibleType() {
        let family = ProviderQuickAddDefaults.Family.openAI
        XCTAssertEqual(family.providerType, .openAICompatible,
                     "OpenAI surfaces as `.openAICompatible` because the production client reuses the OpenAI-compatible HTTP shape")
    }

    func testOllamaFamilyUsesOllamaType() {
        let family = ProviderQuickAddDefaults.Family.ollama
        XCTAssertEqual(family.providerType, .ollama)
    }

    func testLMStudioFamilyUsesOpenAICompatibleType() {
        // LM Studio exposes an OpenAI-compatible HTTP endpoint.
        let family = ProviderQuickAddDefaults.Family.lmStudio
        XCTAssertEqual(family.providerType, .openAICompatible)
    }

    func testDefaultBaseURLsAreCorrect() {
        XCTAssertEqual(ProviderQuickAddDefaults.defaultBaseURL(for: .openAI),
                     URL(string: "https://api.openai.com/v1"))
        XCTAssertEqual(ProviderQuickAddDefaults.defaultBaseURL(for: .ollama),
                     URL(string: "http://localhost:11434"))
        XCTAssertEqual(ProviderQuickAddDefaults.defaultBaseURL(for: .lmStudio),
                     URL(string: "http://localhost:1234/v1"))
        XCTAssertEqual(ProviderQuickAddDefaults.defaultBaseURL(for: .MiniMax),
                     URL(string: "https://api.minimaxi.com/v1"))
        XCTAssertEqual(ProviderQuickAddDefaults.defaultBaseURL(for: .glm),
                     URL(string: "https://open.bigmodel.cn/api/paas/v4"))
        XCTAssertEqual(ProviderQuickAddDefaults.defaultBaseURL(for: .deepSeek),
                     URL(string: "https://api.deepseek.com/v1"))
    }

    func testNewCloudProvidersUseOpenAICompatibleType() {
        // P19.6 — MiniMax, GLM, DeepSeek all speak the OpenAI-compatible
        // HTTP shape, so they route through the same `.openAICompatible`
        // client that OpenAI uses. This means they have full chat wiring.
        XCTAssertEqual(ProviderQuickAddDefaults.Family.MiniMax.providerType, .openAICompatible)
        XCTAssertEqual(ProviderQuickAddDefaults.Family.glm.providerType, .openAICompatible)
        XCTAssertEqual(ProviderQuickAddDefaults.Family.deepSeek.providerType, .openAICompatible)
    }

    func testNewCloudProvidersAreNotMarkedLocal() {
        // MiniMax, GLM, DeepSeek are cloud providers — they must NOT advertise
        // the `.local` capability (which is reserved for Ollama / LM Studio).
        XCTAssertFalse(ProviderQuickAddDefaults.defaultCapabilities(for: .MiniMax).contains(.local))
        XCTAssertFalse(ProviderQuickAddDefaults.defaultCapabilities(for: .glm).contains(.local))
        XCTAssertFalse(ProviderQuickAddDefaults.defaultCapabilities(for: .deepSeek).contains(.local))
    }

    func testNewCloudProvidersHaveToolCalling() {
        // P19.6 — MiniMax, GLM, DeepSeek support tool calling so they can
        // route agent tasks through them. The Quick Add capability badges
        // surface this.
        XCTAssertTrue(ProviderQuickAddDefaults.defaultCapabilities(for: .MiniMax).contains(.toolCalling))
        XCTAssertTrue(ProviderQuickAddDefaults.defaultCapabilities(for: .glm).contains(.toolCalling))
        XCTAssertTrue(ProviderQuickAddDefaults.defaultCapabilities(for: .deepSeek).contains(.toolCalling))
    }

    func testCapabilitiesAreNotEmptyForAnyFamily() {
        for family in ProviderQuickAddDefaults.Family.allCases {
            let caps = ProviderQuickAddDefaults.defaultCapabilities(for: family)
            XCTAssertFalse(caps.isEmpty, "P19.1 — \(family.displayName) must advertise at least one capability")
            XCTAssertTrue(caps.contains(.chat), "\(family.displayName) must support chat")
        }
    }

    func testOllamaAndLMStudioAreMarkedLocal() {
        XCTAssertTrue(ProviderQuickAddDefaults.defaultCapabilities(for: .ollama).contains(.local))
        XCTAssertTrue(ProviderQuickAddDefaults.defaultCapabilities(for: .lmStudio).contains(.local))
        XCTAssertFalse(ProviderQuickAddDefaults.defaultCapabilities(for: .openAI).contains(.local),
                       "OpenAI cloud is NOT local — must not advertise the local capability")
    }

    func testCommonModelHintsAreNonEmpty() {
        for family in ProviderQuickAddDefaults.Family.allCases {
            let hints = ProviderQuickAddDefaults.commonModelHints(for: family)
            XCTAssertFalse(hints.isEmpty, "P19.1 — \(family.displayName) must surface at least one model hint")
        }
    }

    func testMakeProviderBuildsValidConfig() {
        for family in ProviderQuickAddDefaults.Family.allCases {
            let config = ProviderQuickAddDefaults.makeProvider(for: family)
            XCTAssertNotNil(config, "\(family.displayName) must produce a ProviderConfig")
            XCTAssertEqual(config?.type, family.providerType)
            XCTAssertFalse(config?.enabled ?? true,
                          "P19.1 — Quick Add configs must default to disabled so the user explicitly enables after key entry")
        }
    }

    func testMakeProviderHonoursCustomName() {
        let config = ProviderQuickAddDefaults.makeProvider(for: .openAI, customName: "我的 OpenAI")
        XCTAssertEqual(config?.displayName, "我的 OpenAI")
    }
}

/// P19.1 / P1 — Ollama semantic audit + migration.
///
/// Per P19.1 §10, the two Ollama entries that share `localhost:11434` are
/// NOT a true duplicate (different IDs, different ownership semantics), but
/// their presentation must be unified so users can tell them apart. We
/// preserve internal identity and migrate the display name from the legacy
/// "Automation Ollama" to the new "本地 Ollama（自动化使用）".
@MainActor
final class P19_1OllamaSemanticAuditTests: XCTestCase {

    func testFreshInstallSeedsOllamaLocalButNotAutomation() {
        // The seed defaults to a single user-facing "Ollama 本地" entry on
        // a fresh install. The automation entry is only added by the DEBUG
        // harness (`configureAutomationOllama(modelID:)`), never by the seed.
        let dir = tempDir()
        let url = dir.appendingPathComponent("providers.json")
        let store = ProviderStore(fileURL: url)
        XCTAssertEqual(store.providers.count, 1,
                      "Fresh install must seed exactly one Ollama entry (the user-facing one)")
        XCTAssertEqual(store.providers.first?.displayName, "Ollama 本地")
        XCTAssertEqual(store.providers.first?.type, .ollama)
        XCTAssertEqual(store.providers.first?.baseURL.absoluteString, "http://localhost:11434")
    }

    func testAutomationOllamaPreservesInternalIdentity() {
        // P19.1 §10 — the automation Ollama entry keeps its internal ID
        // `automation.ollama` because tests pin it and routing keys on it.
        // The display name is updated so users can tell it apart from the
        // user-facing entry.
        let dir = tempDir()
        let url = dir.appendingPathComponent("providers.json")
        let store = ProviderStore(fileURL: url)
        let returnedID = store.configureAutomationOllama(modelID: "qwen3:8b")
        XCTAssertEqual(returnedID, "automation.ollama",
                      "P19.1 §10 — automation Ollama's internal ID must remain `automation.ollama`")
        let automationEntry = store.providers.first { $0.id == "automation.ollama" }
        XCTAssertNotNil(automationEntry)
        XCTAssertEqual(automationEntry?.displayName, "本地 Ollama（自动化使用）",
                      "P19.1 §10 — automation Ollama's display name must be `本地 Ollama（自动化使用）`")
    }

    func testMigrationRenamesLegacyAutomationOllamaDisplayName() {
        // P19.1 §10 — installs that persisted a pre-P19.1 providers.json with
        // `"Automation Ollama"` must be migrated to `本地 Ollama（自动化使用）`
        // on load, so users see the new label without manual intervention.
        //
        // Date format note: Swift's JSONDecoder uses `Double` (seconds since
        // 2001-01-01 UTC) by default, NOT ISO 8601. We therefore encode the
        // created/updated timestamps via a custom Encoder in `ProviderStore`,
        // but for this test we use the same double format so the file decodes
        // cleanly. (`ProviderStoreSnapshot` itself only persists these for
        // future forensics; the migration does not touch them.)
        let dir = tempDir()
        let url = dir.appendingPathComponent("providers.json")
        let createdAt = 767376000.0 // 2025-04-01 00:00:00 UTC, encoded as seconds since reference date
        let updatedAt = createdAt
        let legacy = """
        {
          "providers": [
            {
              "id": "automation.ollama",
              "displayName": "Automation Ollama",
              "type": "ollama",
              "baseURL": "http://localhost:11434",
              "enabled": true,
              "capabilities": ["chat", "local", "offline"],
              "createdAt": \(createdAt),
              "updatedAt": \(updatedAt)
            }
          ],
          "modelsByProviderID": {},
          "defaults": {},
          "statuses": {}
        }
        """
        let data = legacy.data(using: .utf8)!
        try! data.write(to: url)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path),
                     "Setup: file must exist before constructing ProviderStore. url=\(url.path)")
        let store = ProviderStore(fileURL: url)
        XCTAssertNil(store.lastLoadCorruptionURL,
                    "P19.1 — the JSON file must decode cleanly. Quarantine=\(String(describing: store.lastLoadCorruptionURL))")
        XCTAssertEqual(store.providers.first?.id, "automation.ollama",
                      "P19.1 §10 — migration must NOT change the internal ID. providers=\(store.providers.map(\.displayName))")
        XCTAssertEqual(store.providers.first?.displayName, "本地 Ollama（自动化使用）",
                      "P19.1 §10 — migration must rename Automation Ollama → 本地 Ollama（自动化使用）")
    }

    func testMigrationDoesNotTouchOtherProviders() {
        let dir = tempDir()
        let url = dir.appendingPathComponent("providers.json")
        let createdAt = 767376000.0
        let legacy = """
        {
          "providers": [
            {
              "id": "openai-main",
              "displayName": "OpenAI Main",
              "type": "openAICompatible",
              "baseURL": "https://api.openai.com/v1",
              "enabled": true,
              "capabilities": ["chat"],
              "createdAt": \(createdAt),
              "updatedAt": \(createdAt)
            }
          ],
          "modelsByProviderID": {},
          "defaults": {},
          "statuses": {}
        }
        """
        try! legacy.data(using: .utf8)!.write(to: url)
        let store = ProviderStore(fileURL: url)
        XCTAssertNil(store.lastLoadCorruptionURL,
                    "Setup: file must decode cleanly. Quarantine=\(String(describing: store.lastLoadCorruptionURL))")
        XCTAssertEqual(store.providers.first?.displayName, "OpenAI Main",
                      "Migration must NOT rename unrelated provider entries. providers=\(store.providers.map(\.displayName))")
    }

    // MARK: - Helpers

    private func tempDir() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("p19_1_ollama_audit_\(UUID().uuidString)",
                                    isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}