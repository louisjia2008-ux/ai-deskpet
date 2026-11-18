import Foundation
import AICore

/// Local-first persistence for tasks (doc §15.1 — 本地写入；iCloud 同步在 M7). Plain JSON in
/// Application Support so data is exportable and deletable (doc §17.2).
@MainActor
final class TaskStore {

    private let url: URL
    private let encoder: JSONEncoder = {
        let e = JSONEncoder(); e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .iso8601; return e
    }()
    private let decoder: JSONDecoder = {
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d
    }()

    /// Inject a custom location for tests; defaults to Application Support/DeskPet/tasks.json.
    init(fileURL: URL? = nil) {
        if let fileURL {
            self.url = fileURL
        } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("DeskPet", isDirectory: true)
            try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            self.url = base.appendingPathComponent("tasks.json")
        }
    }

    /// P18.6 — set when `load()` finds an existing-but-undecodable file and
    /// quarantines it. The owner surfaces this as a degraded/recovery state so a
    /// corrupt file is never silently reported as "no tasks".
    private(set) var lastLoadCorruptionURL: URL?

    func load() -> [PetTask] {
        lastLoadCorruptionURL = nil
        let secure: SealedStore.LoadState
        do {
            secure = try SealedStore.load(at: url)
        } catch {
            // Sealed but unreadable (no key): NOT corruption — leave bytes.
            return []
        }
        guard case .data(let data, _) = secure else { return [] }
        do {
            let tasks = try decoder.decode([PetTask].self, from: data)
            SealedStore.migratePlaintext(at: url) { try save(tasks) }
            return tasks
        } catch {
            // Present but corrupt: preserve the bytes for recovery instead of
            // letting the next save clobber them, and report the corruption.
            lastLoadCorruptionURL = DurableJSONFile.quarantineCorrupt(at: url)
            return []
        }
    }

    /// P18.6 — throws on encode/write failure so the caller can surface an
    /// observable persistence error instead of silently losing the write.
    /// Sealed when a key is wired (D3); fail-closed on sealed-without-key.
    func save(_ tasks: [PetTask]) throws {
        let data = try encoder.encode(tasks)
        try SealedStore.save(data, to: url)
    }
}
