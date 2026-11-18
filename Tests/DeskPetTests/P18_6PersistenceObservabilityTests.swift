import XCTest
import Foundation
import AICore
@testable import DeskPet

/// P18.6 — Persistence Failure Observability regression coverage.
///
/// Proves the repaired invariant for the local-first JSON stores:
///   • a durable write that fails is OBSERVABLE (never a silent `try?` success),
///   • the owning model surfaces it (no false durable-success),
///   • memory/disk semantics stay defined and restart is deterministic,
///   • an existing-but-corrupt file is quarantined, never silently treated as
///     "no data" and then clobbered by the next save.
@MainActor
final class P18_6PersistenceObservabilityTests: XCTestCase {

    // MARK: Seams

    /// A file URL whose *parent* is a regular file, so any atomic write to it
    /// throws. Deterministic, no privileged directories required.
    private func unwritableURL() throws -> URL {
        let blocker = FileManager.default.temporaryDirectory
            .appendingPathComponent("p186-blocker-\(UUID().uuidString).dat")
        try Data("x".utf8).write(to: blocker)
        return blocker.appendingPathComponent("child.json")
    }

    private func tempURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("p186-\(UUID().uuidString).json")
    }

    // MARK: DurableJSONFile helper

    func testDurableReadDistinguishesAbsentEmptyPresent() throws {
        let url = tempURL()
        // Absent
        if case .absent = DurableJSONFile.read(at: url) {} else { XCTFail("missing file should be .absent") }
        // Empty file → still a fresh state
        try Data().write(to: url)
        if case .absent = DurableJSONFile.read(at: url) {} else { XCTFail("empty file should be .absent") }
        // Present
        try Data("[]".utf8).write(to: url)
        if case .present(let d) = DurableJSONFile.read(at: url) { XCTAssertEqual(d, Data("[]".utf8)) }
        else { XCTFail("non-empty file should be .present") }
    }

    func testQuarantinePreservesCorruptBytesAndMovesFile() throws {
        let url = tempURL()
        let corrupt = Data("not json {{{".utf8)
        try corrupt.write(to: url)

        let quarantined = DurableJSONFile.quarantineCorrupt(at: url)
        XCTAssertNotNil(quarantined, "corrupt file should be moved aside")
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path),
                       "original path must be freed so the next save does not fail/clobber")
        XCTAssertEqual(try Data(contentsOf: quarantined!), corrupt,
                       "quarantined bytes must survive for recovery")
    }

    // MARK: P1 — critical write failure is observable

    func testTaskStoreSaveThrowsOnUnwritablePath() throws {
        let store = TaskStore(fileURL: try unwritableURL())
        XCTAssertThrowsError(try store.save([PetTask(title: "t")]),
                             "a failed durable write must throw, not silently succeed")
    }

    func testAppModelSurfacesTaskPersistenceFailureAndStaysDeterministicOnRestart() throws {
        let url = try unwritableURL()
        let model = AppModel(store: TaskStore(fileURL: url))
        XCTAssertNil(model.lastPersistenceError)

        model.add(PetTask(title: "会丢失的任务"))

        // Memory is optimistically current, but the failure is disclosed —
        // the UI can distinguish success from failure (no false success).
        XCTAssertEqual(model.tasks.count, 1)
        XCTAssertNotNil(model.lastPersistenceError)

        // Restart determinism: disk was never written, so a fresh model shows the
        // pre-change durable state (empty), matching the disclosed failure.
        let reloaded = AppModel(store: TaskStore(fileURL: url))
        XCTAssertEqual(reloaded.tasks.count, 0)
    }

    func testMemoryModelSurfacesPersistenceFailure() throws {
        let model = MemoryModel(store: MemoryStore(fileURL: try unwritableURL()))
        model.add(MemoryItem(text: "记住这个", category: .preference, source: .explicit, scope: .procedural))
        XCTAssertNotNil(model.lastPersistenceError)
    }

    func testTaskSchedulerSurfacesPersistenceFailure() throws {
        let scheduler = TaskScheduler(store: ScheduledTaskStore(fileURL: try unwritableURL()))
        scheduler.add(ScheduledTask(title: "s", prompt: "p", schedule: .everySeconds(60), createdAt: Date()))
        XCTAssertNotNil(scheduler.lastPersistenceError)
    }

    func testRelationshipModelSurfacesPersistenceFailure() throws {
        let model = RelationshipModel(store: RelationshipStore(fileURL: try unwritableURL()))
        model.record(.chat)
        XCTAssertNotNil(model.lastPersistenceError)
    }

    // MARK: P2 — provider config false-success

    func testProviderUpsertReportsFailureWhenConfigWriteFails() async throws {
        let url = try unwritableURL()
        let store = ProviderStore(fileURL: url, secretStore: InMemorySecretStore())
        let provider = ProviderConfig(displayName: "会丢失的 Provider",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com")!,
                                      enabled: true)

        // Secret save succeeds (in-memory) but the providers.json write cannot:
        // upsert must NOT claim success while the config never reached disk.
        let result = await store.upsert(provider, apiKey: "k", manualModelID: "m")
        XCTAssertFalse(result.isSuccess, "must not report success when the durable config write failed")
        XCTAssertNotNil(result.errorMessage)
        XCTAssertNotNil(store.lastPersistenceError)

        // Restart determinism: the config was never persisted, so a fresh store
        // does not resurrect it.
        let reloaded = ProviderStore(fileURL: url, secretStore: InMemorySecretStore())
        XCTAssertFalse(reloaded.providers.contains { $0.displayName == "会丢失的 Provider" })
    }

    // MARK: P6 — corrupt file is quarantined, not silently emptied then clobbered

    func testTaskStoreCorruptFileIsQuarantinedNotSilentlyEmptied() throws {
        let url = tempURL()
        try Data("this is not valid task json".utf8).write(to: url)

        let store = TaskStore(fileURL: url)
        let loaded = store.load()
        XCTAssertTrue(loaded.isEmpty)
        XCTAssertNotNil(store.lastLoadCorruptionURL, "corruption must be observable, not silent")
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.lastLoadCorruptionURL!.path),
                      "corrupt bytes must be preserved for recovery")
    }

    func testAppModelSurfacesCorruptionQuarantineOnLoad() throws {
        let url = tempURL()
        try Data("garbage".utf8).write(to: url)
        let model = AppModel(store: TaskStore(fileURL: url))
        XCTAssertNotNil(model.loadCorruptionQuarantineURL)
    }

    func testChatStoreCorruptFileIsQuarantined() throws {
        let url = tempURL()
        try Data("}{ not conversations".utf8).write(to: url)
        let store = ChatStore(fileURL: url)
        XCTAssertTrue(store.load().isEmpty)
        XCTAssertNotNil(store.lastLoadCorruptionURL)
    }

    func testMemoryStoreNonArrayCorruptFileIsQuarantined() throws {
        let url = tempURL()
        try Data("{\"not\":\"an array\"}".utf8).write(to: url)
        let store = MemoryStore(fileURL: url)
        XCTAssertTrue(store.load().isEmpty)
        XCTAssertNotNil(store.lastLoadCorruptionURL)
    }

    func testProviderStoreCorruptFileIsQuarantinedNotSilentlyReset() throws {
        let url = tempURL()
        try Data("corrupt providers".utf8).write(to: url)
        let store = ProviderStore(fileURL: url, secretStore: InMemorySecretStore())
        XCTAssertNotNil(store.lastLoadCorruptionURL,
                        "a corrupt providers.json must be quarantined, not silently reset to defaults")
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.lastLoadCorruptionURL!.path))
    }

    // MARK: Success path stays intact (no false failure)

    func testSuccessfulSaveClearsErrorAndPersists() throws {
        let url = tempURL()
        let model = AppModel(store: TaskStore(fileURL: url))
        model.add(PetTask(title: "会保存的任务"))
        XCTAssertNil(model.lastPersistenceError)

        let reloaded = AppModel(store: TaskStore(fileURL: url))
        XCTAssertEqual(reloaded.tasks.first?.title, "会保存的任务")
        XCTAssertNil(reloaded.loadCorruptionQuarantineURL)
    }
}
