import Foundation
import AICore

public protocol AgentRunEventPersisting: Sendable {
    func append(_ event: AgentEventEnvelope) async throws
    func loadEvents(taskID: UUID) async throws -> [AgentEventEnvelope]
    func loadEvents(runID: UUID) async throws -> [AgentEventEnvelope]
    func deleteEvents(taskID: UUID) async throws
    func prune(maxTaskDirectories: Int, maxRunFilesPerTask: Int) async throws
}

public actor AgentRunEventStore: AgentRunEventPersisting {
    public enum StoreError: Error, Sendable {
        case invalidDirectory
    }

    private let baseDirectory: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(baseDirectory: URL) {
        self.baseDirectory = baseDirectory
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        decoder.dateDecodingStrategy = .iso8601
    }

    public static func defaultStore() -> AgentRunEventStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DeskPet", isDirectory: true)
            .appendingPathComponent("AgentRunEvents", isDirectory: true)
        return AgentRunEventStore(baseDirectory: base)
    }

    public func append(_ event: AgentEventEnvelope) async throws {
        let safe = AgentEventRedactor.redact(event, level: .diagnostic)
        let fileURL = runFileURL(taskID: safe.taskID, runID: safe.runID)
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        // Production is encryption-required; legacy plaintext is available
        // only under SealedStore's explicit test policy.
        let line = try encoder.encode(safe)
        let payload = try SealedStore.sealLine(line)
        let framed = payload + Data([0x0A])
        if FileManager.default.fileExists(atPath: fileURL.path) {
            let handle = try FileHandle(forWritingTo: fileURL)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: framed)
        } else {
            try framed.write(to: fileURL, options: .atomic)
        }
    }

    public func loadEvents(taskID: UUID) async throws -> [AgentEventEnvelope] {
        let taskURL = taskDirectoryURL(taskID)
        guard FileManager.default.fileExists(atPath: taskURL.path) else { return [] }
        let files = try FileManager.default.contentsOfDirectory(at: taskURL,
                                                                includingPropertiesForKeys: [.contentModificationDateKey],
                                                                options: [.skipsHiddenFiles])
            .filter { $0.pathExtension == "jsonl" }
        var loaded: [AgentEventEnvelope] = []
        for file in files {
            loaded.append(contentsOf: try loadFile(file))
        }
        return loaded.sortedForReplay()
    }

    public func loadEvents(runID: UUID) async throws -> [AgentEventEnvelope] {
        guard FileManager.default.fileExists(atPath: baseDirectory.path) else { return [] }
        let taskDirectories = try FileManager.default.contentsOfDirectory(at: baseDirectory,
                                                                          includingPropertiesForKeys: nil,
                                                                          options: [.skipsHiddenFiles])
        for taskDirectory in taskDirectories {
            let fileURL = taskDirectory.appendingPathComponent(runID.uuidString).appendingPathExtension("jsonl")
            if FileManager.default.fileExists(atPath: fileURL.path) {
                return try loadFile(fileURL).sortedForReplay()
            }
        }
        return []
    }

    public func deleteEvents(taskID: UUID) async throws {
        let taskURL = taskDirectoryURL(taskID)
        guard FileManager.default.fileExists(atPath: taskURL.path) else { return }
        try FileManager.default.removeItem(at: taskURL)
    }

    public func prune(maxTaskDirectories: Int = 200, maxRunFilesPerTask: Int = 20) async throws {
        guard FileManager.default.fileExists(atPath: baseDirectory.path) else { return }
        let taskDirectories = try FileManager.default.contentsOfDirectory(at: baseDirectory,
                                                                          includingPropertiesForKeys: [.contentModificationDateKey],
                                                                          options: [.skipsHiddenFiles])
        let orderedTasks = taskDirectories.sortedByModificationDateDescending()
        for directory in orderedTasks.dropFirst(max(1, maxTaskDirectories)) {
            try? FileManager.default.removeItem(at: directory)
        }
        for directory in orderedTasks.prefix(max(1, maxTaskDirectories)) {
            let files = (try? FileManager.default.contentsOfDirectory(at: directory,
                                                                      includingPropertiesForKeys: [.contentModificationDateKey],
                                                                      options: [.skipsHiddenFiles])) ?? []
            let runFiles = files.filter { $0.pathExtension == "jsonl" }.sortedByModificationDateDescending()
            for file in runFiles.dropFirst(max(1, maxRunFilesPerTask)) {
                try? FileManager.default.removeItem(at: file)
            }
        }
    }

    private func loadFile(_ url: URL) throws -> [AgentEventEnvelope] {
        let data = try Data(contentsOf: url)
        guard let raw = String(data: data, encoding: .utf8) else { return [] }
        return raw.split(separator: "\n").compactMap { line in
            guard let lineData = line.data(using: .utf8),
                  let plain = try? SealedStore.openLine(lineData),
                  let decoded = try? decoder.decode(AgentEventEnvelope.self, from: plain) else {
                return nil
            }
            return AgentEventRedactor.redact(decoded, level: .diagnostic)
        }
    }

    private func taskDirectoryURL(_ taskID: UUID) -> URL {
        baseDirectory.appendingPathComponent(taskID.uuidString, isDirectory: true)
    }

    private func runFileURL(taskID: UUID, runID: UUID) -> URL {
        taskDirectoryURL(taskID).appendingPathComponent(runID.uuidString).appendingPathExtension("jsonl")
    }
}

private extension Array where Element == URL {
    func sortedByModificationDateDescending() -> [URL] {
        sorted { lhs, rhs in
            let lhsDate = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let rhsDate = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            if lhsDate != rhsDate { return lhsDate > rhsDate }
            return lhs.lastPathComponent < rhs.lastPathComponent
        }
    }
}
