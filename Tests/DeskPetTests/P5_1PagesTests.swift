import XCTest
import Foundation
@testable import DeskPet
@testable import AICore

@MainActor
final class P5_1PagesTests: XCTestCase {

    // MARK: 记忆页（真实数据 + 空状态）

    private func makeMemory() -> MemoryModel {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("mem-\(UUID().uuidString).json")
        return MemoryModel(store: MemoryStore(fileURL: url))
    }

    func testMemoryStartsEmptyForEmptyStateView() {
        let memory = makeMemory()
        XCTAssertTrue(memory.items.isEmpty)        // MemoryView shows the designed empty state
    }

    func testMemoryAddAndPendingCountAreReal() {
        let memory = makeMemory()
        let ok = memory.add(MemoryItem(text: "称呼我为队长", category: .preference, source: .explicit))
        XCTAssertTrue(ok)
        XCTAssertEqual(memory.items.count, 1)
        XCTAssertEqual(memory.pendingCount, memory.items.filter { !$0.confirmed && !$0.archived }.count)
    }

    func testMemoryDeleteRemoves() {
        let memory = makeMemory()
        memory.add(MemoryItem(text: "喜欢冷色", category: .preference, source: .explicit))
        let item = memory.items[0]
        memory.delete(item)
        XCTAssertTrue(memory.items.isEmpty)
    }

    // MARK: 陪伴页（只用真实字段，无伪造数值）

    private func makeRelationship() -> RelationshipModel {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("rel-\(UUID().uuidString).json")
        return RelationshipModel(store: RelationshipStore(fileURL: url))
    }

    func testRelationshipExposesRealStageAndFuzzyProgress() {
        let rel = makeRelationship()
        XCTAssertFalse(rel.stage.label.isEmpty)
        let progress = rel.snapshot.state.fuzzyProgress
        XCTAssertGreaterThanOrEqual(progress, 0)
        XCTAssertLessThanOrEqual(progress, 1)            // 模糊进度，真实区间，不伪造
        XCTAssertFalse(rel.snapshot.vitals.moodHint.isEmpty)   // 定性情绪，真实字段
    }

    func testUnlockedAccessoriesAreSubsetOfAll() {
        let rel = makeRelationship()
        for a in rel.unlocked { XCTAssertTrue(Accessory.allCases.contains(a)) }
    }

    // MARK: 窗口形态（含 Mini）

    func testMiniModeIsSmallestAndAvailable() {
        XCTAssertTrue(WindowMode.allCases.contains(.mini))
        let heights = WindowMode.allCases.map { $0.size.height }
        XCTAssertEqual(WindowMode.mini.size.height, heights.min())
    }

    // MARK: 控制面板重塑（结构约束）

    func testDefaultSectionStillStartsAtChat() {
        XCTAssertEqual(AppSection.chat.title, "聊天")
        XCTAssertEqual(AppSection.grouped.first?.1.first, .chat)
    }

    func testProviderStoreStartsWithSafeDisabledLocalDefault() {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("providers-\(UUID().uuidString).json")
        let providers = ProviderStore(fileURL: url, secretStore: InMemorySecretStore())
        XCTAssertEqual(providers.providers.first?.type, .ollama)
        XCTAssertEqual(providers.providers.first?.enabled, false)
        XCTAssertEqual(providers.readiness(), .noProvider)
    }
}
