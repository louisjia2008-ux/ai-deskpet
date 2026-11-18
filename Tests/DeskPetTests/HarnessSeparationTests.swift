import XCTest
import Foundation

/// Harness/production separation regression tests.
///
/// Invariant: acceptance harnesses and visual-smoke code must never ship in
/// release builds. The mechanism is file-level `#if DEBUG … #endif` plus
/// `#if DEBUG` call sites in AppDelegate/Overlay. These tests scan the sources
/// so a future edit that drops a gate fails fast in `swift test` (debug).
///
/// Paths are resolved relative to this file — no absolute machine paths.
final class HarnessSeparationTests: XCTestCase {

    private static var repoDeskPetRoot: URL {
        // Tests/DeskPetTests/<this file> → DeskPet/
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    private func source(relative path: String) throws -> String {
        let url = Self.repoDeskPetRoot.appendingPathComponent(path)
        return try String(contentsOf: url, encoding: .utf8)
    }

    // MARK: - Harness files are DEBUG-gated

    func testAppHarnessesAreDebugGated() throws {
        let fm = FileManager.default
        let appDir = Self.repoDeskPetRoot.appendingPathComponent("Sources/DeskPet/App")
        let harnesses = try fm.contentsOfDirectory(atPath: appDir.path)
            .filter { $0.hasPrefix("P") && $0.hasSuffix("Harness.swift") }
        XCTAssertGreaterThanOrEqual(harnesses.count, 8, "expected the P* harness family, found: \(harnesses)")
        for name in harnesses {
            let src = try source(relative: "Sources/DeskPet/App/\(name)")
            let trimmed = src.trimmingCharacters(in: .whitespacesAndNewlines)
            // P22 — accept either `#if DEBUG` (legacy gate) or
            // `#if PHASE_HARNESS && DEBUG` (P22 precision gate); both
            // keep the file out of release builds.
            XCTAssertTrue(trimmed.hasPrefix("#if DEBUG")
                          || trimmed.hasPrefix("#if PHASE_HARNESS && DEBUG"),
                          "\(name) must start with #if DEBUG or #if PHASE_HARNESS && DEBUG so release builds exclude it")
            XCTAssertTrue(trimmed.hasSuffix("#endif"),
                          "\(name) must end with #endif")
        }
    }

    func testOnboardingScreenshotHarnessIsDebugGated() throws {
        let src = try source(relative: "Sources/DeskPet/Onboarding/P17OnboardingScreenshotHarness.swift")
        let trimmed = src.trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertTrue(trimmed.hasPrefix("#if DEBUG"))
        XCTAssertTrue(trimmed.hasSuffix("#endif"))
    }

    // MARK: - Visual smoke lives inside one DEBUG region in Overlay

    func testOverlayVisualSmokeInsideDebugRegion() throws {
        let src = try source(relative: "Sources/DeskPet/Window/OverlayWindowController.swift")
        // Collect #if DEBUG…#endif spans (no nesting in this file).
        var spans: [(Int, Int)] = []
        var stack: [Int] = []
        let lines = src.components(separatedBy: "\n")
        for (i, line) in lines.enumerated() {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("#if DEBUG") { stack.append(i) }
            else if t == "#endif", let start = stack.popLast() { spans.append((start, i)) }
        }
        func insideDebug(_ needle: String, _ label: String) {
            guard let line = lines.firstIndex(where: { $0.contains(needle) }) else {
                XCTFail("\(label): '\(needle)' not found"); return
            }
            XCTAssertTrue(spans.contains { $0.0 < line && line < $0.1 },
                          "\(label) must be inside a #if DEBUG region")
        }
        insideDebug("func runLumiScholarVisualSmoke", "Lumi smoke")
        insideDebug("func runCharacterWalkVisualSmoke", "walk smoke")
        insideDebug("func runIdlePresenceVisualSmoke", "idle smoke")
        insideDebug("func runPresenceVisualSmoke", "presence smoke")
    }

    // MARK: - AppDelegate harness triggers are DEBUG-gated

    func testAppDelegateHarnessTriggersAreDebugGated() throws {
        let src = try source(relative: "Sources/DeskPet/AppDelegate.swift")
        let lines = src.components(separatedBy: "\n")
        var depth = 0
        var violations: [String] = []
        for line in lines {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("#if DEBUG") { depth += 1 }
            else if t == "#endif" { depth = max(0, depth - 1) }
            else if depth == 0 && (line.contains("Harness.runIfRequested") || line.contains("Harness.requested")) {
                violations.append(t)
            }
        }
        XCTAssertTrue(violations.isEmpty,
                      "harness triggers outside #if DEBUG in AppDelegate: \(violations)")
    }
}
