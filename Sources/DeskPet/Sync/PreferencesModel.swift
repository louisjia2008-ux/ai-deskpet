import Foundation
import Combine
import AICore
import PetAgentRuntime

/// App preferences that participate in sync/backup (doc §15.1 设置). Stored in preferences.json,
/// which is itself the `.settings` backup category.
struct AppPreferences: Codable, Equatable {
    var sync = SyncPolicy()
    var permissions = PermissionPreferences()
    var companion = CompanionPreferences()
    var appearance = AppearanceAnimationPreferences()
    var toolPolicies: [String: ToolPolicyPreference] = [:]
    /// P18 — Ambient Desktop Awareness preferences. Persisted alongside the other
    /// categories but read by `DesktopAwarenessService` so the agent settings live in
    /// exactly one place. Backward-compatible default: awareness OFF the legacy
    /// default of L1 (app identity only).
    var awareness = AwarenessPreferences()
}

struct ToolPolicyPreference: Codable, Equatable, Sendable {
    var enabled: Bool

    init(enabled: Bool = true) {
        self.enabled = enabled
    }
}

enum ClipboardAccessPolicy: String, Codable, CaseIterable, Sendable, Identifiable {
    case disabled
    case askEveryTime
    case manualAllowed

    var id: String { rawValue }
    var label: String {
        switch self {
        case .disabled: return "禁用"
        case .askEveryTime: return "每次询问"
        case .manualAllowed: return "允许手动读取"
        }
    }
}

enum ProactiveIntensity: String, Codable, CaseIterable, Sendable, Identifiable {
    case off
    case low
    case medium
    case high

    var id: String { rawValue }
    var label: String {
        switch self {
        case .off: return "关闭"
        case .low: return "低"
        case .medium: return "中"
        case .high: return "高"
        }
    }
}

enum CompanionModePreference: String, Codable, CaseIterable, Sendable, Identifiable {
    case quiet
    case gentle
    case highInteraction

    var id: String { rawValue }
    var label: String {
        switch self {
        case .quiet: return "安静陪伴"
        case .gentle: return "主动轻提醒"
        case .highInteraction: return "高互动"
        }
    }
}

enum PetSizePreset: String, Codable, CaseIterable, Sendable, Identifiable {
    case small
    case normal
    case large

    var id: String { rawValue }
    var label: String {
        switch self {
        case .small: return "小"
        case .normal: return "默认"
        case .large: return "大"
        }
    }
}

enum AnimationIntensity: String, Codable, CaseIterable, Sendable, Identifiable {
    case off
    case low
    case standard

    var id: String { rawValue }
    var label: String {
        switch self {
        case .off: return "关闭"
        case .low: return "低"
        case .standard: return "标准"
        }
    }
}

struct PermissionPreferences: Codable, Equatable {
    var screenRead: CapabilityPermissionState = .notRequested
    var microphone: CapabilityPermissionState = .notRequested
    var keyboard: CapabilityPermissionState = .unavailable
    var clipboard: ClipboardAccessPolicy = .askEveryTime
    var notifications: CapabilityPermissionState = .notRequested
    var files: CapabilityPermissionState = .notRequested
    var tools: CapabilityPermissionState = .notRequested
    var memoryEnabled: Bool = true
}

struct CompanionPreferences: Codable, Equatable {
    var mode: CompanionModePreference = .quiet
    var proactiveIntensity: ProactiveIntensity = .low
    var allowInterruptions: Bool = false
}

struct AppearanceAnimationPreferences: Codable, Equatable {
    var petSize: PetSizePreset = .normal
    /// Optional so older preference files retain all existing settings.
    var characterHeight: Double? = nil
    var resolvedCharacterHeight: Double {
        let preset: Double = petSize == .small ? 160 : petSize == .large ? 360 : 240
        let value = characterHeight ?? preset
        return min(420, max(120, value.isFinite ? value : preset))
    }
    var animationIntensity: AnimationIntensity = .standard
    var avoidDock: Bool = true
    var allowIdleBreathing: Bool = true
}

/// P18 — Persisted ambient desktop awareness configuration.
///
/// Mirrors `PerceptionPolicy` (lives in `AICore`) and adds UI-side toggles that
/// are not strictly part of the perception engine (e.g. sensitive-context
/// suppression). Conversion helpers project to/from `PerceptionPolicy` so the
/// service layer can consume a single typed object.
struct AwarenessPreferences: Codable, Equatable {
    /// P18 §6 — the maximum awareness level the user has enabled.
    /// Persisted as a string so it survives enum reorders gracefully.
    var maxLevel: String = "app"   // off | app | title | screen
    var titleWhitelist: [String] = []
    /// P18 §6 LEVEL 4 — multimodal screen understanding. Deferred (no image-capable
    /// model is wired into the chat loop); persisted so the UI renders faithfully.
    var screenAnalysisEnabled: Bool = false
    /// P18 §16 — Suppress L2 (title) + L3 (screen) when the foreground bundle
    /// matches `SensitiveAppPolicy.classify(...) == .sensitive`. Defaults to true
    /// so a fresh install behaves conservatively.
    var sensitiveContextSuppressed: Bool = true

    /// Project this preference shape into the canonical `PerceptionPolicy` value.
    func toPerceptionPolicy() -> PerceptionPolicy {
        var policy = PerceptionPolicy()
        switch maxLevel {
        case "off":  policy.maxLevel = .off
        case "app":  policy.maxLevel = .app
        case "title": policy.maxLevel = .title
        case "screen": policy.maxLevel = .screen
        default:     policy.maxLevel = .app
        }
        policy.titleWhitelist = Set(titleWhitelist)
        return policy
    }

    /// Apply a `PerceptionPolicy` into this preference shape — used when the
    /// service receives a policy change from any code path.
    mutating func apply(_ policy: PerceptionPolicy) {
        switch policy.maxLevel {
        case .off:    maxLevel = "off"
        case .app:    maxLevel = "app"
        case .title:  maxLevel = "title"
        case .screen: maxLevel = "screen"
        }
        titleWhitelist = Array(policy.titleWhitelist).sorted()
    }

    static let defaultTitleWhitelistExamples: [String] = [
        "com.apple.dt.Xcode",
        "com.apple.Terminal",
        "com.microsoft.VSCode",
        "com.google.Chrome",
        "com.apple.Safari",
    ]
}

@MainActor
final class PreferencesModel: ObservableObject {
	@Published var prefs: AppPreferences { didSet { persist() } }
	@Published private(set) var lastPersistenceError: String?
    /// Session-scoped (deliberately NOT persisted): auto-approve reversible P1-P2 effects this session
    /// so the agent isn't re-prompted. Resets on relaunch. Drives the capability gate via the hook.
    @Published var autoApproveReversibleThisSession: Bool = false
    var onTrustReversibleChange: ((Bool) -> Void)?
    var onPreviewCompanionBubble: (() -> Void)?
    @Published var companionExpressions: [String] = []
    var onPreviewCompanionExpression: ((String?) -> Void)?
    var onPreviewCompanionEmotion: ((PetEmotion) -> Void)?
    private let url: URL
    /// P18.1 — APP-003 closure. Test seam: when set, the next call to
    /// `persist()` invokes this closure instead of writing to disk. The
    /// closure may throw to simulate a persistence failure. Production
    /// leaves this `nil`. Tests that need to inject failure set it
    /// temporarily and clear it afterwards.
    private var persistOverride: ((AppPreferences) throws -> Void)?

    init(fileURL: URL? = nil) {
        if let fileURL { self.url = fileURL }
        else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("DeskPet", isDirectory: true)
            try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            self.url = base.appendingPathComponent("preferences.json")
        }
        if let data = try? Data(contentsOf: url),
           // D3: sealed-aware read (keyless-sealed reads as absent → defaults;
           // bytes stay for later recovery).
           let plain = try? SealedStore.openForRead(data),
           let p = try? JSONDecoder().decode(AppPreferences.self, from: plain) {
            prefs = p
            // D3: re-seal legacy plaintext on first read when a key is wired.
            SealedStore.migratePlaintext(at: url) {
                try SealedStore.save(JSONEncoder().encode(p), to: url)
            }
        } else {
            prefs = AppPreferences()
        }
    }

    var policy: SyncPolicy { prefs.sync }
    var permissions: PermissionPreferences { prefs.permissions }
	var companion: CompanionPreferences { prefs.companion }
	var appearance: AppearanceAnimationPreferences { prefs.appearance }
	var toolPolicies: [String: ToolPolicyPreference] { prefs.toolPolicies }
    var awareness: AwarenessPreferences {
        get { prefs.awareness }
        set { prefs.awareness = newValue }
    }

    func setICloud(_ on: Bool) { prefs.sync.iCloudEnabled = on }
    func setCategory(_ c: SyncCategory, _ on: Bool) {
        if on { prefs.sync.enabled.insert(c) } else { prefs.sync.enabled.remove(c) }
    }

    func setPermission(_ keyPath: WritableKeyPath<PermissionPreferences, CapabilityPermissionState>,
                       _ state: CapabilityPermissionState) {
        prefs.permissions[keyPath: keyPath] = state
    }

    func setClipboardPolicy(_ policy: ClipboardAccessPolicy) {
        prefs.permissions.clipboard = policy
    }

    func setMemoryEnabled(_ enabled: Bool) {
        prefs.permissions.memoryEnabled = enabled
    }

    func setCompanionMode(_ mode: CompanionModePreference) {
        prefs.companion.mode = mode
    }

    func setProactiveIntensity(_ intensity: ProactiveIntensity) {
        prefs.companion.proactiveIntensity = intensity
    }

    func setAllowInterruptions(_ allow: Bool) {
        prefs.companion.allowInterruptions = allow
    }

    func setPetSize(_ size: PetSizePreset) {
        var appearance = prefs.appearance
        appearance.petSize = size
        appearance.characterHeight = nil
        prefs.appearance = appearance
    }

    func setCharacterHeight(_ height: Double) {
        guard height.isFinite else { return }
        prefs.appearance.characterHeight = min(420, max(120, height))
    }

    func setAnimationIntensity(_ intensity: AnimationIntensity) {
        prefs.appearance.animationIntensity = intensity
    }

    func setAvoidDock(_ enabled: Bool) {
        prefs.appearance.avoidDock = enabled
    }

	func setAllowIdleBreathing(_ enabled: Bool) {
	    prefs.appearance.allowIdleBreathing = enabled
	}

	func isToolEnabled(_ toolID: String) -> Bool {
	    prefs.toolPolicies[toolID]?.enabled ?? true
	}

	func setToolEnabled(_ toolID: String, _ enabled: Bool) {
	    // P18.1 — APP-003 closure. Transactional write ordering:
	    // (1) compute the candidate AppPreferences
	    // (2) attempt to persist the candidate to disk
	    // (3) only on success, assign `prefs` (whose didSet calls
	    //     persist again, which is a no-op duplicate of the same write)
	    //
	    // The previous code mutated `@Published prefs` first, which
	    // triggered the didSet → persist → disk write before any error
	    // could be detected. The subsequent `prefs = previous` revert
	    // only restored the in-memory state — disk was already
	    // inconsistent. After this fix, the candidate must persist
	    // successfully before we mutate the observable state.
	    var candidate = prefs
	    candidate.toolPolicies[toolID] = ToolPolicyPreference(enabled: enabled)
	    do {
	        let data = try JSONEncoder().encode(candidate)
	        if let override = persistOverride {
	            try override(candidate)
	        } else {
	            try SealedStore.save(data, to: url)
	        }
	        prefs = candidate
	        lastPersistenceError = nil
	    } catch {
	        // Persist failed: leave prefs unchanged (in-memory == previous
	        // durable value). Disk is also unchanged because we never
	        // wrote. After restart, init() reads the same durable value.
	        lastPersistenceError = SealedStore.describe(error, fallback: "设置保存失败")
	    }
	}

    // MARK: P18 — Ambient awareness setters

    func setAwarenessMaxLevel(_ level: String) {
        prefs.awareness.maxLevel = level
    }

    func setAwarenessTitleWhitelist(_ bundleIDs: [String]) {
        prefs.awareness.titleWhitelist = bundleIDs
    }

    func setAwarenessScreenAnalysisEnabled(_ enabled: Bool) {
        prefs.awareness.screenAnalysisEnabled = enabled
    }

    func setAwarenessSensitiveContextSuppressed(_ suppressed: Bool) {
        prefs.awareness.sensitiveContextSuppressed = suppressed
    }

    /// Current perception policy, projected from the awareness preference. Used
    /// by `DesktopAwarenessService` at init / refresh time.
    var perceptionPolicy: PerceptionPolicy {
        get { prefs.awareness.toPerceptionPolicy() }
        set { prefs.awareness.apply(newValue) }
    }

    func setTrustReversibleThisSession(_ on: Bool) {
        autoApproveReversibleThisSession = on
        onTrustReversibleChange?(on)
    }

	private func persist() {
	    do {
	        let data = try JSONEncoder().encode(prefs)
	        if let override = persistOverride {
	            try override(prefs)
	        } else {
	            try SealedStore.save(data, to: url)
	        }
	        lastPersistenceError = nil
	    } catch {
	        lastPersistenceError = SealedStore.describe(error, fallback: "设置保存失败")
	    }
	}

    // MARK: P18.1 — APP-003 test seam

    /// Set or clear the persistence override. Production never calls
    /// this; tests use it to inject persistence failures.
    func _setPersistOverrideForTests(_ handler: ((AppPreferences) throws -> Void)?) {
        persistOverride = handler
    }
}

extension PreferencesModel: ToolPolicyStore {
    nonisolated func isToolEnabled(_ toolID: ToolID) async -> Bool {
        await MainActor.run { self.isToolEnabled(toolID.rawValue) }
    }
}
