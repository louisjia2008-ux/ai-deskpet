import Foundation
import AICore
import PetAgentRuntime

/// Durable append-only runtime ledger. It stores task/message IDs, state and sequence metadata only;
/// prompts, model tokens, credentials and capability secrets are deliberately excluded.
actor JSONAgentTaskLedgerStore: AgentTaskLedgerPersisting {
    private let url: URL
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }()
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.url = fileURL
            try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(),
                                                     withIntermediateDirectories: true)
        } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("DeskPet", isDirectory: true)
            try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            self.url = base.appendingPathComponent("agent_task_ledger.json")
        }
    }

    func append(_ event: AgentTaskLedgerEvent) async throws {
        var events = try load()
        if let op = event.operationID, events.contains(where: { $0.operationID == op }) {
            return
        }
        let lastSeq = events.filter { $0.taskID == event.taskID }.map(\.sequence).max() ?? -1
        guard event.sequence > lastSeq else {
            throw LedgerStoreError.nonMonotonicSequence(taskID: event.taskID)
        }
        events.append(event)
        try save(events)
    }

    func events(for taskID: UUID) async throws -> [AgentTaskLedgerEvent] {
        try load().filter { $0.taskID == taskID }.sorted { $0.sequence < $1.sequence }
    }

    func activeTasks() async throws -> [AgentTaskSnapshot] {
        let grouped = Dictionary(grouping: try load(), by: \.taskID)
        return grouped.values.compactMap { taskEvents in
            guard let last = taskEvents.max(by: { $0.sequence < $1.sequence }),
                  !last.state.isTerminal else { return nil }
            return AgentTaskSnapshot(taskID: last.taskID,
                                     attemptID: last.attemptID,
                                     conversationID: last.conversationID,
                                     userMessageID: last.userMessageID,
                                     assistantMessageID: last.assistantMessageID,
                                     state: last.state,
                                     lastSequence: last.sequence,
                                     retryOfTaskID: last.retryOfTaskID,
                                     regeneratedFromMessageID: last.regeneratedFromMessageID,
                                     updatedAt: last.updatedAt)
        }
    }

    func hasOperationID(_ operationID: String) async throws -> Bool {
        try load().contains { $0.operationID == operationID }
    }

    private func load() throws -> [AgentTaskLedgerEvent] {
        guard case .data(let data, let wasSealed) = try SealedStore.load(at: url) else {
            return []
        }
        let events = try decoder.decode([AgentTaskLedgerEvent].self, from: data)
        if !wasSealed {
            SealedStore.migratePlaintext(at: url) { try save(events) }
        }
        return events
    }

    private func save(_ events: [AgentTaskLedgerEvent]) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        let data = try encoder.encode(events)
        try SealedStore.save(data, to: url)
    }
}

enum LedgerStoreError: Error, Equatable {
    case nonMonotonicSequence(taskID: UUID)
}
