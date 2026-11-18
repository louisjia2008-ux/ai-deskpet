import XCTest
import Foundation
@testable import AICore

/// D5 compile-time SKU gating (doc 01 §4 — no hidden capability switch).
/// The tier for a binary is fixed by `#if APPSTORE` (`DistributionTier.current`);
/// production assembly must never name a concrete tier, and no runtime input
/// (defaults/CLI/env) may select one.
final class DistributionTierGatingTests: XCTestCase {

    private static var deskPetRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    private func productionSources() throws -> [(path: String, text: String)] {
        let fm = FileManager.default
        let root = Self.deskPetRoot.appendingPathComponent("Sources").path
        var out: [(String, String)] = []
        guard let walker = fm.enumerator(atPath: root) else { return out }
        for case let file as String in walker where file.hasSuffix(".swift") {
            let full = (root as NSString).appendingPathComponent(file)
            if let text = try? String(contentsOfFile: full, encoding: .utf8) {
                out.append((file, text))
            }
        }
        return out
    }

    func testCurrentMatchesCompileFlag() {
        // Built both ways in CI (plain + -DAPPSTORE); pins the flag wiring.
        #if APPSTORE
        XCTAssertEqual(DistributionTier.current, .appStore)
        XCTAssertEqual(DistributionTier.current.ceiling, .p2)
        #else
        XCTAssertEqual(DistributionTier.current, .developerID)
        XCTAssertEqual(DistributionTier.current.ceiling, .p4)
        #endif
    }

    func testAppStoreTierDeniesP3AndP4RegardlessOfApproval() {
        // Logic-level pin: even an approved request can never mint P3+ in MAS.
        var broker = CapabilityBroker(tier: .appStore)
        for id in ["network.fetch", "network.upload", "shell.arbitrary", "git.push"] {
            let req = GrantRequest(capabilityID: id, reason: "x", duration: .onceImmediate)
            if case .denied = broker.request(req) {} else {
                XCTFail("\(id) must be denied in appStore tier")
            }
            XCTAssertNil(broker.approve(req), "\(id) must not mint a grant in appStore tier")
        }
        // …while P0/P2 still flow.
        let p0 = GrantRequest(capabilityID: "state.read", reason: "x")
        if case .needsApproval(let level, _) = broker.request(p0) {
            XCTAssertEqual(level, .auto)
        } else {
            XCTFail("P0 must stay auto-approvable in appStore tier")
        }
    }

    func testProductionNeverNamesAConcreteTier() throws {
        var violations: [String] = []
        for (path, text) in try productionSources() {
            for (i, line) in text.components(separatedBy: "\n").enumerated() {
                let t = line.trimmingCharacters(in: .whitespaces)
                guard !t.hasPrefix("//") else { continue }
                if line.contains("tier: .developerID") || line.contains("tier: .appStore")
                    || line.contains("tier = .developerID") || line.contains("tier = .appStore") {
                    violations.append("\(path):\(i + 1)")
                }
            }
        }
        XCTAssertTrue(violations.isEmpty,
                      "production must assemble tier via DistributionTier.current only: \(violations)")
    }

    func testProductionAssemblesViaCurrent() throws {
        let delegate = try String(contentsOfFile: Self.deskPetRoot
            .appendingPathComponent("Sources/DeskPet/AppDelegate.swift").path,
                                  encoding: .utf8)
        XCTAssertTrue(delegate.contains("tier: .current"),
                      "AppDelegate must pass DistributionTier.current to SecurityKernel/AgentRuntimeContainer")
    }

    func testNoRuntimeTierOverrideVector() throws {
        // No UserDefaults key / CLI flag / env var may select a tier.
        let suspects = ["TIER", "DISTRIBUTION_TIER", "distributionTier",
                        "--tier", "deskpet-tier", "tierOverride", "overrideTier"]
        var violations: [String] = []
        for (path, text) in try productionSources() {
            for suspect in suspects where text.contains(suspect) {
                violations.append("\(path) contains \(suspect)")
            }
        }
        XCTAssertTrue(violations.isEmpty, "no runtime tier override may exist: \(violations)")
    }
}
