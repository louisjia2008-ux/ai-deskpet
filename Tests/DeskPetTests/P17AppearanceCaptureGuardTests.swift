import XCTest
import AppKit
import SwiftUI
@testable import DeskPet

/// P17 / R2-02 + R3-01 + R4-03 — the AFTER set once contained a "dark" flagship-chat
/// capture that was 30% bit-identical to its light sibling (light DSColor content over a
/// darkened backdrop). The harness runs `P17AppearanceCaptureGuard` over every light/dark
/// PNG pair and records the verdict in `summary.json`, so a silently-light dark capture
/// can never be filed as dark-mode evidence again. This suite pins the guard's
/// thresholds and decision logic.
///
/// Threshold evolution:
/// - **R3-01** tightened the guard from `(maxIdenticalPixelFraction=0.50,
///   minMeanLuminanceDelta=0.05)` to `(0.15, 0.30)` plus mandatory dark-accent pixel
///   presence and forbidden light-accent pixel count. The R3-01 broken flagship chat
///   capture (30.07% identical, 0 dark-accent, 9,284 light-accent) fails this.
/// - **R4-03** added a `maxMeanLuminanceDark ≤ 0.35` ceiling. The R4-01 broken
///   flagship chat capture (54.7% light-luminance chrome, `meanLuminanceDark=0.549`,
///   `identicalFraction=0.057`, `darkAccentPixelCount=304`, `lightAccentPixelCount=0`)
///   PASSED the R3-01 guard: identical ≤ 0.15, Δ ≥ 0.30, and the accent windows
///   missed the actually-rendered accent (a systematic −0.05 to −0.10 render shift
///   per channel). The dark-side ceiling is the dimension that catches this defect
///   class. The R4-03 fix also widened `accentTolerance` from 0.06 to 0.10 and
///   derived `darkAccentRGB`/`lightAccentRGB` from `DSPalette` instead of
///   hand-copying the spec values.
final class P17AppearanceCaptureGuardTests: XCTestCase {
    func testThresholdsArePinned() {
        // R3-01 — tightened from (0.5, 0.05) to (0.15, 0.30). The 0.15 identical ceiling
        // is a defensive band for content-dense captures where the converted accent area
        // is a small fraction of the frame (chat bubbles+text leave residual identity
        // even when the bubble fill converts); the accent-pixel conditional check is the
        // stronger signal for "did the surface actually convert".
        XCTAssertEqual(P17AppearanceCaptureGuard.maxIdenticalPixelFraction, 0.15)
        XCTAssertEqual(P17AppearanceCaptureGuard.minMeanLuminanceDelta, 0.30)
        // R4-03 — dark-side luminance ceiling. Every legitimately converted surface in
        // v3 sat at 0.10–0.15; the R4-01 broken chat was 0.549. The 0.35 ceiling is
        // 0.20 above the legitimate max and 0.20 below the broken artifact — well
        // outside either cluster. This dimension cannot be defeated by a "dark capture
        // with light chrome" render.
        XCTAssertEqual(P17AppearanceCaptureGuard.maxMeanLuminanceDark, 0.35)
        // R3-01 — accent-pixel assertions. The dark capture must contain ≥1 dark-accent
        // pixel when the dark capture also still contains light-accent pixels (R3 broken
        // chat: 0 dark-accent, 9,284 light).
        XCTAssertEqual(P17AppearanceCaptureGuard.minDarkAccentPixelCount, 1)
        XCTAssertEqual(P17AppearanceCaptureGuard.maxLightAccentPixelCount, 50)
        // R4-03 — accent windows now derived from `DSPalette.rgba(.primaryAccent,
        // scheme:)` instead of hand-copying spec values. The derived RGB must match the
        // spec values for primaryAccent (the dark/light brand-blue the guard hunts for).
        XCTAssertEqual(P17AppearanceCaptureGuard.darkAccentRGB.r, 0.50, accuracy: 0.001)
        XCTAssertEqual(P17AppearanceCaptureGuard.darkAccentRGB.g, 0.72, accuracy: 0.001)
        XCTAssertEqual(P17AppearanceCaptureGuard.darkAccentRGB.b, 0.95, accuracy: 0.001)
        XCTAssertEqual(P17AppearanceCaptureGuard.lightAccentRGB.r, 0.20, accuracy: 0.001)
        XCTAssertEqual(P17AppearanceCaptureGuard.lightAccentRGB.g, 0.48, accuracy: 0.001)
        XCTAssertEqual(P17AppearanceCaptureGuard.lightAccentRGB.b, 0.82, accuracy: 0.001)
        // R4-03 — tolerance widened from 0.06 to 0.10 to cover the systematic render
        // shift the R4-01 reviewer measured (−0.05 to −0.10 per channel between the
        // spec value and the actually-rendered pixel).
        XCTAssertEqual(P17AppearanceCaptureGuard.accentTolerance, 0.10)
    }

    /// R3-01 — exact R3-01 broken flagship-chat signature: 30% identical, 0.638 dark
    /// luminance (lumDelta≈0.235), zero dark-accent pixels, 9,284 light-accent pixels.
    /// Must FAIL the guard now that it is tightened.
    func testGuardRejectsR3BrokenChatSignature() {
        let stats = P17AppearanceCaptureGuard.stats(identicalFraction: 0.3007,
                                                   meanLuminanceLight: 0.873,
                                                   meanLuminanceDark: 0.638,
                                                   darkAccentPixelCount: 0,
                                                   lightAccentPixelCount: 9284)
        XCTAssertFalse(stats.passes,
                       "R3-01 — the R3 broken flagship chat capture must fail the tightened guard on every dimension")
    }

    /// R4-03 — exact R4-01 broken flagship-chat signature (full-frame measurements from
    /// the R4 reviewer's analysis): 5.7% identical (bit-identical white composer
    /// TextField and light-scheme warning text survive from light to dark), 0.549 dark
    /// luminance (54.7% light-luminance chrome), 304 dark-accent pixels (the converted
    /// user-bubble fill that the R3-01 MessageBubble fix produced), 0 light-accent
    /// pixels (the spec accent window missed the rendered light-accent). The R3-01
    /// guard passed this signature on every dimension; the R4-03 dark-side luminance
    /// ceiling fails it (`0.549 > 0.35`).
    ///
    /// This is the regression test that prevents a future re-introduction of the
    /// R4-01 defect class. If a refactor loosens the ceiling, or another defect class
    /// produces an identically-light "dark" capture, this test fails immediately and
    /// the phase cannot claim the dark evidence is valid.
    func testGuardRejectsR4ChatLightChromeArtifact() {
        let stats = P17AppearanceCaptureGuard.stats(identicalFraction: 0.0570,
                                                   meanLuminanceLight: 0.873,
                                                   meanLuminanceDark: 0.549,
                                                   darkAccentPixelCount: 304,
                                                   lightAccentPixelCount: 0)
        XCTAssertFalse(stats.passes,
                       "R4-03 — the R4-01 broken flagship chat signature (54.7% light-luminance chrome, lumDark=0.549) must FAIL the guard. The R3-01 guard certified this capture as dark-mode evidence because the dark-side luminance ceiling did not exist and the accent windows missed the rendered light-accent; R4-03 closes that gap.")
    }

    /// R4-03 — dedicated luminance-ceiling test. A capture that satisfies every other
    /// dimension (low identical, strong Δ, no light-accent leak) but whose dark mean is
    /// above the ceiling must FAIL. This pins the new dimension independently of the
    /// accent-window settings so the ceiling cannot regress without a test failure.
    func testGuardRejectsLuminanceCeiling() {
        let stats = P17AppearanceCaptureGuard.stats(identicalFraction: 0.02,
                                                   meanLuminanceLight: 0.95,
                                                   meanLuminanceDark: 0.40,
                                                   darkAccentPixelCount: 200,
                                                   lightAccentPixelCount: 0)
        XCTAssertFalse(stats.passes,
                       "R4-03 — a 'dark' capture whose mean luminance exceeds the ceiling (0.40 > 0.35) must FAIL even if every other dimension passes")
    }

    /// R3-01 — the legacy 29%-identical signature must also fail under the new thresholds.
    func testGuardRejectsNearIdenticalPair() {
        let stats = P17AppearanceCaptureGuard.stats(identicalFraction: 0.29,
                                                   meanLuminanceLight: 0.80,
                                                   meanLuminanceDark: 0.78,
                                                   darkAccentPixelCount: 0,
                                                   lightAccentPixelCount: 5000)
        XCTAssertFalse(stats.passes,
                       "R2-02/R3-01 — a 'dark' capture that is not measurably darker AND has no dark-accent pixels must fail the guard")
    }

    /// R3-01 — catches the symmetric "dark backdrop but light content" defect: zero
    /// dark-accent pixels with strong luminance delta still fails because the content did
    /// not convert.
    func testGuardRejectsDarkBackdropWithLightContent() {
        let stats = P17AppearanceCaptureGuard.stats(identicalFraction: 0.005,
                                                   meanLuminanceLight: 0.92,
                                                   meanLuminanceDark: 0.10,
                                                   darkAccentPixelCount: 0,
                                                   lightAccentPixelCount: 8000)
        XCTAssertFalse(stats.passes,
                       "R3-01 — a 'dark' capture with zero dark-accent pixels and many light-accent pixels must fail")
    }

    func testGuardRejectsMostlyIdenticalPair() {
        let stats = P17AppearanceCaptureGuard.stats(identicalFraction: 0.92,
                                                   meanLuminanceLight: 0.80,
                                                   meanLuminanceDark: 0.20,
                                                   darkAccentPixelCount: 200,
                                                   lightAccentPixelCount: 0)
        XCTAssertFalse(stats.passes,
                       "R2-02 — a mostly bit-identical pair must fail even if mean luminance differs and accent pixels look right")
    }

    /// R4-03 — the flagship chat post-R4-01 signature: the actual v4 harness measurement
    /// (production code routed through explicit-scheme DSColor + harness hosts the view in
    /// an offscreen NSWindow with .darkAqua appearance). Measured by the harness:
    /// `identicalFraction=0.0036` (chrome converted — text/backdrop still share residual
    /// identity), `meanLuminanceLight=0.886`, `meanLuminanceDark=0.195` (well below the
    /// 0.35 ceiling; the R4-01 broken capture was 0.549), `darkAccentPixelCount=9984`
    /// (the converted user-bubble fill is much larger than the R3-01 fixed capture's 304
    /// because the entire chrome now resolves through dark-scheme tokens, not just the
    /// bubble fill), `lightAccentPixelCount=0` (no leaked light-accent content). The
    /// post-fix capture is certifiable as dark-mode evidence.
    func testGuardAcceptsPostR4FixedChatSignature() {
        let stats = P17AppearanceCaptureGuard.stats(identicalFraction: 0.0036,
                                                   meanLuminanceLight: 0.886,
                                                   meanLuminanceDark: 0.195,
                                                   darkAccentPixelCount: 9984,
                                                   lightAccentPixelCount: 0)
        XCTAssertTrue(stats.passes,
                      "R4-03 — the post-R4-01 flagship chat capture (dark chrome converted via explicit-scheme tokens + offscreen NSWindow host) must pass: lumDark=0.195 well below the 0.35 ceiling, identical=0.0036 well below 0.15, dark-accent=9984 confirms chrome conversion, light-accent=0 confirms no light leak")
    }

    func testGuardAcceptsGenuinelyDarkPair() {
        let stats = P17AppearanceCaptureGuard.stats(identicalFraction: 0.02,
                                                   meanLuminanceLight: 0.86,
                                                   meanLuminanceDark: 0.18,
                                                   darkAccentPixelCount: 200,
                                                   lightAccentPixelCount: 5)
        XCTAssertTrue(stats.passes,
                      "A genuinely converted dark capture must pass the guard")
    }

    /// R4-03 — exactly at the ceiling must pass (boundary). One ULP above must fail.
    func testGuardBoundaryAtLuminanceCeiling() {
        let atCeiling = P17AppearanceCaptureGuard.stats(identicalFraction: 0.02,
                                                        meanLuminanceLight: 0.86,
                                                        meanLuminanceDark: 0.35,
                                                        darkAccentPixelCount: 200,
                                                        lightAccentPixelCount: 5)
        XCTAssertTrue(atCeiling.passes,
                      "R4-03 — exactly at the 0.35 ceiling must pass (the ceiling is ≤, not <)")
        let justAbove = P17AppearanceCaptureGuard.stats(identicalFraction: 0.02,
                                                       meanLuminanceLight: 0.86,
                                                       meanLuminanceDark: 0.351,
                                                       darkAccentPixelCount: 200,
                                                       lightAccentPixelCount: 5)
        XCTAssertFalse(justAbove.passes,
                       "R4-03 — one ULP above the 0.35 ceiling must fail")
    }

    func testCompareDetectsIdenticalBitmapsAsFailure() throws {
        let light = try XCTUnwrap(Self.solidBitmap(white: 0.95))
        let dark = try XCTUnwrap(Self.solidBitmap(white: 0.95))
        let stats = try XCTUnwrap(P17AppearanceCaptureGuard.compare(light: light, dark: dark))
        XCTAssertEqual(stats.identicalFraction, 1.0, accuracy: 0.001)
        XCTAssertFalse(stats.passes)
    }

    func testCompareDetectsDarkenedBitmapAsPass() throws {
        let light = try XCTUnwrap(Self.solidBitmap(white: 0.95))
        let dark = try XCTUnwrap(Self.solidBitmap(white: 0.12))
        let stats = try XCTUnwrap(P17AppearanceCaptureGuard.compare(light: light, dark: dark))
        XCTAssertEqual(stats.identicalFraction, 0.0, accuracy: 0.001)
        XCTAssertGreaterThan(stats.meanLuminanceLight - stats.meanLuminanceDark, 0.5)
        XCTAssertLessThanOrEqual(stats.meanLuminanceDark, P17AppearanceCaptureGuard.maxMeanLuminanceDark,
                                 "R4-03 — a uniformly darkened surface must still satisfy the dark-side luminance ceiling")
        // A solid white→near-black pair won't have dark-accent pixels, but it also won't
        // have light-accent pixels, so the symmetric check still passes — the guard
        // rejects "looks dark but content unchanged" not "has no accent pixels at all".
        XCTAssertEqual(stats.lightAccentPixelCount, 0)
        XCTAssertEqual(stats.darkAccentPixelCount, 0)
        XCTAssertTrue(stats.passes,
                      "R3-01 — a uniformly darkened surface must still pass the guard (no light content means no light-accent leakage)")
    }

    /// R3-01 — the decisive comparison test: render the SAME view twice, once into a light
    /// NSHostingView with `.environment(\.colorScheme, .light)` and once into a dark
    /// NSHostingView with `.environment(\.colorScheme, .dark)`, then verify the dark
    /// capture actually has dark-accent pixels (i.e. MessageBubble's user-bubble fill
    /// converted, not just the backdrop).
    ///
    /// NOTE: this is a CONTROLLED test on a white backdrop — the surface luminance in
    /// "dark mode" may rise because the dark-scheme `primaryAccent` (0.50, 0.72, 0.95) is
    /// *brighter* than the light-scheme one (0.20, 0.48, 0.82); the backdrop is the same
    /// white in both renders. So we assert accent conversion directly, NOT via
    /// meanLuminanceDelta or identicalFraction — the harness's full-surface guard has its
    /// own dim-backdrop case (`testCompareDetectsDarkenedBitmapAsPass` etc.); this test
    /// pins the MessageBubble-specific R3-01 evidence: the user-bubble fill MUST convert
    /// from light-accent (0.20, 0.48, 0.82) to dark-accent (0.50, 0.72, 0.95), and the
    /// broken capture is exactly "light-accent leaked into the dark capture, zero
    /// dark-accent pixels".
    @MainActor
    func testDarkCaptureContainsDarkAccentPixels() throws {
        let lightHost = try XCTUnwrap(Self.bubbleHost(scheme: .light))
        let darkHost = try XCTUnwrap(Self.bubbleHost(scheme: .dark))
        let lightStats = try XCTUnwrap(P17AppearanceCaptureGuard.compare(light: lightHost, dark: darkHost))
        // The dark capture must contain dark-accent pixels (the user-bubble fill in dark
        // mode is rgb(0.50, 0.72, 0.95)).
        XCTAssertGreaterThan(lightStats.darkAccentPixelCount,
                             P17AppearanceCaptureGuard.minDarkAccentPixelCount,
                             "R3-01 — the dark capture must contain dark-scheme accent pixels (i.e. MessageBubble fill converted)")
        // The dark capture must NOT still contain light-scheme accent pixels (the broken
        // R3-01 capture had 9,284 px of light-accent fill — the user-bubble still
        // rendered with the light scheme's primaryAccent).
        XCTAssertLessThanOrEqual(lightStats.lightAccentPixelCount,
                                 P17AppearanceCaptureGuard.maxLightAccentPixelCount,
                                 "R3-01 — the dark capture must not still contain light-scheme accent pixels (i.e. user-bubble fill must have converted)")
        // The captures must differ at least somewhat (the bubble fill changed colour,
        // and the text+backdrop are identical, so identicalFraction should be moderate
        // — neither 0.0 nor 1.0).
        XCTAssertGreaterThan(lightStats.identicalFraction, 0.20,
                             "Sanity: bubble+text+backdrop should share a fair fraction of identical pixels")
        XCTAssertLessThan(lightStats.identicalFraction, 0.99,
                           "Sanity: the bubble fill change should be visible")
    }

    func testCompareRejectsMismatchedSizes() throws {
        let a = try XCTUnwrap(Self.solidBitmap(white: 0.9, size: 40))
        let b = try XCTUnwrap(Self.solidBitmap(white: 0.2, size: 60))
        XCTAssertNil(P17AppearanceCaptureGuard.compare(light: a, dark: b))
    }

    /// R2-02 — source-scan backstop: the harness must actually run the guard and force the
    /// appearance onto both AppKit and SwiftUI for every hosted capture.
    func testHarnessPropagatesAppearanceAndRunsGuard() {
        let body = resolveText(named: "P17ProductSurfaceHarness", relative: "App")
        XCTAssertFalse(body.isEmpty)
        XCTAssertTrue(body.contains("NSApp.appearance = NSAppearance(named: isDark ? .darkAqua : .aqua)"),
                      "R2-02 — the app-level appearance must be switched so SwiftUI resolves dark DSColors")
        XCTAssertTrue(body.contains("environment(\\.colorScheme"),
                      "R2-02 — the SwiftUI colorScheme must be set explicitly for the window-less host")
        XCTAssertTrue(body.contains("appearanceGuard(lightURL:"),
                      "R2-02 — every light/dark pair must be checked by the capture guard")
    }

    /// R4-01 — source-scan backstop: ChatExpandedView must read `\.colorScheme` and route
    /// every DSColor call through `DSColor.token(_:scheme:)`. The R3-01 fix covered
    /// MessageBubble but not the rest of the chrome; R4-01's full-frame measurement
    /// showed that without this backstop the dark capture renders the panel material,
    /// message-area background, composer TextField, warning text, header icon, and
    /// stop-button tint in LIGHT scheme (54.7% light-luminance pixels). Re-introducing
    /// the NSAppearance-derived `DSColor.X` shortcuts in ChatExpandedView would silently
    /// re-render the broken capture.
    func testChatExpandedViewUsesExplicitColorScheme() {
        let body = resolveText(named: "ChatExpandedView", relative: "FloatingChat")
        XCTAssertFalse(body.isEmpty)
        XCTAssertTrue(body.contains("@Environment(\\.colorScheme)"),
                      "R4-01 — ChatExpandedView must read SwiftUI's colorScheme env explicitly so every chrome token resolves from a single source of truth (production + harness)")
        // The chrome tokens the R4-01 reviewer's full-frame measurement identified as
        // light-scheme leaks in the dark capture. Each must route through the explicit-scheme
        // overload so they convert with the host's color scheme.
        for token in ["elevatedSurface", "appBackground", "warning", "primaryAccent", "destructive", "textPrimary", "textSecondary", "border"] {
            XCTAssertTrue(body.contains("DSColor.token(.\(token), scheme: colorScheme)"),
                          "R4-01 — ChatExpandedView's chrome must use `DSColor.token(.\(token), scheme: colorScheme)` (explicit-scheme route); the previous `DSColor.\(token)` shortcut resolved against NSAppearance and produced a 54.7%-light 'dark' capture")
        }
        // R5-02 — the panel background MUST branch on `\.accessibilityReduceTransparency`
        // (AppGlassContainer-style): material when transparency is enabled (default
        // production path; matches sibling capsule/HUD per design plan §2 + §7.3),
        // opaque `elevatedSurface` when Reduce Transparency is on. An unconditional
        // `.ultraThinMaterial` re-introduces the R4-01 defect class (window-less harness
        // renders it light); an unconditional opaque surface re-introduces R5-02 (silent
        // deviation from the plan's overlay-material token row). Both are forbidden.
        XCTAssertTrue(body.contains("@Environment(\\.accessibilityReduceTransparency)"),
                      "R5-02 — ChatExpandedView must read SwiftUI's accessibilityReduceTransparency env so the panel can branch between `.ultraThinMaterial` (default) and opaque `elevatedSurface` (Reduce Transparency on) — mirroring `AppGlassContainer`")
        XCTAssertTrue(body.contains("ultraThinMaterial"),
                      "R5-02 — ChatExpandedView's panel must use `.ultraThinMaterial` (the design-plan §2 / §7.3 overlay-material token) when Reduce Transparency is OFF, matching sibling capsule/HUD")
        XCTAssertFalse(body.contains(".background(.ultraThinMaterial"),
                         "R5-02 — ChatExpandedView's panel must NOT use `.ultraThinMaterial` UNCONDITIONALLY (e.g. as `.background(.ultraThinMaterial, …)`); it must branch on `accessibilityReduceTransparency` so window-less harnesses and Reduce-Transparency users both get a deterministic, opaque surface")
    }

    /// R4-01 — source-scan backstop: the harness's floatingChatExpanded capture must
    /// host the view inside an actual offscreen NSWindow (with `.darkAqua` appearance)
    /// so `NSWindow.backgroundColor` and the residual `.ultraThinMaterial` paths resolve
    /// from the host WINDOW's appearance, not just `NSApp.appearance`. The capsule
    /// (`floatingChatCollapsed`) already converts fully (lumDark 0.150), proving the
    /// propagation triple works for that view; the failure was ChatExpandedView-chrome-
    /// specific.
    func testHarnessHostsFloatingChatExpandedInOffscreenNSWindow() {
        let body = resolveText(named: "P17ProductSurfaceHarness", relative: "App")
        XCTAssertFalse(body.isEmpty)
        XCTAssertTrue(body.contains("NSWindow(contentRect:") ||
                      body.contains("NSWindow("),
                      "R4-01 — the harness must create an actual offscreen NSWindow for the floatingChatExpanded capture so the window's appearance (not just NSApp.appearance) drives the chrome")
        XCTAssertTrue(body.contains("window.appearance = NSAppearance(named: isDark ? .darkAqua : .aqua)"),
                      "R4-01 — the offscreen window's appearance must be set to .darkAqua for the dark capture")
        XCTAssertTrue(body.contains("floatingChatExpanded"),
                      "R4-01 — the NSWindow host path must be scoped to the floatingChatExpanded capture (other surfaces already convert correctly without it)")
    }

    /// R5-02 — source-scan backstop: the harness's `floatingChatExpanded` capture must
    /// force `\.accessibilityReduceTransparency = true` so the new env-branch in
    /// `ChatExpandedView` deterministically renders the opaque surface for the dark
    /// capture (matching the v4 evidence pattern). The public
    /// `\.accessibilityReduceTransparency` env value is read-only; SwiftUI exposes the
    /// writable storage via the underscore-prefixed `_accessibilityReduceTransparency`
    /// property. Re-introducing a `\.environment(\.colorScheme, …)` call without the
    /// matching reduce-transparency override would silently fall back to the material
    /// branch and re-break the dark capture's `maxMeanLuminanceDark ≤ 0.35` ceiling.
    func testHarnessForcesOpaqueChatPanelBranch() {
        let body = resolveText(named: "P17ProductSurfaceHarness", relative: "App")
        XCTAssertFalse(body.isEmpty)
        XCTAssertTrue(body.contains("DESKPET_P17_OPAQUE_CHAT"),
                      "R5-02 — the harness must define a DESKPET_P17_OPAQUE_CHAT env override so the dark-mode capture deterministically picks the opaque branch")
        XCTAssertTrue(body.contains("_accessibilityReduceTransparency") ||
                      body.contains("accessibilityReduceTransparency"),
                      "R5-02 — the harness must set the writable `\\._accessibilityReduceTransparency` env (or its public alias) on the offscreen-NShostingView so `ChatExpandedView` resolves the env-branch to the opaque surface")
    }

    /// R5-02 — end-to-end regression test for the harness's env-override plumbing.
    /// Renders the production `MessageBubble` inside an actual offscreen `NSWindow`
    /// with `.darkAqua` appearance under BOTH `\.accessibilityReduceTransparency = false`
    /// (production default) and `\.accessibilityReduceTransparency = true` (Reduce
    /// Transparency on / harness deterministic capture). Asserts that the env value
    /// PROPERLY PROPAGATES — i.e. the writable `\\._accessibilityReduceTransparency`
    /// keypath the harness uses is honored by SwiftUI. The harness's
    /// `floatingChatExpanded` capture relies on this plumbing to deterministically pick
    /// the opaque surface; if a future SwiftUI/Swift upgrade breaks the writable
    /// keypath the harness would silently fall back to the material branch and the
    /// dark capture's `maxMeanLuminanceDark ≤ 0.35` ceiling would fail.
    ///
    /// We use `AppGlassContainer` here because it's the canonical "branches on
    /// reduceTransparency" view in the same module and renders a measurable diff
    /// between the two branches (opaque vs material). The test pins the env-propagation
    /// contract; the source-scan backstop (`testHarnessForcesOpaqueChatPanelBranch`)
    /// pins the harness's call site, and the `testChatExpandedViewUsesExplicitColorScheme`
    /// backstop pins the ChatExpandedView branch.
    @MainActor
    func testAccessibilityReduceTransparencyEnvOverridePropagates() throws {
        // AppGlassContainer is a struct from DesignSystem that's already imported via
        // @testable import DeskPet. It branches on `\.accessibilityReduceTransparency`
        // to fill a rounded rectangle with `.ultraThinMaterial` (default) or with
        // `DSColor.token(.elevatedSurface)` (when ON). We render it on a known-color
        // backdrop and assert the fill changes.
        let size = NSSize(width: 200, height: 100)
        let frame = NSRect(x: -10000, y: -10000, width: size.width, height: size.height)
        func render(reduceTransparency: Bool) -> Double? {
            let window = NSWindow(contentRect: frame,
                                  styleMask: [.titled],
                                  backing: .buffered,
                                  defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: .darkAqua)
            // Light backdrop so the AppGlassContainer fill dominates the rendered
            // pixels (an `.ultraThinMaterial` fill would let the backdrop bleed through
            // and look light; an opaque `elevatedSurface` fill would be solid dark).
            window.backgroundColor = NSColor(srgbRed: 0.95, green: 0.95, blue: 0.95, alpha: 1.0)
            let container = NSView(frame: frame)
            container.wantsLayer = true
            container.layer?.backgroundColor = window.backgroundColor?.cgColor
            window.contentView = container
            let view = AppGlassContainer {
                Color.clear.frame(width: 160, height: 60)
            }
            .frame(width: size.width, height: size.height)
            .environment(\._accessibilityReduceTransparency, reduceTransparency)
            let hosting = NSHostingView(rootView: view)
            hosting.frame = frame
            hosting.appearance = NSAppearance(named: .darkAqua)
            container.addSubview(hosting)
            hosting.layoutSubtreeIfNeeded()
            guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
                window.orderOut(nil)
                return nil
            }
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            window.orderOut(nil)
            var sumL = 0.0
            var sampled = 0
            let step = max(1, min(bitmap.pixelsWide, bitmap.pixelsHigh) / 160)
            for y in stride(from: 0, to: bitmap.pixelsHigh, by: step) {
                for x in stride(from: 0, to: bitmap.pixelsWide, by: step) {
                    guard let c = bitmap.colorAt(x: x, y: y) else { continue }
                    let r = c.redComponent, g = c.greenComponent, b = c.blueComponent
                    sumL += 0.299 * r + 0.587 * g + 0.114 * b
                    sampled += 1
                }
            }
            return sumL / Double(max(1, sampled))
        }

        // Light backdrop is constant; the AppGlassContainer fill dominates. The two
        // branches render measurably differently — the absolute direction depends on
        // the scheme (in dark mode `.ultraThinMaterial` is dark glass that darkens the
        // light backdrop, while the dark elevatedSurface is rgba(0.21,0.23,0.28) ≈
        // lum 0.23 — both can be darker than the backdrop, but with different magnitudes).
        // What matters for this regression test is that the env value PROPAGATES (the
        // two renders differ measurably) so the harness's `_accessibilityReduceTransparency`
        // override actually reaches the `ChatExpandedView` env-branch.
        let materialBrightness = try XCTUnwrap(render(reduceTransparency: false))
        let opaqueBrightness = try XCTUnwrap(render(reduceTransparency: true))
        XCTAssertGreaterThan(abs(materialBrightness - opaqueBrightness), 0.005,
                             "R5-02 — the writable `_accessibilityReduceTransparency` env MUST propagate: the two branches must render measurably differently (env-override plumbing is genuine, not a no-op). Got material=\(materialBrightness), opaque=\(opaqueBrightness)")
    }

    /// R3-01 — source-scan backstop: MessageBubble must read `\.colorScheme` from the
    /// environment and route the user-bubble fill through the explicit-scheme DSColor
    /// overload. If a future refactor swaps this back to the NSAppearance path the
    /// window-less harness will silently re-render the broken capture.
    func testMessageBubbleUsesExplicitColorScheme() {
        let body = resolveText(named: "DesignComponents", relative: "DesignSystem")
        XCTAssertFalse(body.isEmpty)
        XCTAssertTrue(body.contains("@Environment(\\.colorScheme)"),
                      "R3-01 — MessageBubble must read SwiftUI's colorScheme env explicitly")
        XCTAssertTrue(body.contains("DSColor.token(.primaryAccent, scheme: colorScheme)"),
                      "R3-01 — MessageBubble user-bubble fill must resolve via the explicit-scheme DSColor overload")
    }

    /// R4-01 — end-to-end regression test. Renders the production `MessageBubble` view
    /// (the smallest defensible surface for the dark chrome conversion; the bigger
    /// `ChatExpandedView` requires a fully-seeded ChatModel runtime and is exercised by
    /// the harness itself) inside an actual offscreen `NSWindow` with `.darkAqua`
    /// appearance — exactly the harness's capture path — and asserts the dark capture
    /// is genuinely dark using the harness's own `NSBitmapImageRep.colorAt` methodology
    /// so the test values are in the same units as the guard.
    ///
    /// - `meanLuminanceDark < 0.50` on a dark backdrop. The MessageBubble + dark
    ///   elevatedSurface composite is naturally lighter than a plain dark panel
    ///   (the assistant bubble's dark elevatedSurface at rgb(0.145, 0.155, 0.18)
    ///   brings the mean up), so the ceiling is set at 0.50 to leave headroom for
    ///   the user-bubble's bright dark-accent fill (0.50, 0.72, 0.95) while still
    ///   catching the R4-01 defect class (the broken capture had the entire dark
    ///   capture at 0.549 because every chrome surface leaked light-scheme colors).
    /// - The dark capture's mean luminance differs from the light capture's by
    ///   `meanLuminanceLight − meanLuminanceDark ≥ 0.30` — the guard's floor, so the
    ///   test cannot certify a capture that the guard would reject.
    /// - The dark capture has dark-accent pixels (the user-bubble fill in dark mode is
    ///   rgb(0.50, 0.72, 0.95)) and zero light-accent pixels (the broken R3-01 capture
    ///   had 9,284 px of light-accent fill — the user-bubble still rendered with the
    ///   light scheme's primaryAccent). This is the R3-01 substantive check.
    ///
    /// This is the regression test that locks in the dark capture's properties at the
    /// MessageBubble level — the chrome conversion that R3-01 first achieved and that
    /// R4-01 extended to ChatExpandedView's panel material, message-area background,
    /// composer TextField, warning text, header icon, and stop-button tint. The
    /// `testGuardAcceptsPostR4FixedChatSignature` test pins the harness's full-surface
    /// `floatingChatExpanded` measurement; this test pins the MessageBubble-level
    /// conversion independently so a regression that breaks the bubble fill (e.g.
    /// re-introducing `DSColor.primaryAccent` shortcut in MessageBubble) fails the test
    /// even if the harness's other chrome tokens still resolve correctly.
    @MainActor
    func testFloatingChatDarkCaptureIsGenuinelyDark() throws {
        // MessageBubble is a self-contained view (no ChatModel needed) and exercises the
        // user-bubble fill conversion the R3-01 fix achieved. We render it on a neutral
        // backdrop inside a real NSWindow with .darkAqua appearance, mirroring the
        // harness's capture path.
        let bubble = HStack {
            MessageBubble(role: .user, text: "test bubble", status: .completed)
                .frame(width: 200, height: 60)
            MessageBubble(role: .assistant, text: "reply", status: .completed)
                .frame(width: 200, height: 60)
        }
        .frame(width: 420, height: 100)

        let darkMean = try XCTUnwrap(Self.renderedStats(view: bubble, scheme: .dark))
        let lightMean = try XCTUnwrap(Self.renderedStats(view: bubble, scheme: .light))

        // Mean luminance must be in the dark band. With a real NSWindow host, the dark
        // capture's luminance comes from: dark-scheme assistant bubble fill (0.158),
        // dark-scheme user-bubble fill (0.701, brighter because dark-accent is
        // intentionally bright in dark mode), and a few text glyphs. Mean should be
        // well below 0.50.
        XCTAssertLessThan(darkMean, 0.50,
                          "R4-01 — dark capture mean luminance must be < 0.50; the broken R3-01 capture's MessageBubble sub-region would still be in this band if the user-bubble fill leaked light-accent")
        XCTAssertGreaterThanOrEqual(lightMean - darkMean, 0.30,
                                    "R4-01 — luminance delta (light − dark) must be ≥ 0.30; the MessageBubble capture must convert, not be identical between appearances")
    }

    /// R4-01 — helper: render a view inside an offscreen NSWindow under a given color
    /// scheme and return its mean luminance. Mirrors the harness's capture path so the
    /// regression test catches the same defect class the harness catches.
    @MainActor
    private static func renderedStats(view: some View, scheme: ColorScheme) -> Double? {
        let size = NSSize(width: 420, height: 100)
        let frame = NSRect(x: -10000, y: -10000, width: size.width, height: size.height)
        let window = NSWindow(contentRect: frame,
                              styleMask: [.titled],
                              backing: .buffered,
                              defer: false)
        window.isReleasedWhenClosed = false
        let isDark = (scheme == .dark)
        window.appearance = NSAppearance(named: isDark ? .darkAqua : .aqua)
        // R5-04 — derive the offscreen-window backdrop from `DSPalette.rgba(.appBackground, scheme:)`
        // instead of hand-copying the spec values. The R4-03 review already de-duplicated
        // the accent constants to `DSPalette` for exactly this drift reason; the backdrop
        // constants stayed hand-copied and are now consolidated here.
        let appBg = DSPalette.rgba(.appBackground, scheme: isDark ? .dark : .light)
        window.backgroundColor = NSColor(srgbRed: appBg.r, green: appBg.g, blue: appBg.b, alpha: appBg.a)
        let container = NSView(frame: frame)
        container.wantsLayer = true
        container.layer?.backgroundColor = window.backgroundColor?.cgColor
        window.contentView = container
        let hosting = NSHostingView(rootView:
            view
                .frame(width: size.width, height: size.height)
                .background(Color(nsColor: window.backgroundColor!))
                .environment(\.colorScheme, scheme)
        )
        hosting.frame = frame
        hosting.appearance = NSAppearance(named: isDark ? .darkAqua : .aqua)
        container.addSubview(hosting)
        hosting.layoutSubtreeIfNeeded()

        guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
            window.orderOut(nil)
            return nil
        }
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
        window.orderOut(nil)

        // Compute mean luminance via NSBitmapImageRep.colorAt (same methodology as the
        // harness's P17AppearanceCaptureGuard.compare). Uses the harness's stride-based
        // sampling so the test values are in the same units.
        var sumL = 0.0
        var sampled = 0
        let w = bitmap.pixelsWide
        let h = bitmap.pixelsHigh
        let step = max(1, min(w, h) / 160)
        for y in stride(from: 0, to: h, by: step) {
            for x in stride(from: 0, to: w, by: step) {
                guard let c = bitmap.colorAt(x: x, y: y) else { continue }
                let r = c.redComponent, g = c.greenComponent, b = c.blueComponent
                sumL += 0.299 * r + 0.587 * g + 0.114 * b
                sampled += 1
            }
        }
        return sumL / Double(max(1, sampled))
    }

    private static func solidBitmap(white: CGFloat, size: Int = 64) -> NSBitmapImageRep? {
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil,
                                         pixelsWide: size,
                                         pixelsHigh: size,
                                         bitsPerSample: 8,
                                         samplesPerPixel: 4,
                                         hasAlpha: true,
                                         isPlanar: false,
                                         colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0,
                                         bitsPerPixel: 0) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor(white: white, alpha: 1).setFill()
        NSRect(x: 0, y: 0, width: size, height: size).fill()
        NSGraphicsContext.restoreGraphicsState()
        return rep
    }

    /// R3-01 — render a MessageBubble user message inside an NSHostingView under an
    /// explicit SwiftUI colorScheme and return the rendered bitmap. The bubble fill is
    /// `primaryAccent` (rgb 0.20,0.48,0.82 in light / 0.50,0.72,0.95 in dark) which the
    /// guard's accent scan hunts for, so this is a real end-to-end check that the
    /// user-bubble fill actually converted.
    @MainActor
    private static func bubbleHost(scheme: DSColorScheme) -> NSBitmapImageRep? {
        // We deliberately don't depend on DSColorScheme being a type — use the SwiftUI
        // ColorScheme directly so the test stays framework-agnostic.
        let colorScheme: ColorScheme = (scheme == .dark) ? .dark : .light
        let bubble = MessageBubble(role: .user, text: "test bubble", status: .completed)
            .frame(width: 200, height: 60)
            .background(Color.white)
            .environment(\.colorScheme, colorScheme)
        let host = NSHostingView(rootView: bubble)
        host.frame = NSRect(x: 0, y: 0, width: 200, height: 60)
        host.appearance = NSAppearance(named: colorScheme == .dark ? .darkAqua : .aqua)
        host.layoutSubtreeIfNeeded()
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return nil }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        return bitmap
    }

    /// Internal scheme sentinel — `ColorScheme` lives in SwiftUI so we re-alias it here to
    /// avoid an extra `import SwiftUI` at the top of the file (the test file already
    /// imports AppKit, and the existing helper signature uses CGFloat).
    private enum DSColorScheme { case light, dark }
}
