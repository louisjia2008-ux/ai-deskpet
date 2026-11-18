# Memory V2 Architecture

## Source Of Truth

Memory V2 reuses the existing memory stack instead of adding a second store:

- Model types and policy: `Sources/AICore/Memory.swift`
- App projection and mutation API: `Sources/DeskPet/Memory/MemoryModel.swift`
- Persistence: `Sources/DeskPet/Memory/MemoryStore.swift`
- Runtime bridge: `Sources/DeskPet/PetBrain/RuntimeAdapters.swift`
- UI: `Sources/DeskPet/UI/MemoryView.swift`

`MemoryModel` is the app-level mutation surface. The agent runtime can only submit `MemoryCandidate` values through `ReflectionSink`; it cannot write confirmed memories directly.

## Data Flow

User-authored content or verified task outcome becomes a `MemoryCandidate`. The candidate is sanitized by the value initializers in `AICore`, evaluated by `MemoryPolicyEngine`, then ingested by `MemoryModel`. Only the deterministic policy decides whether the repository mutates.

The flow is one-way:

`MemoryCandidate -> MemoryPolicyEngine -> MemoryModel.ingest -> MemoryStore.save -> MemoryView projection`

Retrieval uses `MemoryContextBuilder`, not a raw dump of all records. It ranks active, non-expired, non-superseded memories by scope, relevance, recency, confidence, and pinning.

## Ownership

`MemoryItem` is the persisted record. It carries `schemaVersion`, `canonicalKey`, `scope`, `state`, `sensitivity`, `normalizedValue`, confidence, evidence count, source references, timestamps, expiration, supersession links, pinning, and editability.

`MemoryModel` owns UI-safe mutation: add, confirm, ingest, forget, undo, and retrieval. `MemoryStore` owns JSON/Codable persistence and corrupt-record isolation.

## Lifecycle

Working memory is task scoped and expires quickly. Session memory is conversation scoped and expires automatically. Episodic memory records important task outcomes with time/source. Semantic memory stores stable facts and preferences. Procedural memory stores how the user wants work done.

States are `observed`, `active`, `pendingConfirmation`, `rejected`, `superseded`, `expired`, and `ignored`.

## Failure Handling

Memory extraction failure does not fail chat. Candidate rejection or ignore is a no-op for the main runtime path. `MemoryStore.load()` isolates bad JSON records and exposes diagnostics instead of failing the whole store.

## Migration

Legacy records are migrated by `MemoryLegacyMigrator`. Accepted records become active semantic/procedural records where possible. Legacy pending records are reclassified by policy: date/time junk and plain task prompts become ignored, explicit stable low-risk preferences can become active, and ambiguous items stay pending.

Migration is idempotent and does not require Core Data, SwiftData, SQLite, or a third-party database.

## Security Boundary

Forbidden content such as API keys, access tokens, passwords, OTPs, private keys, authorization headers, and full payment credentials is rejected even when the user says to remember it. Hidden reasoning, raw tool arguments, raw provider JSON, and system prompts are never valid memory content.

Assistant-authored text is not a user fact. Tool logs are not long-term memory.

## Test Coverage

`Tests/DeskPetTests/P6MemoryV2Tests.swift` covers explicit preferences, transient preferences, repeated evidence thresholds, date/time ignores, assistant/tool argument ignores, secret rejection, sensitive confirmation, conflict/supersession, forget, undo, disabled long-term memory, migration idempotence, corrupt legacy records, retrieval ordering, isolation, and budget.

Legacy coverage in `M5MemoryTests` still passes under the V2 model.

## Deferred Work

Embedding retrieval is deferred. A future retrieval seam can be added after the deterministic keyword/scope/ranking path proves stable. Long-term audit event export for every forget/supersede action is also deferred beyond the current JSON memory store.
