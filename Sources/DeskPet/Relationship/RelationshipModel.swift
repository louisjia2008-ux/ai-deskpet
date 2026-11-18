import Foundation
import Combine
import AICore

/// Persisted relationship snapshot.
struct RelationshipSnapshot: Codable, Equatable {
    var state = RelationshipState()
    var vitals = PetVitals()
    var equipped: Set<Accessory> = [.hairclip]
    var nestEnabled = true
}

@MainActor
final class RelationshipStore {
    private let url: URL
    init(fileURL: URL? = nil) {
        if let fileURL { self.url = fileURL }
        else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("DeskPet", isDirectory: true)
            try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            self.url = base.appendingPathComponent("relationship.json")
        }
    }
    /// P18.6 — set when `load()` finds an existing-but-undecodable file and
    /// quarantines it, so corrupt relationship state is never silently reset.
    private(set) var lastLoadCorruptionURL: URL?

    func load() -> RelationshipSnapshot {
        lastLoadCorruptionURL = nil
        let secure: SealedStore.LoadState
        do {
            secure = try SealedStore.load(at: url)
        } catch {
            // Sealed but unreadable (no key): NOT corruption — leave bytes.
            return RelationshipSnapshot()
        }
        guard case .data(let data, _) = secure else {
            return RelationshipSnapshot()
        }
        do {
            let snap = try JSONDecoder().decode(RelationshipSnapshot.self, from: data)
            SealedStore.migratePlaintext(at: url) { try save(snap) }
            return snap
        } catch {
            lastLoadCorruptionURL = DurableJSONFile.quarantineCorrupt(at: url)
            return RelationshipSnapshot()
        }
    }
    /// P18.6 — throws on encode/write failure so the caller can surface an
    /// observable persistence error instead of silently losing the write.
    /// Sealed when a key is wired (D3); fail-closed on sealed-without-key.
    func save(_ s: RelationshipSnapshot) throws {
        let data = try JSONEncoder().encode(s)
        try SealedStore.save(data, to: url)
    }
}

/// Drives relationship growth (doc §10) — strictly no-penalty. Surfaces only stage + fuzzy
/// progress (doc §10.4); exact score stays hidden. Stage-ups raise `onStageUp` for a celebration.
@MainActor
final class RelationshipModel: ObservableObject {

    @Published private(set) var snapshot: RelationshipSnapshot
    /// P18.6 — observable durable-persistence failure for relationship writes.
    @Published private(set) var lastPersistenceError: String?
    private let store: RelationshipStore

    /// Fired when a new stage is reached, with the new stage (for celebration).
    var onStageUp: (RelationshipStage) -> Void = { _ in }
    /// Fired when the equipped set changes (push to the renderer).
    var onEquipChange: (Set<Accessory>) -> Void = { _ in }
    /// Fired when the nest toggle changes (push to the desktop).
    var onNestChange: (Bool) -> Void = { _ in }

    init(store: RelationshipStore = RelationshipStore()) {
        self.store = store
        self.snapshot = store.load()
    }

    var stage: RelationshipStage { snapshot.state.stage }
    var unlocked: [Accessory] { RewardCatalog.accessories(upTo: stage) }
    var equipped: Set<Accessory> { snapshot.equipped }

    func record(_ kind: InteractionKind) {
        let leveledUp = snapshot.state.record(kind)
        snapshot.vitals.onInteraction()
        persist()
        if leveledUp { onStageUp(snapshot.state.stage) }
    }

    func toggleEquip(_ a: Accessory) {
        guard unlocked.contains(a) else { return }
        if snapshot.equipped.contains(a) { snapshot.equipped.remove(a) } else { snapshot.equipped.insert(a) }
        persist()
        onEquipChange(snapshot.equipped)
    }

    func setNestEnabled(_ on: Bool) { snapshot.nestEnabled = on; persist(); onNestChange(on) }

    private func persist() {
        do {
            try store.save(snapshot)
            lastPersistenceError = nil
        } catch {
            lastPersistenceError = SealedStore.describe(error, fallback: "关系数据保存失败")
        }
    }
}
