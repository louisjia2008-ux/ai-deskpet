import Foundation

/// P18 §16 — Bundle-ID based sensitive-app classifier.
///
/// Conservative defaults: known password managers, keychain UI, and any
/// bundle-ID substring matching `sensitiveSubstrings`. Substring matches are
/// intentionally high-precision to avoid false-positive suppression of
/// developer / OS 2FA tooling (Authy, Auth0 CLI, authenticationservices
/// framework, etc.). The user can edit the list in Settings; the defaults
/// are loaded at service init.
public struct SensitiveAppPolicy: Sendable, Equatable, Codable {

    public var sensitiveBundleIDs: Set<String>
    public var sensitiveSubstrings: [String]

    public init(sensitiveBundleIDs: Set<String> = SensitiveAppPolicy.defaultSensitiveBundleIDs,
                sensitiveSubstrings: [String] = SensitiveAppPolicy.defaultSensitiveSubstrings) {
        self.sensitiveBundleIDs = sensitiveBundleIDs
        self.sensitiveSubstrings = sensitiveSubstrings
    }

    /// Conservative defaults — password managers + keychain UI + common banking substrings.
    /// Not exhaustive (cannot be). The placeholder copy in the UI is honest about this.
    public static let defaultSensitiveBundleIDs: Set<String> = [
        "com.agilebits.onepassword7",
        "com.lastpass.LastPass",
        "com.bitwarden.desktop",
        "com.1password.1password",
        "com.apple.keychainaccess",
        "com.apple.SecurityAgent",
    ]

    /// Tightened defaults — high-precision password-manager / keychain UI substrings only.
    /// The earlier list included broad tokens ("auth", "bank", "wallet") that produced
    /// widespread false positives (Authy, GoogleAuthenticator, Auth0 CLI, Authentik,
    /// Apple's `authenticationservices.framework`, `fileprovider.authorization`, banking
    /// rate-aggregator apps, investment "wallet" apps, etc.). Conservative substring
    /// matching keeps ambient context flowing for users of developer / OS 2FA tooling;
    /// users can extend the list in Settings if they want stricter behavior.
    public static let defaultSensitiveSubstrings: [String] = [
        "1password",
        "bitwarden",
        "lastpass",
        "keychain",
        "passwordvault",
        "passwordmanager",
    ]

    public func classify(bundleID: String?) -> AwarenessContextSensitivity {
        guard let bundleID else { return .unknown }
        if sensitiveBundleIDs.contains(bundleID) { return .sensitive }
        let lowered = bundleID.lowercased()
        for substring in sensitiveSubstrings {
            if lowered.contains(substring.lowercased()) { return .sensitive }
        }
        return .routine
    }

    /// Returns true if the snapshot field should be suppressed because the
    /// bundle ID maps to a known sensitive context.
    public func shouldSuppress(bundleID: String?) -> Bool {
        if !enabled { return false }
        return classify(bundleID: bundleID) == .sensitive
    }

    /// Toggle for the settings UI. Defaults to `true` (conservative).
    public var enabled: Bool = true
}

/// Placeholder copy exposed for the UI when a sensitive context is active.
/// The string is intentionally honest about the heuristic being non-exhaustive.
public enum SensitiveContextPlaceholder {
    public static let suppressedMessage = "当前应用被识别为敏感上下文，已屏蔽细节。"
    public static let detectionHonestyFooter = "敏感应用列表是保守启发式，并非穷尽；如有遗漏请在设置中补充。"
}
