import XCTest
import Foundation
import AICore
import PetBrainCore
@testable import PetAgentRuntime
@testable import DeskPet

/// P18.4 — Exact Identity Matching Regression Tests.
///
/// Locks in the invariants established / repaired in the P18.4 exact-
/// identity audit. These tests assert the RUNTIME behavior of the four
/// repaired sites:
///
///   I1 — exact `PlaceCategory` raw-value resolution
///        (PAR-015 / `LocalDiscoveryValidator.validateCategory`).
///   I2 — word-boundary `keyword` resolution
///        (PAR-016 / `LocalDiscoveryValidator.validateKeyword`).
///   I3 — word-boundary overclaim detection
///        (PAR-028 / `LocalDiscoveryValidator.validateOverclaim` and the
///        planner-side verifier).
///   I4 — redaction contract tightening
///        (AICO-005 / `CapabilityBroker.AuditLog.redact`).
final class P18_4ExactIdentityMatchingTests: XCTestCase {

    // MARK: - I1 — exact PlaceCategory resolution (PAR-015)

    func testI1_validateCategoryDoesNotMatchBySubstring() {
        let validator = LocalDiscoveryValidator()
        // Build a candidate whose `categories` deliberately hold non-canonical
        // rawValues that share substrings with canonical `PlaceCategory` values.
        // The previous substring check would have accepted these via
        // `contains()`; the exact-match check rejects them.
        func make(name: String, rawValue: String) -> PlaceCandidate {
            PlaceCandidate(stableID: "id-\(name)",
                           name: name,
                           categories: [PlaceCategory(rawValue: rawValue)],
                           address: nil,
                           coordinate: nil,
                           evidenceReferences: [])
        }
        let bookstore = make(name: "Independent Bookstore", rawValue: "bookstore")
        let placemat = make(name: "Floor Placemat Shop", rawValue: "placemat")

        // Query for `.retailStore` (rawValue "retail_store").
        // Pre-fix: "bookstore" matched via `contains("store")` (substring) and
        // disposition was `includeWithWarning`. Post-fix: exact category is
        // required, so a `bookstore` candidate must FAIL the hard
        // `.retailStore` constraint and be marked `excludeHardConstraintFailure`.
        let queryBookstore = LocalDiscoveryQueryFixtures.query(category: .retailStore,
                                                            hardCategory: true)
        let r1 = validator.validate(query: queryBookstore, candidates: [bookstore])
        XCTAssertEqual(r1.disposition(for: bookstore.stableID), .excludeHardConstraintFailure,
                       "PAR-015: pre-fix matched 'bookstore' against '.retailStore' via `contains('store')`; post-fix must NOT")

        // Query for `.place` (rawValue "place"). Pre-fix: "placemat" matched
        // via contains-or-`expectedRaw.contains(candidate)` (substring).
        let queryPlacemat = LocalDiscoveryQueryFixtures.query(category: .place,
                                                            hardCategory: true)
        let r2 = validator.validate(query: queryPlacemat, candidates: [placemat])
        XCTAssertEqual(r2.disposition(for: placemat.stableID), .excludeHardConstraintFailure,
                       "PAR-015: pre-fix matched 'placemat' against '.place' via `contains('lace')`; post-fix must NOT")

        // Verify a canonical match still passes the category constraint
        // (positive control). The exact match resolves, but other
        // unfilled fields will downgrade the final disposition to a
        // more conservative state. The contract being locked is
        // `category` criterion reports `.passed`, not the candidate's
        // overall disposition.
        let canonical = make(name: "Local Bookstore", rawValue: "retail_store")
        let r3 = validator.validate(query: queryBookstore, candidates: [canonical])
        let categoryFinding = r3.findings.filter { $0.candidateID == canonical.stableID && $0.criterion == "category" }
        XCTAssertEqual(categoryFinding.count, 1)
        XCTAssertEqual(categoryFinding.first?.status, .passed,
                       "Exact-match canonical '.retailStore' against query `.retailStore` MUST pass the category constraint")

        // Verify IS-A narrowing is NOT implicit at the validator level:
        // a `sichuan_restaurant` candidate does NOT pass a hard
        // `.restaurant` query, because IS-A canonicalization is the job of
        // the upstream structured planner (canonicalCategory).
        let sichuan = make(name: "Sichuan Hotpot", rawValue: "sichuan_restaurant")
        let queryRestaurant = LocalDiscoveryQueryFixtures.query(category: .restaurant,
                                                              hardCategory: true)
        let r4 = validator.validate(query: queryRestaurant, candidates: [sichuan])
        XCTAssertEqual(r4.disposition(for: sichuan.stableID), .excludeHardConstraintFailure,
                       "Post-P18.4: expected category must match the candidate's canonical rawValue exactly; IS-A narrowing is handled by the structured planner")
    }

    // MARK: - I2 — word-boundary keyword resolution (PAR-016)

    func testI2_validateKeywordUsesWordBoundary() {
        // Direct unit test of the helper.
        XCTAssertTrue(LocalDiscoveryValidator.containsWord("Lace Bistro", "lace"))
        // PAR-016: pre-fix `String.contains("lace")` matched the suffix of
        // "place"; word-boundary now correctly rejects.
        XCTAssertFalse(LocalDiscoveryValidator.containsWord("Place store", "lace"),
                       "Word-boundary match: 'lace' must NOT appear as a whole word in 'Place store'")
        XCTAssertFalse(LocalDiscoveryValidator.containsWord("roadmap", "map"),
                        "Pre-fix: 'map' matched anywhere inside 'roadmap'; word-boundary now correctly rejects")
        XCTAssertTrue(LocalDiscoveryValidator.containsWord("Roadside cafe", "cafe"))
        XCTAssertFalse(LocalDiscoveryValidator.containsWord("Roadside cafe", "espresso"))
        XCTAssertTrue(LocalDiscoveryValidator.containsWord("Maple Avenue Cafe", "maple"))
        XCTAssertFalse(LocalDiscoveryValidator.containsWord("Mapping notes", "maple"),
                        "Word-boundary: 'maple' must NOT appear as a whole word in 'Mapping notes'")
        XCTAssertTrue(LocalDiscoveryValidator.containsWord("Maple Avenue Cafe", "Cafe"),
                      "Case-insensitive whole-word match")
        // Chinese: no whitespace word boundary; substring fallback (P18.4 documented).
        XCTAssertTrue(LocalDiscoveryValidator.containsWord("丝绸之路", "丝绸"))
        XCTAssertTrue(LocalDiscoveryValidator.containsWord("仿丝绸", "丝绸"))
    }

    // MARK: - I3 — overclaim detection (PAR-028)

    func testI3_overclaimHelperUsesWordBoundary() {
        // Helper-level: word-boundary check.
        XCTAssertTrue(LocalDiscoveryValidator.containsWord("Open now with easy parking", "open"))
        XCTAssertTrue(LocalDiscoveryValidator.containsWord("Open now with easy parking", "parking"))
        XCTAssertFalse(LocalDiscoveryValidator.containsWord("Reopen tomorrow after maintenance", "open"),
                       "Pre-fix: `contains('open')` matched 'Reopen'; word-boundary now correctly rejects")
        XCTAssertFalse(LocalDiscoveryValidator.containsWord("Reparking lot nearby", "parking"),
                       "Pre-fix: `contains('parking')` matched 'Reparking'; word-boundary now correctly rejects")
        XCTAssertFalse(LocalDiscoveryValidator.containsWord("Back opening soon", "open"))
        XCTAssertTrue(LocalDiscoveryValidator.containsWord("open", "open"))
        XCTAssertFalse(LocalDiscoveryValidator.containsWord("", "open"))
    }

    // MARK: - I4 — redaction contract (AICO-005)

    func testI4_redactNoLongerFalsePositivesOnShortTokens() {
        // P18.4: the substring gates "api" and "key" are gone. The audit
        // detail is preserved unless a structured key=value pattern is
        // present.
        XCTAssertNotEqual(AuditLog.redact("the quick brown fox jumps over rapid api"),
                          "[redacted]",
                          "Prose containing 'api' as a substring must NOT be fully redacted (was the P18.4-cited false positive)")
        XCTAssertNotEqual(AuditLog.redact("I lost my key this morning"),
                          "[redacted]",
                          "Prose containing the word 'key' must NOT be fully redacted (was the related false positive)")
        XCTAssertNotEqual(AuditLog.redact("talk about API design"),
                          "[redacted]")
    }

    func testI4_redactStillCatchesStructuredKeyEqualsValue() {
        // Structured `api_key=<value>` IS redacted by the structured regex
        // value-substitution path (preserves prose context, removes the
        // captured value).
        let r1 = AuditLog.redact("config: api_key=abc123 rest")
        XCTAssertTrue(r1.contains("[redacted]"), "Structured api_key=value MUST redacted")
        XCTAssertFalse(r1.contains("abc123"), "Captured value MUST be removed from output")
        // `password=hunter2` is still caught by the long-token gate.
        XCTAssertEqual(AuditLog.redact("password=hunter2"), "[redacted]")
        // Long arbitrary alphanumeric token is still caught.
        let syntheticBearer = "Bearer " + String(repeating: "fixture", count: 7)
        XCTAssertEqual(AuditLog.redact(syntheticBearer),
                       "[redacted]")
        // Prose mentions of "password" stay caught by the long-token gate.
        XCTAssertEqual(AuditLog.redact("my password is hunter2"), "[redacted]")
    }

    func testI4_redactNoLongerManglesProseMention() {
        // P18.4 — AICO-005: the structured regex replaces only the
        // captured value (preserving prose context for auditability),
        // rather than dropping the entire detail to "[redacted]".
        let r1 = AuditLog.redact("config: apikey=hunter2 end")
        XCTAssertTrue(r1.contains("[redacted]"))
        XCTAssertFalse(r1.contains("hunter2"))
        // Long alphanumeric key caught by the long-key regex.
        let r2 = AuditLog.redact("secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123")
        XCTAssertEqual(r2, "[redacted]")
    }

    // MARK: - F2 — provider selection rejects substring routing

    func testF2_modelRouterRejectsAutoFallbackBySubstring() async {
        // Confirms that ModelRouter does NOT branch on substring matching
        // of provider names / model IDs when no explicit default is set.
        // If a heuristic fallback existed, the result would be a `.success`
        // even when `defaults.companionModelProviderID == nil`. The
        // fail-closed contract is `.noCompanionModelConfigured`.
        let router = ModelRouter()
        let provider = ProviderConfig(displayName: "Z.AI",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://api.z.ai/v1/")!,
                                      apiKeySecretID: "zai-key",
                                      capabilities: [.chat, .streaming, .toolCalling])
        let defaults = ModelRoleDefaults()
        let result = await router.route(.companion,
                                        providers: [provider],
                                        defaults: defaults,
                                        secretStore: InMemorySecretStore())
        switch result {
        case .failure(let error):
            switch error {
            case .noCompanionModelConfigured:
                break // expected — fail-closed, not substring auto-pick
            default:
                XCTFail("Expected .noCompanionModelConfigured; got \(error)")
            }
        case .success:
            XCTFail("Must NOT auto-select provider without explicit default")
        }
    }
}

// MARK: - Test fixtures

enum LocalDiscoveryQueryFixtures {
    static func query(category: PlaceCategory = .place,
                      hardCategory: Bool = true) -> PlaceQuery {
        PlaceQuery(queryID: "p18_4-q",
                   rawUserIntent: "x",
                   searchText: "x",
                   category: category,
                    locationInput: PlaceLocationInput(kind: .unknown, label: ""),
                    resultLimit: 5,
                    createdAt: Date(timeIntervalSince1970: 1_700_000_000))
    }

    static func provider(id: String, displayName: String) -> ProviderConfig {
        ProviderConfig(displayName: displayName, type: .ollama, baseURL: URL(string: "http://127.0.0.1:0")!, capabilities: [.chat])
    }

    static func fakeSecretStore() -> any SecretStore {
        InMemorySecretStore()
    }
}
