import XCTest
import Foundation
@testable import AICore

/// MemoryTextSearch: CJK-bigram retrieval + ranking units.
final class MemoryTextSearchTests: XCTestCase {

    func testTokenizerCJK() {
        let toks = Set(MemoryTextSearch.tokens(for: "喜欢喝咖啡"))
        XCTAssertTrue(toks.contains("咖啡"), "bigram recall: \(toks)")
        XCTAssertTrue(toks.contains("喜欢"))
        XCTAssertFalse(toks.contains("喜欢喝咖啡"), "no whole-string token for CJK")
    }

    func testTokenizerLatin() {
        XCTAssertEqual(Set(MemoryTextSearch.tokens(for: "Default Language")),
                       ["default", "language"])
    }

    func testTokenizerMixedAndEmpty() {
        XCTAssertTrue(Set(MemoryTextSearch.tokens(for: "SFO 出发")).contains("sfo"))
        XCTAssertTrue(Set(MemoryTextSearch.tokens(for: "SFO 出发")).contains("出发"))
        XCTAssertTrue(MemoryTextSearch.tokens(for: "，。！").isEmpty)
        XCTAssertTrue(MemoryTextSearch.tokens(for: "").isEmpty)
    }

    func testShortQueryRecalls() {
        let item = MemoryItem(text: "喜欢喝拿铁咖啡", category: .preference, source: .explicit)
        let q = Set(MemoryTextSearch.tokens(for: "咖啡"))
        XCTAssertGreaterThan(MemoryTextSearch.matchedTokenCount(queryTokens: q, item: item), 0)
        // Old behavior failed here: whole-query substring "咖啡" as a *word* split
        // produced ["咖", "啡"]-style single chars that never matched.
    }

    func testSearchRanksAndSkipsArchived() {
        let now = Date()
        var archived = MemoryItem(text: "咖啡偏好", category: .preference, source: .explicit,
                                  createdAt: now, updatedAt: now)
        archived.archived = true
        let fresh = MemoryItem(text: "喜欢喝咖啡", category: .preference, source: .explicit,
                               createdAt: now, updatedAt: now)
        var stale = MemoryItem(text: "咖啡", category: .temporaryContext, source: .explicit,
                               createdAt: now.addingTimeInterval(-1000), updatedAt: now.addingTimeInterval(-1000))
        stale.state = .observed
        let found = MemoryTextSearch.search("咖啡", in: [archived, stale, fresh])
        XCTAssertFalse(found.contains(where: { $0.id == archived.id }), "archived excluded")
        XCTAssertEqual(found.first?.id, fresh.id, "active outranks observed")
    }

    func testSearchEmptyQueryReturnsEmpty() {
        let item = MemoryItem(text: "咖啡", category: .preference, source: .explicit)
        XCTAssertTrue(MemoryTextSearch.search("", in: [item]).isEmpty)
        XCTAssertTrue(MemoryTextSearch.search("，。", in: [item]).isEmpty)
    }
}
