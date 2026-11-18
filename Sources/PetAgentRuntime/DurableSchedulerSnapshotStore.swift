import Foundation
import AICore

// P14-C — Durable Scheduler Persistence.
//
// Persists `AgentTaskSchedulerSnapshot` to disk so the in-memory scheduler can
// be reconstructed after a process restart. Writes are atomic; reload is
// fault-tolerant. The snapshot is rewritten on every scheduler mutation that
// matters for recovery (state transitions only — not transient reads).
//
// File layout:
//   <baseDirectory>/scheduler.json  — single-file atomic snapshot.

public actor DurableSchedulerSnapshotStore {
    private let url: URL
    private let fileManager: FileManager

    public init(url: URL, fileManager: FileManager = .default) {
        self.url = url
        self.fileManager = fileManager
    }

    public static func defaultStore() -> DurableSchedulerSnapshotStore {
        let base = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("DeskPet", isDirectory: true)
            .appendingPathComponent("scheduler.json")
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("DeskPet-scheduler.json")
        return DurableSchedulerSnapshotStore(url: base)
    }

    public func save(_ snapshot: AgentTaskSchedulerSnapshot) async {
        do {
            try fileManager.createDirectory(at: url.deletingLastPathComponent(),
                                            withIntermediateDirectories: true)
            // D3: sealed when keyed (keyless-sealed overwrite refused).
            let data = try SealedStore.sealForWrite(Self.encoder.encode(snapshot), url: url)
            let tmp = url.deletingLastPathComponent()
                .appendingPathComponent(".tmp-scheduler-\(UUID().uuidString)")
            try data.write(to: tmp, options: [.atomic])
            if fileManager.fileExists(atPath: url.path) {
                _ = try fileManager.replaceItemAt(url, withItemAt: tmp)
            } else {
                try fileManager.moveItem(at: tmp, to: url)
            }
        } catch {
            // Snapshot save failure is logged but does not propagate.
            // Recovery on next load will use the previous persisted snapshot
            // (or none if this is the first ever save).
        }
    }

    public func load() async -> AgentTaskSchedulerSnapshot? {
        // D3: sealed-aware read (keyless-sealed files skipped, kept).
        guard let data = try? Data(contentsOf: url),
              let plain = try? SealedStore.openForRead(data) else { return nil }
        return try? Self.decoder.decode(AgentTaskSchedulerSnapshot.self, from: plain)
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys]
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}
