import XCTest
@testable import DeskPet
@testable import AICore

final class RelationshipStateTests: XCTestCase {

    func testScoreIsMonotonicNeverPenalized() {
        // There is no API to decrease score — only positive interactions exist (doc §10.2).
        var s = RelationshipState()
        var last = 0.0
        for kind in [InteractionKind.pet, .chat, .focusComplete, .taskComplete, .play, .dailyGreeting] {
            s.record(kind)
            XCTAssertGreaterThanOrEqual(s.score, last)
            last = s.score
        }
    }

    func testStagesAdvanceWithAffinity() {
        var s = RelationshipState()
        XCTAssertEqual(s.stage, .acquaintance)
        for _ in 0..<12 { s.record(.focusComplete) }   // +60
        XCTAssertEqual(s.stage, .trusted)              // crosses 20 and 60
    }

    func testRecordReportsStageUp() {
        var s = RelationshipState(score: 18)
        XCTAssertTrue(s.record(.chat))    // 18 → 20 crosses into familiar
        XCTAssertFalse(s.record(.pet))    // 21 → 22 same stage
    }

    func testFuzzyProgressStaysInRangeAndHidesNumbers() {
        var s = RelationshipState()
        for _ in 0..<5 { s.record(.chat) }
        XCTAssertGreaterThanOrEqual(s.fuzzyProgress, 0)
        XCTAssertLessThanOrEqual(s.fuzzyProgress, 1)
        XCTAssertFalse(s.progressHint.contains { $0.isNumber })   // no numbers shown (doc §10.4)
    }

    func testTopStageProgressIsFull() {
        var s = RelationshipState(score: 999)
        XCTAssertEqual(s.stage, .bestie)
        XCTAssertEqual(s.fuzzyProgress, 1)
    }
}

final class RewardCatalogTests: XCTestCase {

    func testAccessoryUnlocksGrowWithStage() {
        let early = RewardCatalog.accessories(upTo: .acquaintance)
        let late = RewardCatalog.accessories(upTo: .close)
        XCTAssertTrue(early.contains(.hairclip))
        XCTAssertFalse(early.contains(.cape))
        XCTAssertTrue(late.contains(.cape))
        XCTAssertGreaterThan(late.count, early.count)
    }

    func testVitalsNeverModelSickness() {
        var v = PetVitals()
        let before = v.energy
        v.drift(dtHours: 100)            // long absence
        XCTAssertGreaterThanOrEqual(v.energy, 0.2)   // floors out, never "sick"/zero (doc §10.2)
        v.onInteraction()
        XCTAssertGreaterThan(v.mood, 0)
        _ = before
    }
}

@MainActor
final class RelationshipModelTests: XCTestCase {

    private func freshModel() -> RelationshipModel {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskpet-rel-\(UUID().uuidString).json")
        return RelationshipModel(store: RelationshipStore(fileURL: url))
    }

    func testStageUpCallbackFires() {
        let m = freshModel()
        var reached: RelationshipStage?
        m.onStageUp = { reached = $0 }
        for _ in 0..<5 { m.record(.focusComplete) }   // +25 crosses familiar(20)
        XCTAssertEqual(reached, .familiar)
    }

    func testCannotEquipLockedAccessory() {
        let m = freshModel()
        m.toggleEquip(.cape)                 // locked at acquaintance
        XCTAssertFalse(m.equipped.contains(.cape))
        XCTAssertTrue(m.unlocked.contains(.hairclip))
        m.toggleEquip(.hairclip)
        XCTAssertFalse(m.equipped.contains(.hairclip))   // toggled off (started equipped)
    }
}
