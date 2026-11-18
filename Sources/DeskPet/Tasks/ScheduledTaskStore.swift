import Foundation
import AICore

/// Local-first JSON persistence for scheduled tasks (mirrors `TaskStore`). Plain JSON in Application
/// Support so it is exportable and deletable.
@MainActor
final class ScheduledTaskStore {
    private let url: URL
    private let encoder: JSONEncoder = {
        let e = JSONEncoder(); e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .iso8601; return e
    }()
    private let decoder: JSONDecoder = {
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d
    }()

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.url = fileURL
        } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("DeskPet", isDirectory: true)
            try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            self.url = base.appendingPathComponent("scheduled_tasks.json")
        }
    }

    /// P18.6 — set when `load()` finds an existing-but-undecodable file and
    /// quarantines it, so a corrupt schedule file is never silently reported empty.
    private(set) var lastLoadCorruptionURL: URL?

    func load() -> [ScheduledTask] {
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
            let tasks = try decoder.decode([ScheduledTask].self, from: data)
            SealedStore.migratePlaintext(at: url) { try save(tasks) }
            return tasks
        } catch {
            lastLoadCorruptionURL = DurableJSONFile.quarantineCorrupt(at: url)
            return []
        }
    }

    /// P18.6 — throws on encode/write failure so the caller can surface an
    /// observable persistence error instead of silently losing the write.
    /// Sealed when a key is wired (D3); fail-closed on sealed-without-key.
    func save(_ tasks: [ScheduledTask]) throws {
        let data = try encoder.encode(tasks)
        try SealedStore.save(data, to: url)
    }
}
