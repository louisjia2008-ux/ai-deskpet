import XCTest
import Foundation
@testable import AICore

final class CapabilityBrokerTests: XCTestCase {

    func testUnknownCapabilityDenied() {
        var b = CapabilityBroker(tier: .developerID)
        if case .denied = b.request(GrantRequest(capabilityID: "made.up.capability", reason: "x")) {}
        else { XCTFail("unknown capability must be denied") }
    }

    func testAppStoreTierHardCapsAtP2() {
        var b = CapabilityBroker(tier: .appStore)
        // P4 shell is permanently denied in App Store SKU (D5).
        if case .denied(let r) = b.request(GrantRequest(capabilityID: "shell.arbitrary", reason: "x")) {
            XCTAssertTrue(r.contains("永久禁用"))
        } else { XCTFail("P4 must be denied in appStore tier") }
        // P2 is allowed (needs single approval).
        if case .needsApproval(let lvl, _) = b.request(GrantRequest(capabilityID: "reminders.create", reason: "x")) {
            XCTAssertEqual(lvl, .single)
        } else { XCTFail("P2 should need single approval, not be denied") }
    }

    func testDeveloperIDAllowsP4ButPerUse() {
        var b = CapabilityBroker(tier: .developerID)
        if case .needsApproval(let lvl, _) = b.request(GrantRequest(capabilityID: "git.push", reason: "x")) {
            XCTAssertEqual(lvl, .perUse)
        } else { XCTFail("P4 in developerID should need per-use approval") }
    }

    func testCombinationRiskEscalatesApproval() {
        var b = CapabilityBroker(tier: .developerID)
        _ = b.approve(GrantRequest(capabilityID: "filesystem.workspace.read", reason: "read"))
        // Now requesting upload while holding file read → exfiltration combo → per-use.
        if case .needsApproval(let lvl, let combos) = b.request(GrantRequest(capabilityID: "network.upload", reason: "send")) {
            XCTAssertEqual(lvl, .perUse)
            XCTAssertFalse(combos.isEmpty)
            XCTAssertTrue(combos.contains { $0.contains("数据泄露") })
        } else { XCTFail("read + upload must trigger combination risk") }
    }

    func testTokenIssueValidateRevoke() {
        var b = CapabilityBroker(tier: .developerID)
        let now = Date()
        let grant = b.approve(GrantRequest(capabilityID: "calendar.events.read", reason: "r",
                                           duration: .timeboxed(seconds: 60)), now: now)!
        XCTAssertTrue(b.validate(token: grant.token, capabilityID: "calendar.events.read", now: now))
        // wrong capability for this token
        XCTAssertFalse(b.validate(token: grant.token, capabilityID: "reminders.create", now: now))
        // expired
        XCTAssertFalse(b.validate(token: grant.token, capabilityID: "calendar.events.read",
                                  now: now.addingTimeInterval(120)))
        // revoked
        b.revoke(token: grant.token)
        XCTAssertFalse(b.validate(token: grant.token, capabilityID: "calendar.events.read", now: now))
    }

    func testRevokeTaskDropsAllItsGrants() {
        var b = CapabilityBroker(tier: .developerID)
        let task = UUID()
        _ = b.approve(GrantRequest(capabilityID: "calendar.events.read", reason: "r", taskID: task))
        _ = b.approve(GrantRequest(capabilityID: "reminders.read", reason: "r", taskID: task))
        XCTAssertEqual(b.grants.count, 2)
        b.revokeTask(task)
        XCTAssertEqual(b.grants.count, 0)
    }

    func testAuditIsAppendOnlyAndRedacts() {
        var b = CapabilityBroker(tier: .developerID)
        // P18.4 — AICO-005: the previous prose mention "我的 api key 是 abc"
        // relied on the (now-removed) `"api"` substring gate; with the
        // structured regex redactor the prose path is intentionally
        // preserved to avoid loss-of-context, and the value itself is
        // still redacted at the MemoryPolicy write-gate layer. Switch the
        // example to a `"password=..."` form that still triggers the
        // long-token "password" substring gate so the test continues
        // to assert that the audit detail is free of the secret.
        _ = b.request(GrantRequest(capabilityID: "network.fetch", reason: "my password=abc xyz"))
        XCTAssertTrue(b.audit.entries.contains { $0.action == .requested })
        XCTAssertTrue(b.audit.entries.allSatisfy { !$0.detail.contains("abc") })  // redacted
        XCTAssertEqual(AuditLog.redact("password=hunter2"), "[redacted]")
        // P18.4 — AICO-005: prose mentions of "api" / "key" alone are NOT
        // redacted to "[redacted]" anymore (that was the false-positive
        // surface); the audit detail itself is preserved with the
        // sensitive value range substituted only when a key=value
        // pattern is present. Verified by additional P18.4 targeted tests.
        XCTAssertNotEqual(AuditLog.redact("the quick brown fox jumps over rapid api"),
                          "[redacted]",
                          "Prose mention of 'api' must NOT trigger full-string redaction (was the P18.4-cited false positive)")
    }
}
