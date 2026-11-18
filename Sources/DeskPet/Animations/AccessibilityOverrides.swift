import SwiftUI

// P22 — User-overridable accessibility preferences.
//
// SwiftUI's built-in `\.accessibilityReduceMotion` and
// `\.accessibilityReduceTransparency` come from the *system* settings and
// are *read-only* environment values — SwiftUI rejects any attempt to
// override them down the tree. Tests, screenshot harnesses, and reviewers
// occasionally need to force a specific state without touching System
// Settings, so this file exposes:
//   * `\.effectiveReduceMotion` / `\.effectiveReduceTransparency` —
//     EnvironmentKey-based custom values that downstream views should
//     read in preference to the system values. `applyAccessibilityOverrides()`
//     writes them on the way down the tree.
//   * `AccessibilityPreferences` — an `ObservableObject` that owns the
//     `@AppStorage`-backed override switches.
//
// Keys (UserDefaults):
//   - "accessibility.forceReduceMotion"        : Bool
//   - "accessibility.forceReduceTransparency"  : Bool
//   - "accessibility.overrideSystemSettings"   : Bool (master switch)

import SwiftUI

private enum AccessibilityOverrideKey {
    static let forceReduceMotion = "accessibility.forceReduceMotion"
    static let forceReduceTransparency = "accessibility.forceReduceTransparency"
    static let overrideSystemSettings = "accessibility.overrideSystemSettings"
}

// MARK: - Effective environment values (overridable)

private struct EffectiveReduceMotionKey: EnvironmentKey {
    static let defaultValue: Bool? = nil
}

private struct EffectiveReduceTransparencyKey: EnvironmentKey {
    static let defaultValue: Bool? = nil
}

extension EnvironmentValues {
    /// `nil` = follow system setting. `true` / `false` = override. Views
    /// should consult this *before* `accessibilityReduceMotion`.
    var effectiveReduceMotion: Bool? {
        get { self[EffectiveReduceMotionKey.self] }
        set { self[EffectiveReduceMotionKey.self] = newValue }
    }

    var effectiveReduceTransparency: Bool? {
        get { self[EffectiveReduceTransparencyKey.self] }
        set { self[EffectiveReduceTransparencyKey.self] = newValue }
    }
}

extension View {
    /// Resolve reduce-motion / reduce-transparency, preferring the in-app
    /// override when set. Returns a snapshot computed from the current
    /// `EnvironmentValues` (which the view has already captured via
    /// `@Environment(\.…)`). Use this inside `body` so the in-app override
    /// panel is respected.
    func resolveAccessibility(env: EnvironmentValues) -> ResolvedAccessibility {
        ResolvedAccessibility(
            reduceMotion: env.effectiveReduceMotion ?? env.accessibilityReduceMotion,
            reduceTransparency: env.effectiveReduceTransparency ?? env.accessibilityReduceTransparency
        )
    }
}

/// Snapshot of the user's effective accessibility preferences.
struct ResolvedAccessibility {
    let reduceMotion: Bool
    let reduceTransparency: Bool
}

// MARK: - View modifier that pushes the override down the tree

extension View {
    /// Apply the user's accessibility override on top of the system values.
    /// When `overrideSystemSettings` is true the in-app values win; otherwise
    /// the values are `nil` (which resolves to the system setting).
    @ViewBuilder
    func applyAccessibilityOverrides() -> some View {
        modifier(AccessibilityOverrideModifier())
    }
}

private struct AccessibilityOverrideModifier: ViewModifier {
    @AppStorage(AccessibilityOverrideKey.overrideSystemSettings) private var overrideSystem: Bool = false
    @AppStorage(AccessibilityOverrideKey.forceReduceMotion) private var forceReduceMotion: Bool = false
    @AppStorage(AccessibilityOverrideKey.forceReduceTransparency) private var forceReduceTransparency: Bool = false

    func body(content: Content) -> some View {
        content
            .environment(\.effectiveReduceMotion,
                         overrideSystem ? forceReduceMotion : nil)
            .environment(\.effectiveReduceTransparency,
                         overrideSystem ? forceReduceTransparency : nil)
    }
}

// MARK: - ObservableObject wrapper for the override toggles

@MainActor
final class AccessibilityPreferences: ObservableObject {
    // P22 — `@Published` only. The previous version used `didSet { UserDefaults.set… }`
    // which double-wrote the same value during `init` (the @Published default
    // assignment fired didSet, writing the value we just read from UserDefaults).
    // We now subscribe to `objectWillChange` once at init time and persist on
    // every actual change, skipping the init-time round-trip.
    @Published var overrideSystem: Bool
    @Published var forceReduceMotion: Bool
    @Published var forceReduceTransparency: Bool

    private var persistCancellable: AnyCancellable?
    private var suppressFirstChange = true

    init() {
        let defaults = UserDefaults.standard
        if defaults.object(forKey: AccessibilityOverrideKey.overrideSystemSettings) == nil {
            defaults.set(false, forKey: AccessibilityOverrideKey.overrideSystemSettings)
        }
        if defaults.object(forKey: AccessibilityOverrideKey.forceReduceMotion) == nil {
            defaults.set(false, forKey: AccessibilityOverrideKey.forceReduceMotion)
        }
        if defaults.object(forKey: AccessibilityOverrideKey.forceReduceTransparency) == nil {
            defaults.set(false, forKey: AccessibilityOverrideKey.forceReduceTransparency)
        }
        self.overrideSystem = defaults.bool(forKey: AccessibilityOverrideKey.overrideSystemSettings)
        self.forceReduceMotion = defaults.bool(forKey: AccessibilityOverrideKey.forceReduceMotion)
        self.forceReduceTransparency = defaults.bool(forKey: AccessibilityOverrideKey.forceReduceTransparency)

        // The first emission is the initial-load broadcast from `init` (no
        // user action yet). Skip it; every emission after that is a real
        // toggle and gets persisted.
        self.persistCancellable = objectWillChange.sink { [weak self] in
            guard let self else { return }
            if self.suppressFirstChange {
                self.suppressFirstChange = false
                return
            }
            // objectWillChange fires *before* the value mutates, so dispatch
            // the write asynchronously to capture the new value.
            DispatchQueue.main.async {
                let defaults = UserDefaults.standard
                defaults.set(self.overrideSystem,
                             forKey: AccessibilityOverrideKey.overrideSystemSettings)
                defaults.set(self.forceReduceMotion,
                             forKey: AccessibilityOverrideKey.forceReduceMotion)
                defaults.set(self.forceReduceTransparency,
                             forKey: AccessibilityOverrideKey.forceReduceTransparency)
            }
        }
    }
}

import Combine
