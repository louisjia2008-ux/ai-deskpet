import XCTest
import Foundation
@testable import DeskPet
@testable import AICore

final class MemoryRetentionTests: XCTestCase {

    func testDefaultExpiryByCategory() {
        let now = Date()
        XCTAssertNotNil(MemoryRetention.defaultExpiry(for: .learningGoal, from: now))
        XCTAssertNotNil(MemoryRetention.defaultExpiry(for: .temporaryContext, from: now))
        XCTAssertNil(MemoryRetention.defaultExpiry(for: .preference, from: now))
    }

    func testExpiredTemporaryContextIsDropped() {
        let old = Date().addingTimeInterval(-30 * 86400)
        let m = MemoryItem(text: "临时", category: .temporaryContext, source: .auto, createdAt: old)
        let kept = MemoryRetention.apply([m], now: Date())
        XCTAssertTrue(kept.isEmpty)
    }

    func testExpiredLearningGoalBecomesUnconfirmed() {
        let old = Date().addingTimeInterval(-100 * 86400)
        var m = MemoryItem(text: "复习", category: .learningGoal, source: .explicit, createdAt: old)
        m.confirmed = true
        let kept = MemoryRetention.apply([m], now: Date())
        XCTAssertEqual(kept.count, 1)
        XCTAssertFalse(kept[0].confirmed)   // 待确认
    }

    func testInactiveProjectIsArchived() {
        let old = Date().addingTimeInterval(-60 * 86400)
        let m = MemoryItem(text: "项目X", category: .project, source: .explicit, createdAt: old)
        XCTAssertTrue(MemoryRetention.apply([m], now: Date())[0].archived)
    }

    func testUsageHabitWeightDecays() {
        let fresh = MemoryItem(text: "习惯", category: .usageHabit, source: .auto)
        let old = MemoryItem(text: "习惯", category: .usageHabit, source: .auto,
                             createdAt: Date().addingTimeInterval(-120 * 86400))
        XCTAssertGreaterThan(MemoryRetention.effectiveWeight(fresh, now: Date()),
                             MemoryRetention.effectiveWeight(old, now: Date()))
    }
}

final class MemoryPolicyTests: XCTestCase {

    func testForbiddenContentNeverStored() {
        XCTAssertFalse(MemoryPolicy.mayStore(category: .preference, source: .explicit, text: "我的支付密码是1234"))
        XCTAssertTrue(MemoryPolicy.isForbiddenContent("银行卡号"))
    }

    func testAutoOnlyAllowsUsageHabit() {
        XCTAssertTrue(MemoryPolicy.mayStore(category: .usageHabit, source: .auto, text: "常用45分钟"))
        XCTAssertFalse(MemoryPolicy.mayStore(category: .preference, source: .auto, text: "称呼"))
        XCTAssertFalse(MemoryPolicy.mayStore(category: .learningGoal, source: .auto, text: "目标"))
    }

    func testSuggesterFiresAfterThreshold() {
        XCTAssertNil(MemorySuggester.focusHabit(minutes: 45, occurrences: 2))
        let s = MemorySuggester.focusHabit(minutes: 45, occurrences: 3)
        XCTAssertEqual(s?.category, .usageHabit)
        XCTAssertEqual(s?.source, .suggested)
        XCTAssertFalse(s!.confirmed)   // needs confirmation
    }
}

@MainActor
final class MemoryModelTests: XCTestCase {

    private func freshModel() -> MemoryModel {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskpet-mem-\(UUID().uuidString).json")
        return MemoryModel(store: MemoryStore(fileURL: url))
    }

    func testActiveHintsGateCloudAndTrackUsage() {
        let m = freshModel()
        m.add(MemoryItem(text: "称呼我队长", category: .preference, source: .explicit))
        m.add(MemoryItem(text: "私密偏好", category: .preference, source: .explicit, blockCloud: true))

        let localHints = m.activeHints(forCloud: false)
        XCTAssertEqual(Set(localHints), ["称呼我队长", "私密偏好"])

        let cloudHints = m.activeHints(forCloud: true)
        XCTAssertTrue(cloudHints.contains("称呼我队长"))
        XCTAssertFalse(cloudHints.contains("私密偏好"))   // blockCloud excluded (doc §12.2)

        // Using it for cloud marks everEnteredCloud.
        let captain = m.items.first { $0.text == "称呼我队长" }!
        XCTAssertTrue(captain.everEnteredCloud)
        XCTAssertGreaterThan(captain.useCount, 0)
    }

    func testSuggestedMemoryIsNotActiveUntilConfirmed() {
        let m = freshModel()
        m.suggest(MemorySuggester.focusHabit(minutes: 45, occurrences: 3))
        XCTAssertEqual(m.activeHints(forCloud: false).count, 0)   // unconfirmed → not used
        let item = m.items.first!
        m.confirm(item)
        XCTAssertEqual(m.activeHints(forCloud: false).count, 1)
    }

    func testPausedMemoryNotUsed() {
        let m = freshModel()
        m.add(MemoryItem(text: "暂停项", category: .preference, source: .explicit))
        m.setPaused(m.items.first!, true)
        XCTAssertTrue(m.activeHints(forCloud: false).isEmpty)
    }
}
