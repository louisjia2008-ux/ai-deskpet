import Foundation

/// P18 §17 — Self-exclusion policy.
///
/// When DeskPet is the foreground app (i.e. `NSWorkspace.shared.frontmostApplication?.bundleIdentifier`
/// matches `ownBundleIdentifier`), the agent doesn't observe itself. We retain the
/// last foreground app that was NOT DeskPet and publish it as the "last meaningful
/// external context". The snapshot sets `selfExclusionActive = true` so the UI /
/// agent can tell whether the value is real-time or memory.
public struct SelfExclusionPolicy: Sendable, Equatable, Codable {

    public var ownBundleIdentifier: String?
    public private(set) var lastMeaningfulExternalContext: ForegroundApplicationContext?

    public init(ownBundleIdentifier: String?) {
        self.ownBundleIdentifier = ownBundleIdentifier
        self.lastMeaningfulExternalContext = nil
    }

    public mutating func setOwnBundleIdentifier(_ id: String?) {
        ownBundleIdentifier = id
    }

    /// True when DeskPet itself is the foreground application. Bundle IDs are
    /// compared case-insensitively. Nil is treated as not-DeskPet (defensive
    /// default — we cannot exclude what we cannot identify).
    public func isSelfExcluded(frontmostBundleID: String?) -> Bool {
        guard let frontmostBundleID,
              let own = ownBundleIdentifier else { return false }
        return frontmostBundleID.caseInsensitiveCompare(own) == .orderedSame
    }

    /// Compute the foreground context to publish given the live foreground app
    /// and the running exclusion policy. When self-excluded, fall back to the
    /// last meaningful external context; return `nil` (with `selfExclusionActive
    /// = true`) when no external memory exists yet so the UI can render the
    /// neutral "当前应用感知已开启" fallback instead of leaking "DeskPet" as
    /// `frontmostApp` into the agent prompt.
    public func resolve(currentFrontmost: ForegroundApplicationContext?,
                        now: Date = Date()) -> (context: ForegroundApplicationContext?, selfExclusionActive: Bool) {
        guard let currentFrontmost else {
            return (nil, false)
        }
        if isSelfExcluded(frontmostBundleID: currentFrontmost.bundleIdentifier) {
            if let last = lastMeaningfulExternalContext {
                return (last, true)
            }
            // R1-6 — no external memory yet: publish `nil` (not a "DeskPet"
            // placeholder) so the model never sees `frontmostApp = "DeskPet"`
            // and the chip can render the neutral fallback.
            return (nil, true)
        }
        return (currentFrontmost, false)
    }

    /// Update the "last meaningful external" memory when a non-DeskPet app is foreground.
    public mutating func recordMeaningfulExternal(_ context: ForegroundApplicationContext) {
        // Don't record DeskPet-originated contexts.
        if isSelfExcluded(frontmostBundleID: context.bundleIdentifier) { return }
        lastMeaningfulExternalContext = context
    }

    /// Drop the external memory (used on sleep/wake + permission revocation).
    public mutating func clearLastMeaningfulExternal() {
        lastMeaningfulExternalContext = nil
    }
}
