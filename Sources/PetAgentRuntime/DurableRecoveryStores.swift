import Foundation
import AICore

public enum AgentDurableRecoveryStoreError: Error, Equatable, Sendable {
    case invalidDirectory
    case corruptedCheckpoint(String)
    case checkpointSequenceAhead(checkpoint: UInt64, events: UInt64)
    case checkpointSequenceDuplicate(UInt64)
    case checkpointSequenceGap(expected: UInt64, actual: UInt64)
    /// P18.1 — PAR-005 closure. Raised by
    /// `PersistedModelConformanceRoutingPolicy.init(profiles:)` when
    /// the on-disk profile set contains two profiles keyed by the
    /// same `(providerID, modelID)`. Surfaces as a typed error instead
    /// of `fatalError`.
    case duplicateConformanceProfile(providerID: String, modelID: String,
                                     firstProfileID: String, secondProfileID: String)
}

public actor AgentCheckpointStore {
    private let baseDirectory: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(baseDirectory: URL) {
        self.baseDirectory = baseDirectory
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        decoder.dateDecodingStrategy = .iso8601
    }

    public static func defaultStore() -> AgentCheckpointStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DeskPet", isDirectory: true)
            .appendingPathComponent("AgentCheckpoints", isDirectory: true)
        return AgentCheckpointStore(baseDirectory: base)
    }

    public func save(_ checkpoint: AgentCheckpoint) throws {
        var updated = checkpoint
        if let existing = try? load(taskID: checkpoint.taskID, runID: checkpoint.runID) {
            updated = mergeForDurableSave(incoming: updated, existing: existing)
        }
        updated.updatedAt = Date()
        let data = try encoder.encode(updated)
        let url = fileURL(taskID: updated.taskID, runID: updated.runID)
        // D3: sealed when keyed (durability-preserving atomicWrite untouched).
        try atomicWrite(SealedStore.sealForWrite(data, url: url), to: url)
    }

    public func load(taskID: UUID, runID: UUID) throws -> AgentCheckpoint? {
        let url = fileURL(taskID: taskID, runID: runID)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do {
            // D3: sealed files decrypt when keyed; keyless-sealed reads throw
            // (surfaced as corruption — bytes stay for later recovery).
            return try decoder.decode(AgentCheckpoint.self,
                                      from: SealedStore.openForRead(Data(contentsOf: url)))
        } catch {
            throw AgentDurableRecoveryStoreError.corruptedCheckpoint(url.lastPathComponent)
        }
    }

    public func latest(taskID: UUID) throws -> AgentCheckpoint? {
        let directory = taskDirectoryURL(taskID)
        guard FileManager.default.fileExists(atPath: directory.path) else { return nil }
        let files = try FileManager.default.contentsOfDirectory(at: directory,
                                                                includingPropertiesForKeys: [.contentModificationDateKey],
                                                                options: [.skipsHiddenFiles])
            .filter { $0.pathExtension == "json" }
            .sortedByModificationDateDescending()
        for file in files {
            // D3: sealed-aware read (keyless-sealed files are skipped, kept).
            if let data = try? Data(contentsOf: file),
               let plain = try? SealedStore.openForRead(data),
               let checkpoint = try? decoder.decode(AgentCheckpoint.self, from: plain) {
                return checkpoint
            }
        }
        return nil
    }

    public func delete(taskID: UUID, runID: UUID) throws {
        let url = fileURL(taskID: taskID, runID: runID)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }

    public func prune(maxTaskDirectories: Int = 200, maxCheckpointsPerTask: Int = 20) throws {
        guard FileManager.default.fileExists(atPath: baseDirectory.path) else { return }
        let tasks = try FileManager.default.contentsOfDirectory(at: baseDirectory,
                                                               includingPropertiesForKeys: [.contentModificationDateKey],
                                                               options: [.skipsHiddenFiles])
            .sortedByModificationDateDescending()
        for directory in tasks.dropFirst(max(1, maxTaskDirectories)) {
            try? FileManager.default.removeItem(at: directory)
        }
        for directory in tasks.prefix(max(1, maxTaskDirectories)) {
            let checkpoints = (try? FileManager.default.contentsOfDirectory(at: directory,
                                                                            includingPropertiesForKeys: [.contentModificationDateKey],
                                                                            options: [.skipsHiddenFiles])) ?? []
            for file in checkpoints.filter({ $0.pathExtension == "json" })
                .sortedByModificationDateDescending()
                .dropFirst(max(1, maxCheckpointsPerTask)) {
                try? FileManager.default.removeItem(at: file)
            }
        }
    }

    private func taskDirectoryURL(_ taskID: UUID) -> URL {
        baseDirectory.appendingPathComponent(taskID.uuidString, isDirectory: true)
    }

    private func fileURL(taskID: UUID, runID: UUID) -> URL {
        taskDirectoryURL(taskID).appendingPathComponent(runID.uuidString).appendingPathExtension("json")
    }

    private func atomicWrite(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        FileManager.default.createFile(atPath: tmp.path, contents: nil)
        let handle = try FileHandle(forWritingTo: tmp)
        do {
            try handle.write(contentsOf: data)
            try handle.synchronize()
            try handle.close()
        } catch {
            try? handle.close()
            throw error
        }
        if FileManager.default.fileExists(atPath: url.path) {
            _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp, backupItemName: nil, options: [])
        } else {
            try FileManager.default.moveItem(at: tmp, to: url)
        }
    }

    private func mergeForDurableSave(incoming: AgentCheckpoint,
                                     existing: AgentCheckpoint) -> AgentCheckpoint {
        var merged = incoming
        merged.domainPayloads = mergedDomainPayloads(existing: existing.domainPayloads,
                                                     incoming: incoming.domainPayloads)
        merged.completedToolCallIDs = Array(Set(existing.completedToolCallIDs + incoming.completedToolCallIDs)).sorted()
        merged.completedSideEffectOperationIDs = Array(Set(existing.completedSideEffectOperationIDs + incoming.completedSideEffectOperationIDs)).sorted()
        merged.evidenceIDs = Array(Set(existing.evidenceIDs + incoming.evidenceIDs)).sorted()
        merged.lastSequence = max(existing.lastSequence, incoming.lastSequence)
        merged.eventCount = max(existing.eventCount, incoming.eventCount)
        if merged.resultDocument == nil {
            merged.resultDocument = existing.resultDocument
        }
        if merged.currentUIRevision == nil {
            merged.currentUIRevision = existing.currentUIRevision
        }
        if merged.projection.resultDocument == nil {
            merged.projection.resultDocument = existing.projection.resultDocument
        }
        if existing.projection.state.isTerminal && !incoming.projection.state.isTerminal {
            merged.projection.state = existing.projection.state
            merged.projection.completedAt = existing.projection.completedAt
            merged.phase = .terminal
        }
        return merged
    }

    private func mergedDomainPayloads(existing: [String: AgentJSONValue],
                                      incoming: [String: AgentJSONValue]) -> [String: AgentJSONValue] {
        var merged = existing
        for (key, value) in incoming {
            merged[key] = value
        }
        let key = LocalDiscoveryWorkflowSnapshot.domainPayloadKey
        guard let existingPayload = existing[key],
              let incomingPayload = incoming[key],
              let existingSnapshot = try? LocalDiscoveryJSON.decoded(LocalDiscoveryWorkflowSnapshot.self, from: existingPayload),
              let incomingSnapshot = try? LocalDiscoveryJSON.decoded(LocalDiscoveryWorkflowSnapshot.self, from: incomingPayload),
              existingSnapshot.currentStage > incomingSnapshot.currentStage else {
            return merged
        }
        merged[key] = existingPayload
        return merged
    }
}

public enum AgentSideEffectBeginResult: Sendable, Equatable {
    case started(operationID: String)
    case alreadySucceeded(ToolExecutionResult)
    case blockedOutcomeUnknown(operationID: String)
}

public struct AgentSideEffectLedgerEntry: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var schemaVersion: Int
    public var record: AgentSideEffectRecord
    public var result: ToolExecutionResult?
    public var appendedAt: Date

    public init(id: UUID = UUID(),
                schemaVersion: Int = 1,
                record: AgentSideEffectRecord,
                result: ToolExecutionResult? = nil,
                appendedAt: Date = Date()) {
        self.id = id
        self.schemaVersion = max(1, schemaVersion)
        self.record = record
        self.result = result
        self.appendedAt = appendedAt
    }
}

public actor AgentSideEffectLedgerStore {
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

    public static func defaultStore() -> AgentSideEffectLedgerStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DeskPet", isDirectory: true)
            .appendingPathComponent("AgentSideEffects", isDirectory: true)
        return AgentSideEffectLedgerStore(baseDirectory: base)
    }

    public static func idempotencyKey(taskID: UUID,
                                      runID: UUID,
                                      toolID: ToolID,
                                      arguments: AgentJSONValue) -> String {
        let raw = "\(taskID.uuidString)|\(runID.uuidString)|\(toolID.rawValue)|\(arguments.sanitized().jsonString)"
        return AgentSideEffectLedger.digest(.string(raw))
    }

    public func begin(operationID: String,
                      idempotencyKey: String,
                      taskID: UUID,
                      runID: UUID,
                      toolID: ToolID,
                      capabilityID: String?,
                      operationKind: String,
                      arguments: AgentJSONValue,
                      retryPolicy: AgentRetryPolicy = AgentRetryPolicy(maxAttempts: 1),
                      at date: Date = Date()) throws -> AgentSideEffectBeginResult {
        let safeKey = AgentEventRedactor.safeIdentifier(idempotencyKey)
        if let latest = try latestEntry(taskID: taskID, runID: runID, idempotencyKey: safeKey) {
            switch latest.record.status {
            case .succeeded:
                return .alreadySucceeded(latest.result ?? ToolExecutionResult(status: .success,
                                                                               userSafeSummary: "此前操作已完成",
                                                                               structuredData: .object(["idempotencyKey": .string(safeKey)])))
            case .started, .authorized, .proposed, .outcomeUnknown:
                let unknown = transition(operationID: latest.record.operationID,
                                         idempotencyKey: safeKey,
                                         taskID: taskID,
                                         runID: runID,
                                         toolID: toolID,
                                         capabilityID: capabilityID,
                                         operationKind: operationKind,
                                         status: .outcomeUnknown,
                                         argumentsDigest: latest.record.argumentsHash,
                                         resultDigest: latest.record.resultHash,
                                         retryPolicy: retryPolicy,
                                         recoveryNotes: "previous side effect has no terminal outcome",
                                         createdAt: latest.record.createdAt,
                                         startedAt: latest.record.startedAt,
                                         completedAt: nil,
                                         updatedAt: date)
                try append(AgentSideEffectLedgerEntry(record: unknown), taskID: taskID, runID: runID)
                return .blockedOutcomeUnknown(operationID: latest.record.operationID)
            case .failed, .cancelled:
                break
            }
        }

        let record = transition(operationID: operationID,
                                idempotencyKey: safeKey,
                                taskID: taskID,
                                runID: runID,
                                toolID: toolID,
                                capabilityID: capabilityID,
                                operationKind: operationKind,
                                status: .started,
                                argumentsDigest: AgentSideEffectLedger.digest(arguments),
                                resultDigest: nil,
                                retryPolicy: retryPolicy,
                                recoveryNotes: nil,
                                createdAt: date,
                                startedAt: date,
                                completedAt: nil,
                                updatedAt: date)
        try append(AgentSideEffectLedgerEntry(record: record), taskID: taskID, runID: runID)
        return .started(operationID: record.operationID)
    }

    public func complete(operationID: String,
                         taskID: UUID,
                         runID: UUID,
                         status: AgentSideEffectStatus,
                         result: ToolExecutionResult,
                         at date: Date = Date()) throws {
        let latest = try latestEntry(taskID: taskID, runID: runID, operationID: operationID)
        guard latest?.record.status != .succeeded else { return }
        let previous = latest?.record
        let terminal = transition(operationID: operationID,
                                  idempotencyKey: previous?.idempotencyKey ?? operationID,
                                  taskID: taskID,
                                  runID: runID,
                                  toolID: previous?.toolID,
                                  capabilityID: previous?.capabilityID,
                                  operationKind: previous?.operationKind ?? "tool.write",
                                  status: status,
                                  argumentsDigest: previous?.argumentsHash ?? "unknown",
                                  resultDigest: AgentSideEffectLedger.digest(result.structuredData),
                                  retryPolicy: previous?.retryPolicy,
                                  recoveryNotes: previous?.recoveryNotes,
                                  createdAt: previous?.createdAt ?? date,
                                  startedAt: previous?.startedAt,
                                  completedAt: date,
                                  updatedAt: date)
        try append(AgentSideEffectLedgerEntry(record: terminal, result: result), taskID: taskID, runID: runID)
    }

    public func loadEntries(taskID: UUID, runID: UUID) throws -> [AgentSideEffectLedgerEntry] {
        let url = fileURL(taskID: taskID, runID: runID)
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let raw = try String(contentsOf: url, encoding: .utf8)
        return raw.split(separator: "\n").compactMap { line in
            // D3: sealed lines decrypt when keyed; legacy lines pass through.
            guard let data = line.data(using: .utf8),
                  let plain = try? SealedStore.openLine(data) else { return nil }
            return try? decoder.decode(AgentSideEffectLedgerEntry.self, from: plain)
        }
    }

    public func loadLedger(taskID: UUID, runID: UUID) throws -> AgentSideEffectLedger {
        try AgentSideEffectLedger(records: loadEntries(taskID: taskID, runID: runID).map(\.record))
    }

    public func delete(taskID: UUID, runID: UUID) throws {
        let url = fileURL(taskID: taskID, runID: runID)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }

    private func latestEntry(taskID: UUID,
                             runID: UUID,
                             idempotencyKey: String) throws -> AgentSideEffectLedgerEntry? {
        try loadEntries(taskID: taskID, runID: runID)
            .last { $0.record.idempotencyKey == idempotencyKey }
    }

    private func latestEntry(taskID: UUID,
                             runID: UUID,
                             operationID: String) throws -> AgentSideEffectLedgerEntry? {
        let safe = AgentEventRedactor.safeIdentifier(operationID)
        return try loadEntries(taskID: taskID, runID: runID)
            .last { $0.record.operationID == safe }
    }

    private func append(_ entry: AgentSideEffectLedgerEntry,
                        taskID: UUID,
                        runID: UUID) throws {
        let url = fileURL(taskID: taskID, runID: runID)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let json = try encoder.encode(entry)
        let line = try SealedStore.sealLine(json) + Data([0x0A])
        if FileManager.default.fileExists(atPath: url.path) {
            // Atomic whole-file rewrite (R-A-01 closure). Appends are bounded
            // by side-effect volume per task/run, so the rewrite cost is
            // negligible. This guarantees no partial-write left over from a
            // crash, which is what `loadEntries` would otherwise silently
            // drop.
            let existing = (try? Data(contentsOf: url)) ?? Data()
            let combined = existing + line
            try atomicWrite(combined, to: url)
        } else {
            try atomicWrite(line, to: url)
        }
    }

    private func transition(operationID: String,
                            idempotencyKey: String,
                            taskID: UUID,
                            runID: UUID,
                            toolID: ToolID?,
                            capabilityID: String?,
                            operationKind: String,
                            status: AgentSideEffectStatus,
                            argumentsDigest: String,
                            resultDigest: String?,
                            retryPolicy: AgentRetryPolicy?,
                            recoveryNotes: String?,
                            createdAt: Date,
                            startedAt: Date?,
                            completedAt: Date?,
                            updatedAt: Date) -> AgentSideEffectRecord {
        AgentSideEffectRecord(operationID: operationID,
                              idempotencyKey: idempotencyKey,
                              taskID: taskID,
                              runID: runID,
                              toolID: toolID,
                              capabilityID: capabilityID,
                              operationKind: operationKind,
                              status: status,
                              argumentsHash: argumentsDigest,
                              resultHash: resultDigest,
                              retryPolicy: retryPolicy,
                              recoveryNotes: recoveryNotes,
                              createdAt: createdAt,
                              startedAt: startedAt,
                              completedAt: completedAt,
                              updatedAt: updatedAt)
    }

    private func runDirectoryURL(taskID: UUID, runID: UUID) -> URL {
        baseDirectory
            .appendingPathComponent(taskID.uuidString, isDirectory: true)
            .appendingPathComponent(runID.uuidString, isDirectory: true)
    }

    private func fileURL(taskID: UUID, runID: UUID) -> URL {
        runDirectoryURL(taskID: taskID, runID: runID).appendingPathComponent("side_effects.jsonl")
    }

    private func atomicWrite(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        FileManager.default.createFile(atPath: tmp.path, contents: nil)
        let handle = try FileHandle(forWritingTo: tmp)
        do {
            try handle.write(contentsOf: data)
            try handle.synchronize()
            try handle.close()
        } catch {
            try? handle.close()
            throw error
        }
        if FileManager.default.fileExists(atPath: url.path) {
            _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp, backupItemName: nil, options: [])
        } else {
            try FileManager.default.moveItem(at: tmp, to: url)
        }
    }
}

public actor ModelConformanceProfileStore {
    private let baseDirectory: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(baseDirectory: URL) {
        self.baseDirectory = baseDirectory
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        decoder.dateDecodingStrategy = .iso8601
    }

    public static func defaultStore() -> ModelConformanceProfileStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DeskPet", isDirectory: true)
            .appendingPathComponent("ModelConformanceProfiles", isDirectory: true)
        return ModelConformanceProfileStore(baseDirectory: base)
    }

    public func save(_ profile: ModelConformanceProfile) throws {
        let url = fileURL(for: profile)
        // D3: sealed when keyed (conformance metadata included for uniformity).
        try atomicWrite(SealedStore.sealForWrite(try encoder.encode(profile), url: url), to: url)
    }

    public func load(providerID: String,
                     modelID: String,
                     adapterVersion: String = "default",
                     conformanceVersion: Int = 1) throws -> ModelConformanceProfile? {
        let url = fileURL(providerID: providerID,
                          modelID: modelID,
                          adapterVersion: adapterVersion,
                          conformanceVersion: conformanceVersion)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try decoder.decode(ModelConformanceProfile.self,
                                  from: SealedStore.openForRead(Data(contentsOf: url)))
    }

    public func loadAll() throws -> [ModelConformanceProfile] {
        guard FileManager.default.fileExists(atPath: baseDirectory.path) else { return [] }
        let files = try FileManager.default.contentsOfDirectory(at: baseDirectory,
                                                                includingPropertiesForKeys: nil,
                                                                options: [.skipsHiddenFiles])
        return files.filter { $0.pathExtension == "json" }.compactMap { file in
            guard let data = try? Data(contentsOf: file),
                  let plain = try? SealedStore.openForRead(data) else { return nil }
            return try? decoder.decode(ModelConformanceProfile.self, from: plain)
        }
    }

    public func routingPolicy(now: Date = Date()) throws -> PersistedModelConformanceRoutingPolicy {
        // P18.1 — PAR-005. The throwing init surfaces duplicate-key
        // errors; we propagate them. Callers that prefer to absorb
        // duplicates (e.g. for diagnostics) can wrap this in a
        // do/catch and call the `allowingDuplicates: true` overload.
        do {
            return try PersistedModelConformanceRoutingPolicy(profiles: try loadAll(), now: now)
        } catch let error as AgentDurableRecoveryStoreError {
            if case .duplicateConformanceProfile = error {
                throw error
            }
            throw error
        }
    }

    private func fileURL(for profile: ModelConformanceProfile) -> URL {
        fileURL(providerID: profile.providerID ?? profile.providerType.rawValue,
                modelID: profile.modelID,
                adapterVersion: profile.adapterVersion,
                conformanceVersion: profile.conformanceVersion)
    }

    private func fileURL(providerID: String,
                         modelID: String,
                         adapterVersion: String,
                         conformanceVersion: Int) -> URL {
        let key = [providerID, modelID, adapterVersion, "v\(max(1, conformanceVersion))"]
            .map(AgentEventRedactor.safeIdentifier)
            .joined(separator: "__")
        return baseDirectory.appendingPathComponent(key).appendingPathExtension("json")
    }

    private func atomicWrite(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        FileManager.default.createFile(atPath: tmp.path, contents: nil)
        let handle = try FileHandle(forWritingTo: tmp)
        do {
            try handle.write(contentsOf: data)
            try handle.synchronize()
            try handle.close()
        } catch {
            try? handle.close()
            throw error
        }
        if FileManager.default.fileExists(atPath: url.path) {
            _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp, backupItemName: nil, options: [])
        } else {
            try FileManager.default.moveItem(at: tmp, to: url)
        }
    }
}

public struct PersistedModelConformanceRoutingPolicy: ModelRouter.ConformancePolicy {
    private var profilesByProviderAndModel: [String: ModelConformanceProfile]
    private var now: Date

    public init(profiles: [ModelConformanceProfile], now: Date = Date()) throws {
        // P18.1 — PAR-005 closure. Duplicate (providerID, modelID)
        // entries from on-disk recovery data indicate corrupt state.
        // We use `Dictionary(_:uniquingKeysWith:)` with a typed-error
        // collision policy: surface the first duplicate as a
        // `AgentDurableRecoveryStoreError.duplicateConformanceProfile`
        // so the caller can decide whether to fall back to safe-default
        // routing instead of crashing the app via fatalError.
        self.now = now
        self.profilesByProviderAndModel = try Dictionary(
            profiles.map { profile in
                (Self.key(providerID: profile.providerID ?? profile.providerType.rawValue,
                          modelID: profile.modelID), profile)
            },
            uniquingKeysWith: { first, second in
                throw AgentDurableRecoveryStoreError.duplicateConformanceProfile(
                    providerID: first.providerID ?? first.providerType.rawValue,
                    modelID: first.modelID,
                    firstProfileID: first.id,
                    secondProfileID: second.id)
            })
    }

    /// P18.1 — PAR-005. Caller may recover from duplicate keys by
    /// falling back to a last-wins merge instead of throwing.
    public init(profiles: [ModelConformanceProfile], now: Date = Date(),
                allowingDuplicates: Bool) {
        self.now = now
        // Last-wins on conflict; deterministic because we sort by
        // profile id so the higher id always wins.
        let sorted = profiles.sorted { $0.id < $1.id }
        self.profilesByProviderAndModel = Dictionary(
            sorted.map { profile in
                (Self.key(providerID: profile.providerID ?? profile.providerType.rawValue,
                          modelID: profile.modelID), profile)
            },
            uniquingKeysWith: { _, second in second })
    }

    public var isEmpty: Bool {
        profilesByProviderAndModel.isEmpty
    }

    public func evaluate(_ request: ModelRouter.ConformanceRequest) -> ModelRouter.ConformanceDecision {
        guard let profile = profilesByProviderAndModel[Self.key(providerID: request.providerID, modelID: request.modelID)] else {
            return .safeDefault
        }
        if let expiry = profile.expiresAt, expiry <= now {
            return ModelRouter.ConformanceDecision(allowed: false,
                                                   appliedProfileID: profile.id,
                                                   maxAutonomousSteps: 1,
                                                   nativeToolCallingAllowed: false,
                                                   trueStreamingAllowed: false,
                                                   parallelToolCallsAllowed: false,
                                                   issues: ["expired_conformance_profile"])
        }
        var issues: [String] = []
        let role = Self.conformanceRole(for: request.roleID)
        if let role {
            if profile.forbiddenRoles.contains(role) || !profile.allowedRoles.contains(role) {
                issues.append("role_denied:\(role.rawValue)")
            }
        } else {
            issues.append("unknown_role:\(request.roleID)")
        }
        if request.requiresNativeToolCalling && profile.toolCalling != .native {
            issues.append("native_tool_calling_disabled")
        }
        if request.requiresTrueStreaming && !profile.trueStreamingSupported {
            issues.append("true_streaming_disabled")
        }
        if request.requiresParallelToolCalls && !profile.supportsParallelToolCalls {
            issues.append("parallel_tool_calls_disabled")
        }
        if request.requestedAutonomousSteps > profile.maxAutonomousSteps {
            issues.append("autonomous_step_limit")
        }
        if (role == .synthesizer || role == .responder) && !profile.supportsReasoningSeparation {
            issues.append("reasoning_separation_unverified")
        }
        return ModelRouter.ConformanceDecision(allowed: issues.isEmpty,
                                               appliedProfileID: profile.id,
                                               maxAutonomousSteps: profile.maxAutonomousSteps,
                                               nativeToolCallingAllowed: profile.toolCalling == .native,
                                               trueStreamingAllowed: profile.trueStreamingSupported,
                                               parallelToolCallsAllowed: profile.supportsParallelToolCalls,
                                               issues: issues)
    }

    private static func key(providerID: String, modelID: String) -> String {
        "\(AgentEventRedactor.safeIdentifier(providerID)):\(AgentEventRedactor.safeIdentifier(modelID))"
    }

    private static func conformanceRole(for roleID: String) -> ModelConformanceRole? {
        switch roleID {
        case ModelRole.companion.rawValue:
            return .responder
        case ModelRole.tool.rawValue:
            return .toolCaller
        case ModelRole.summarizer.rawValue:
            return .synthesizer
        case ModelRole.vision.rawValue:
            return .responder
        default:
            return ModelConformanceRole(rawValue: roleID)
        }
    }
}

public enum AgentRecoveryBootstrapWarning: String, Codable, Sendable, Hashable {
    case checkpointMissing
    case checkpointCorrupted
    case checkpointBehindEvents
    case checkpointAheadOfEvents
    case duplicateSequence
    case missingSequence
    case sideEffectLedgerLoaded
    case conformanceProfileApplied
}

public struct AgentRecoveryBootstrapResult: Sendable {
    public var checkpoint: AgentCheckpoint
    public var recoveryPlan: AgentRecoveryPlan
    public var sideEffectLedger: AgentSideEffectLedger
    public var conformancePolicy: PersistedModelConformanceRoutingPolicy
    public var warnings: [AgentRecoveryBootstrapWarning]
    public var emittedEvents: [AgentEventEnvelope]

    public init(checkpoint: AgentCheckpoint,
                recoveryPlan: AgentRecoveryPlan,
                sideEffectLedger: AgentSideEffectLedger,
                conformancePolicy: PersistedModelConformanceRoutingPolicy,
                warnings: [AgentRecoveryBootstrapWarning],
                emittedEvents: [AgentEventEnvelope]) {
        self.checkpoint = checkpoint
        self.recoveryPlan = recoveryPlan
        self.sideEffectLedger = sideEffectLedger
        self.conformancePolicy = conformancePolicy
        self.warnings = warnings
        self.emittedEvents = emittedEvents
    }
}

public struct AgentRecoveryBootstrap: Sendable {
    public init() {}

    public func load(taskID: UUID,
                     runID: UUID,
                     eventStore: AgentRunEventPersisting,
                     checkpointStore: AgentCheckpointStore,
                     sideEffectLedgerStore: AgentSideEffectLedgerStore,
                     conformanceProfileStore: ModelConformanceProfileStore,
                     now: Date = Date()) async throws -> AgentRecoveryBootstrapResult {
        let events = try await eventStore.loadEvents(runID: runID)
        let eventMax = events.map(\.sequence).max() ?? 0
        var warnings: [AgentRecoveryBootstrapWarning] = []
        var checkpoint: AgentCheckpoint?
        do {
            checkpoint = try await checkpointStore.load(taskID: taskID, runID: runID)
        } catch AgentDurableRecoveryStoreError.corruptedCheckpoint {
            warnings.append(.checkpointCorrupted)
        }
        if checkpoint == nil {
            warnings.append(.checkpointMissing)
        }

        if let current = checkpoint {
            if current.lastSequence > eventMax {
                warnings.append(.checkpointAheadOfEvents)
                checkpoint = nil
            } else if current.lastSequence < eventMax {
                warnings.append(.checkpointBehindEvents)
                checkpoint = AgentCheckpointBuilder().checkpoint(taskID: taskID,
                                                                 runID: runID,
                                                                 events: events,
                                                                 createdAt: current.createdAt)
            }
        }
        if let sequenceWarning = Self.sequenceWarning(events) {
            warnings.append(sequenceWarning)
            checkpoint = AgentCheckpointBuilder().checkpoint(taskID: taskID, runID: runID, events: events)
        }
        let resolvedCheckpoint = checkpoint ?? AgentCheckpointBuilder().checkpoint(taskID: taskID,
                                                                                  runID: runID,
                                                                                  events: events)
        let ledger = try await sideEffectLedgerStore.loadLedger(taskID: taskID, runID: runID)
        if !ledger.records.isEmpty {
            warnings.append(.sideEffectLedgerLoaded)
        }
        let conformancePolicy = try await conformanceProfileStore.routingPolicy(now: now)
        warnings.append(.conformanceProfileApplied)
        let plan = AgentRecoveryPlanner().plan(from: resolvedCheckpoint)
        let emitted = Self.recoveryEvents(taskID: taskID,
                                          runID: runID,
                                          checkpoint: resolvedCheckpoint,
                                          warnings: warnings,
                                          now: now)
        return AgentRecoveryBootstrapResult(checkpoint: resolvedCheckpoint,
                                            recoveryPlan: plan,
                                            sideEffectLedger: ledger,
                                            conformancePolicy: conformancePolicy,
                                            warnings: warnings,
                                            emittedEvents: emitted)
    }

    private static func sequenceWarning(_ events: [AgentEventEnvelope]) -> AgentRecoveryBootstrapWarning? {
        let sequences = events.map(\.sequence).sorted()
        guard !sequences.isEmpty else { return nil }
        if Set(sequences).count != sequences.count { return .duplicateSequence }
        guard let first = sequences.first, let last = sequences.last else { return nil }
        if sequences != Array(first...last) { return .missingSequence }
        return nil
    }

    private static func recoveryEvents(taskID: UUID,
                                       runID: UUID,
                                       checkpoint: AgentCheckpoint,
                                       warnings: [AgentRecoveryBootstrapWarning],
                                       now: Date) -> [AgentEventEnvelope] {
        let base = checkpoint.lastSequence + 1
        var events: [AgentEventEnvelope] = [
            AgentEventEnvelope(taskID: taskID,
                               runID: runID,
                               sequence: base,
                               timestamp: now,
                               source: .replay,
                               visibility: .developer,
                               kind: .recoveryStarted,
                               payload: .diagnostic(.init(category: "checkpointLoaded",
                                                          safeSummary: "durable checkpoint recovery started"))),
        ]
        if !warnings.isEmpty {
            events.append(AgentEventEnvelope(taskID: taskID,
                                             runID: runID,
                                             sequence: base + 1,
                                             timestamp: now,
                                             source: .replay,
                                             visibility: .developer,
                                             kind: .warning,
                                             payload: .diagnostic(.init(category: "recoveryWarnings",
                                                                        safeSummary: warnings.map(\.rawValue).joined(separator: ",")))))
        }
        events.append(AgentEventEnvelope(taskID: taskID,
                                         runID: runID,
                                         sequence: base + UInt64(events.count),
                                         timestamp: now,
                                         source: .replay,
                                         visibility: .developer,
                                         kind: checkpoint.projection.state.isTerminal ? .recoverySucceeded : .taskResumed,
                                         payload: .diagnostic(.init(category: "recovery",
                                                                    safeSummary: checkpoint.projection.state.isTerminal ? "terminal replay restored" : "task resume evaluated"))))
        return events
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
