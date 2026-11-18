import Foundation
import AICore

/// Local persistence for memories (doc §12.2 仅本地 option respected at the sync layer in M7).
@MainActor
final class MemoryStore {
    private let url: URL
    private(set) var lastDiagnostics: [String] = []
    private let encoder: JSONEncoder = {
        let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; e.outputFormatting = [.prettyPrinted, .sortedKeys]; return e
    }()
    private let decoder: JSONDecoder = {
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d
    }()

    init(fileURL: URL? = nil) {
        if let fileURL { self.url = fileURL }
        else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("DeskPet", isDirectory: true)
            try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            self.url = base.appendingPathComponent("memories.json")
        }
    }

    /// P18.6 — set when `load()` finds an existing file that is not even a decodable
    /// JSON array and quarantines it, so corrupt memory is never silently reported
    /// empty and then clobbered by the next save.
    private(set) var lastLoadCorruptionURL: URL?

    func load() -> [MemoryItem] {
        lastDiagnostics.removeAll()
        lastLoadCorruptionURL = nil
        let secure: SealedStore.LoadState
        do {
            secure = try SealedStore.load(at: url)
        } catch {
            // Sealed but unreadable (no key): NOT corruption — leave the bytes
            // for later recovery and report through diagnostics.
            lastDiagnostics.append("sealed store unavailable: \(error)")
            return []
        }
        guard case .data(let data, _) = secure else { return [] }
        if let items = try? decoder.decode([MemoryItem].self, from: data) {
            return finish(MemoryLegacyMigrator.migrate(items))
        }
        guard let root = try? JSONSerialization.jsonObject(with: data),
              let array = root as? [Any] else {
            // Present but not even a JSON array: preserve the bytes for recovery
            // rather than letting the next save overwrite them, and report it.
            lastDiagnostics.append("memory store is not a decodable array")
            lastLoadCorruptionURL = DurableJSONFile.quarantineCorrupt(at: url)
            return []
        }
        var loaded: [MemoryItem] = []
        for (index, object) in array.enumerated() {
            guard JSONSerialization.isValidJSONObject(object),
                  let itemData = try? JSONSerialization.data(withJSONObject: object),
                  let item = try? decoder.decode(MemoryItem.self, from: itemData) else {
                lastDiagnostics.append("memory item \(index) could not be decoded")
                continue
            }
            loaded.append(item)
        }
        return finish(MemoryLegacyMigrator.migrate(loaded))
    }

    /// Successful decode choke point: re-seals legacy plaintext on first read
    /// when a key is wired (backup kept once beside the original).
    private func finish(_ items: [MemoryItem]) -> [MemoryItem] {
        SealedStore.migratePlaintext(at: url) { try save(items) }
        return items
    }

    /// P18.6 — throws on encode/write failure so the caller can surface an
    /// observable persistence error instead of silently losing the write.
    /// Sealed when a key is wired; throws `.keyUnavailable` (fail-closed) for
    /// sealed files without a key — never downgrades.
    func save(_ items: [MemoryItem]) throws {
        let data = try encoder.encode(items)
        try SealedStore.save(data, to: url)
    }
}
