import XCTest
import Foundation
import CryptoKit
@testable import DeskPet
@testable import AICore
@testable import PetAgentRuntime
@testable import PetBrainCore

/// SealedStore integration: store-level sealed roundtrips, migration with
/// backup, downgrade refusal, and JSONL mixed files. Serial-state note: these
/// tests set the global `SealedStore.cachedKey` and always reset it in
/// tearDown so the legacy-mode suite is unaffected.
@MainActor
final class SealedStoreIntegrationTests: XCTestCase {
    private var urls: [URL] = []

    override func tearDown() {
        SealedStore.cachedKey = nil
        SealedStore.persistencePolicy = .legacyTesting
        for url in urls {
            try? FileManager.default.removeItem(at: url)
            try? FileManager.default.removeItem(at: url.appendingPathExtension("pre-seal-backup"))
            try? FileManager.default.removeItem(at: url.appendingPathExtension("corrupt-test"))
        }
        urls.removeAll()
        super.tearDown()
    }

    private func tmpURL(_ name: String) -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("seal-\(name)-\(UUID().uuidString).json")
        urls.append(url)
        return url
    }

    // MARK: - Whole-file JSON store (MemoryStore as the template)

    func testSealedRoundTrip() throws {
        SealedStore.cachedKey = SymmetricKey(size: .bits256)
        let url = tmpURL("mem")
        let store = MemoryStore(fileURL: url)
        let item = MemoryItem(text: "默认用中文回复", category: .preference, source: .explicit)
        try store.save([item])
        let raw = try Data(contentsOf: url)
        XCTAssertTrue(SealedFile.isSealed(raw), "bytes on disk must be sealed")
        XCTAssertFalse(String(data: raw, encoding: .utf8)?.contains("默认用中文") ?? true)
        let reloaded = MemoryStore(fileURL: url).load()
        XCTAssertEqual(reloaded.map(\.text), ["默认用中文回复"])
    }

    func testLegacyMigratesWithBackup() throws {
        let url = tmpURL("mig")
        // Legacy plaintext written keyless (pre-encryption install).
        let plain = MemoryStore(fileURL: url)
        try plain.save([MemoryItem(text: "早睡早起", category: .usageHabit, source: .explicit)])
        XCTAssertFalse(SealedFile.isSealed(try Data(contentsOf: url)))
        // First keyed load migrates.
        SealedStore.cachedKey = SymmetricKey(size: .bits256)
        let loaded = MemoryStore(fileURL: url).load()
        XCTAssertEqual(loaded.map(\.text), ["早睡早起"])
        XCTAssertTrue(SealedFile.isSealed(try Data(contentsOf: url)))
        let backup = url.appendingPathExtension("pre-seal-backup")
        XCTAssertTrue(FileManager.default.fileExists(atPath: backup.path))
        XCTAssertTrue(SealedFile.isSealed(try Data(contentsOf: backup)))
        let permissions = try FileManager.default.attributesOfItem(atPath: backup.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
    }

    func testSealedUnreadableKeylessWithoutQuarantineOrLoss() throws {
        SealedStore.cachedKey = SymmetricKey(size: .bits256)
        let url = tmpURL("noloss")
        try MemoryStore(fileURL: url).save(
            [MemoryItem(text: "秘密计划", category: .project, source: .explicit)])
        // Lose the key: load returns empty but MUST NOT quarantine/delete.
        SealedStore.cachedKey = nil
        XCTAssertTrue(MemoryStore(fileURL: url).load().isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        let dir = url.deletingLastPathComponent().path
        let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        XCTAssertFalse(leftovers.contains { $0.contains(url.lastPathComponent) && $0.contains("corrupt") })
        // …and must refuse to overwrite (no downgrade).
        XCTAssertThrowsError(
            try MemoryStore(fileURL: url).save(
                [MemoryItem(text: "x", category: .project, source: .explicit)]))
    }

    func testProductionPolicyRefusesEveryKeylessWrite() throws {
        SealedStore.cachedKey = nil
        SealedStore.persistencePolicy = .encryptionRequired
        let url = tmpURL("required")
        XCTAssertThrowsError(try SealedStore.save(Data("private".utf8), to: url)) { error in
            XCTAssertEqual(error as? SealError, .keyUnavailable)
        }
        XCTAssertThrowsError(try SealedStore.sealLine(Data("private".utf8))) { error in
            XCTAssertEqual(error as? SealError, .keyUnavailable)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    // MARK: - JSONL mixed files (activity store)

    func testActivityJSONLMixedLegacyAndSealed() async throws {
        let url = tmpURL("act").appendingPathExtension("jsonl")
        let key = SymmetricKey(size: .bits256)
        let plain = JSONLAgentTaskActivityEventStore(fileURL: url)
        try await plain.append(activityEvent(taskID: UUID(), title: "legacy"))
        SealedStore.cachedKey = key
        let sealed = JSONLAgentTaskActivityEventStore(fileURL: url)
        try await sealed.append(activityEvent(taskID: UUID(), title: "sealed"))
        let raw = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(raw.contains("~v1."), "new lines sealed")
        XCTAssertTrue(raw.contains("legacy"), "old lines preserved")
        SealedStore.cachedKey = nil
        let legacyOnly = try await JSONLAgentTaskActivityEventStore(fileURL: url).loadEvents()
        XCTAssertEqual(legacyOnly.count, 1, "keyless reads legacy lines, skips sealed")
        SealedStore.cachedKey = key
        let both = try await JSONLAgentTaskActivityEventStore(fileURL: url).loadEvents()
        XCTAssertEqual(both.count, 2)
    }

    private func activityEvent(taskID: UUID, title: String) -> AgentTaskActivityEvent {
        AgentTaskActivityEvent(taskID: taskID, runID: UUID(), sequenceNumber: 0,
                               kind: .taskCreated,
                               presentation: AgentTaskEventPresentation(title: title))
    }
}
