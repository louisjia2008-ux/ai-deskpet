import Foundation

/// P18.6 — Persistence failure observability helper for the local-first JSON stores
/// (`ChatStore`, `TaskStore`, `ScheduledTaskStore`, `MemoryStore`, `ProviderStore`,
/// `RelationshipStore`). These stores are the authoritative durable copy of
/// CRITICAL user state (conversations, tasks, memory, provider config).
///
/// This is deliberately a small, stateless utility — **not** a cross-cutting
/// "persistence manager". It exists only because six structurally identical
/// stores share one corruption-handling need, so the safe behaviour lives in
/// exactly one tested place instead of six hand-rolled copies.
///
/// The two invariants it protects:
///
///  1. A durable write that fails must be *observable* — callers use the throwing
///     Foundation write directly and surface the error; there is no `try?` that
///     turns a failed write into a silent success. (Handled at each call site.)
///
///  2. A durable file that exists but cannot be decoded must **not** be silently
///     treated as "no data" and then overwritten by the next save (which would
///     permanently destroy recoverable bytes — e.g. a forward-incompatible file
///     written by a newer app version, or an externally corrupted file). Instead
///     the corrupt bytes are moved aside (quarantined) so they survive for
///     recovery, and the quarantine is reported so the owner can surface a
///     degraded/recovery state rather than claiming an empty history is genuine.
enum DurableJSONFile {

    /// Classifies the on-disk state of a durable JSON file for load-time handling.
    enum LoadState {
        /// No file (or an empty file) exists yet — a legitimately fresh/empty state.
        case absent
        /// A non-empty file exists; its bytes are provided for decoding.
        case present(Data)
    }

    /// Reads the raw bytes of a durable file, distinguishing "absent" (a
    /// legitimately fresh/empty state — no file, or a zero-byte file) from
    /// "present" (a non-empty file whose bytes the caller must attempt to decode).
    /// A non-empty file that decodes to garbage is the caller's responsibility to
    /// quarantine via `quarantineCorrupt(at:)`.
    static func read(at url: URL, fileManager: FileManager = .default) -> LoadState {
        guard fileManager.fileExists(atPath: url.path) else { return .absent }
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { return .absent }
        return .present(data)
    }

    /// Moves a corrupt/undecodable durable file aside so its bytes are preserved for
    /// recovery instead of being clobbered by the next save. Returns the quarantine
    /// URL on success, or `nil` if the file could not be moved (in which case the
    /// caller has still surfaced the corruption as observable state).
    ///
    /// Best-effort by design: quarantine is a recovery convenience, not itself a
    /// critical durable write. The *observable corruption signal* (the returned URL
    /// being non-nil, or the owner's recorded flag) is the contract; the physical
    /// move failing does not create a false success anywhere.
    @discardableResult
    static func quarantineCorrupt(at url: URL, fileManager: FileManager = .default) -> URL? {
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        let stamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        let quarantineURL = url.deletingLastPathComponent()
            .appendingPathComponent("\(url.lastPathComponent).corrupt-\(stamp)")
        do {
            if fileManager.fileExists(atPath: quarantineURL.path) {
                try fileManager.removeItem(at: quarantineURL)
            }
            try fileManager.moveItem(at: url, to: quarantineURL)
            return quarantineURL
        } catch {
            return nil
        }
    }
}
