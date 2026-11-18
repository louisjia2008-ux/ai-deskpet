import Foundation
import AICore

// P14-C — Durable Audit Log.
//
// The base `RuntimeAuditLog` (Sources/PetAgentRuntime/RuntimeAuditLog.swift) is
// in-memory only — it does NOT survive a process restart, which breaks INV-DUR-05
// ("restart must not lose active tasks"). P14-C adds a JSONL-backed sink that
// appends every audit event to a file under the durable base directory.
//
// Recovery classification (P14-G) consumes this log to determine whether a task
// in a non-terminal state is resumable, recoverable, or needs user review.

public actor DurableAuditLogStore: RuntimeAuditSink {
    private let url: URL
    private let clock: @Sendable () -> Date
    private let fileManager: FileManager
    private var handle: FileHandle?

    public init(url: URL,
                clock: @escaping @Sendable () -> Date = { Date() },
                fileManager: FileManager = .default) {
        self.url = url
        self.clock = clock
        self.fileManager = fileManager
    }

    public static func defaultStore() -> DurableAuditLogStore {
        let base = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("DeskPet", isDirectory: true)
            .appendingPathComponent("DurableAudit.jsonl")
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("DeskPet-DurableAudit.jsonl")
        return DurableAuditLogStore(url: base)
    }

    private func ensureHandle() throws -> FileHandle {
        if let handle { return handle }
        try fileManager.createDirectory(at: url.deletingLastPathComponent(),
                                        withIntermediateDirectories: true)
        if !fileManager.fileExists(atPath: url.path) {
            fileManager.createFile(atPath: url.path, contents: nil)
        }
        let h = try FileHandle(forWritingTo: url)
        try h.seekToEnd()
        handle = h
        return h
    }

    public func record(_ event: RuntimeAuditEvent) async {
        let stamped = RuntimeAuditEvent(kind: event.kind,
                                        capabilityID: event.capabilityID,
                                        correlationID: event.correlationID,
                                        summary: event.summary,
                                        timestamp: event.timestamp)
        do {
            let json = try Self.encoder.encode(stamped)
            let payload = try SealedStore.sealLine(json)
            let handle = try ensureHandle()
            try handle.write(contentsOf: payload + Data("\n".utf8))
            try handle.synchronize()
        } catch {
            // Audit-write failures must not break runtime; in-memory InMemoryAuditSink
            // remains the source of truth within the current process.
        }
    }

    /// Read every persisted event back. Used by recovery classification on launch.
    /// D3: sealed lines decrypt when keyed; legacy plaintext lines pass through.
    public func readAll() async -> [RuntimeAuditEvent] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        var events: [RuntimeAuditEvent] = []
        for line in data.split(separator: 0x0A) where !line.isEmpty {
            guard let plain = try? SealedStore.openLine(Data(line)),
                  let event = try? Self.decoder.decode(RuntimeAuditEvent.self, from: plain) else {
                continue
            }
            events.append(event)
        }
        return events
    }

    /// Close the file handle. Call on shutdown.
    public func close() {
        try? handle?.close()
        handle = nil
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}
