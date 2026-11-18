import Foundation
import Combine
import AICore

/// Owns the memory list for the Memory Center (doc §12.2) and feeds active memories into the AI
/// with cloud gating + usage accounting (doc §12.1/§11.3).
@MainActor
final class MemoryModel: ObservableObject {

    @Published private(set) var items: [MemoryItem] = []
    @Published private(set) var memoryEnabled: Bool = true
    @Published private(set) var recentLearningNotice: String?
    /// P18.6 — observable durable-persistence failure for memory writes.
    @Published private(set) var lastPersistenceError: String?
    /// P18.6 — non-nil when the memory file existed but was not a decodable array
    /// and was quarantined at load, so corrupt memory is surfaced as recovery
    /// state rather than silently presented as an empty memory set.
    @Published private(set) var loadCorruptionQuarantineURL: URL?
    private let store: MemoryStore

    init(store: MemoryStore = MemoryStore()) {
        self.store = store
        items = MemoryRetention.apply(store.load(), now: Date())
        loadCorruptionQuarantineURL = store.lastLoadCorruptionURL
        persist()
    }

    var pendingCount: Int { pendingConfirmationItems.count }
    var rememberedItems: [MemoryItem] {
        items.filter {
            $0.state == .active
                && !$0.archived
                && [.semantic, .procedural, .episodic].contains($0.scope)
        }
    }
    var recentlyAutoLearnedItems: [MemoryItem] {
        items.filter { $0.state == .active && $0.source == .auto && !$0.archived }
            .sorted { $0.updatedAt > $1.updatedAt }
    }
    var pendingConfirmationItems: [MemoryItem] {
        items.filter { $0.state == .pendingConfirmation && !$0.archived }
    }
    var shortTermContextItems: [MemoryItem] {
        items.filter { [.working, .session].contains($0.scope) && !$0.archived }
    }
    var diagnostics: [String] { store.lastDiagnostics }

    // MARK: Mutations

    /// Add a memory, gated by policy (doc §12.1). Returns false if disallowed (e.g. sensitive auto).
    @discardableResult
    func add(_ item: MemoryItem) -> Bool {
        guard item.sensitivity != .prohibitedSecret,
              !MemoryPolicy.isForbiddenContent(item.text) else {
            return false
        }
        var next = item
        next.updatedAt = Date()
        if next.state == .active {
            supersedeConflicts(with: &next)
        }
        items.insert(next, at: 0); persist(); return true
    }

    func update(_ item: MemoryItem) {
        guard let i = items.firstIndex(where: { $0.id == item.id }) else { return }
        var next = item
        next.updatedAt = Date()
        items[i] = next; persist()
    }
    func delete(_ item: MemoryItem) {
        items.removeAll { $0.id == item.id }
        persist()
    }
    func confirm(_ item: MemoryItem) {
        guard let i = items.firstIndex(where: { $0.id == item.id }) else { return }
        items[i].confirmed = true
        items[i].state = .active
        items[i].updatedAt = Date()
        var confirmed = items[i]
        supersedeConflicts(with: &confirmed)
        items[i] = confirmed
        persist()
    }
    func setPaused(_ item: MemoryItem, _ paused: Bool) {
        guard let i = items.firstIndex(where: { $0.id == item.id }) else { return }
        items[i].paused = paused
        items[i].updatedAt = Date()
        persist()
    }

    func setMemoryEnabled(_ enabled: Bool) {
        memoryEnabled = enabled
    }

    func forget(_ item: MemoryItem) {
        guard let i = items.firstIndex(where: { $0.id == item.id }) else { return }
        items[i].state = .superseded
        items[i].confirmed = false
        items[i].archived = true
        items[i].updatedAt = Date()
        persist()
    }

    func undoAutoLearned(_ item: MemoryItem) {
        guard item.source == .auto else { return }
        forget(item)
    }

    /// De-duped suggestion intake (won't re-suggest an identical active memory).
    func suggest(_ item: MemoryItem?) {
        guard let item, !items.contains(where: { $0.text == item.text && !$0.archived }) else { return }
        add(item)
    }

    @discardableResult
    func ingest(_ candidate: MemoryCandidate,
                now: Date = Date()) -> MemoryPolicyDecision {
        let decision = MemoryPolicyEngine.decide(candidate: candidate,
                                                 existing: items,
                                                 memoryEnabled: memoryEnabled,
                                                 now: now)
        switch decision {
        case .ignore, .reject:
            return decision
        case .keepEphemeral(let scope, let expiresAt, let reason):
            var item = makeItem(from: candidate, state: .active, source: .auto,
                                reason: reason, confirmed: true, expiresAt: expiresAt)
            item.scope = scope
            item.category = MemoryLegacyMapper.category(for: scope)
            _ = add(item)
        case .observe(let reason):
            _ = add(makeItem(from: candidate, state: .observed, source: .suggested,
                             reason: reason, confirmed: false))
        case .autoCommit(let reason):
            let source: MemorySource = candidate.sourceKind == .repeatedUserBehavior ? .auto : .explicit
            _ = add(makeItem(from: candidate, state: .active, source: source,
                             reason: reason, confirmed: true))
            recentLearningNotice = "已记住：\(candidate.summary)"
        case .requireConfirmation(let reason):
            _ = add(makeItem(from: candidate, state: .pendingConfirmation, source: .suggested,
                             reason: reason, confirmed: false))
        }
        return decision
    }

    func ingest(_ candidates: [MemoryCandidate], now: Date = Date()) {
        for candidate in candidates {
            _ = ingest(candidate, now: now)
        }
    }

    // MARK: Feeding the AI (doc §12.1)

    /// Ranked local search for the Memory Center (same tokenizer as context
    /// ranking; archived items excluded, sensitive items included — this is the
    /// user's own data on their own device).
    func search(_ query: String, limit: Int = 20) -> [MemoryItem] {
        MemoryTextSearch.search(query, in: items, limit: limit)
    }

    /// Active memory texts for an AI request. `forCloud` excludes blockCloud/localOnly memories
    /// and records that the rest may have entered cloud context (doc §11.3/§12.2).
    func activeHints(forCloud: Bool,
                     taskText: String = "",
                     conversationID: UUID? = nil,
                     taskID: UUID? = nil) -> [String] {
        let now = Date()
        var used: [UUID] = []
        let selected = MemoryContextBuilder.build(items: items,
                                                  taskText: taskText,
                                                  conversationID: conversationID,
                                                  taskID: taskID,
                                                  now: now)
        let hints: [String] = selected.compactMap { m in
            guard !(forCloud && (m.blockCloud || m.localOnly)) else { return nil }
            used.append(m.id)
            return m.text
        }
        markUsed(ids: used, enteredCloud: forCloud)
        return hints
    }

    private func markUsed(ids: [UUID], enteredCloud: Bool) {
        guard !ids.isEmpty else { return }
        let now = Date()
        for i in items.indices where ids.contains(items[i].id) {
            items[i].lastUsed = now
            items[i].lastUsedAt = now
            items[i].useCount += 1
            if enteredCloud { items[i].everEnteredCloud = true }
        }
        persist()
    }

    private func persist() {
        do {
            try store.save(items)
            lastPersistenceError = nil
        } catch {
            lastPersistenceError = SealedStore.describe(error, fallback: "记忆保存失败")
        }
    }

    private func makeItem(from candidate: MemoryCandidate,
                          state: MemoryState,
                          source: MemorySource,
                          reason: String,
                          confirmed: Bool,
                          expiresAt: Date? = nil) -> MemoryItem {
        MemoryItem(text: candidate.summary,
                   category: MemoryLegacyMapper.category(for: candidate.proposedScope),
                   source: source,
                   reason: reason,
                   confirmed: confirmed,
                   privacy: MemoryLegacyMapper.privacy(for: candidate.sensitivityHint),
                   expiresAt: expiresAt,
                   canonicalKey: candidate.canonicalKey,
                   scope: candidate.proposedScope,
                   state: state,
                   sensitivity: candidate.sensitivityHint,
                   normalizedValue: candidate.normalizedValue,
                   confidence: candidate.confidence,
                   evidenceCount: 1,
                   sourceReferences: candidate.sourceReference.map { [$0] } ?? [])
    }

    private func supersedeConflicts(with item: inout MemoryItem) {
        guard item.state == .active else { return }
        for index in items.indices where items[index].id != item.id
            && items[index].canonicalKey == item.canonicalKey
            && items[index].state == .active
            && items[index].normalizedValue != item.normalizedValue {
            items[index].state = .superseded
            items[index].confirmed = false
            items[index].supersededByID = item.id
            items[index].updatedAt = Date()
            item.supersedesID = items[index].id
        }
    }
}
