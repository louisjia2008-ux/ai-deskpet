# P18.6 — Persistence Surface Inventory

Scope: `DeskPet/Sources/` production runtime. Classifies every durable-write /
durable-load site by authority (CRITICAL / RECOVERABLE / TELEMETRY) and status
(SAFE / DEFECT / PARTIAL / NEEDS_PROOF / BEST_EFFORT_BY_DESIGN). Baseline HEAD
`af6979ec5bc4cac278ea5d51de901e1a4def5ea8`, tests 1474/0/10.

The invariant under audit:

```
durability-relevant state change → durable write required?
  YES → write succeeds → publish success
     OR write fails → observable failure → no false success → defined memory/disk → deterministic restart
```

---

## A. CRITICAL_DURABLE_STATE — authoritative local-first JSON stores (app)

All six were wired in `AppDelegate` as the authoritative durable copy of user
state. All six shared the identical **silent** shape before P18.6:
`save`: `guard let d = try? encode …; try? d.write(…)` (Void, unobservable) and
`load`: `try? decode(…) ?? []` (a corrupt file was silently treated as empty and
then permanently clobbered by the next save).

| ID | File | State | Category | Before | After (P18.6) | Status |
|----|------|-------|----------|--------|---------------|--------|
| C-01 | `Chat/ChatModels.swift` `ChatStore` | conversation history | CRITICAL | silent `try?` write; corrupt→empty | `save() throws`; load quarantines corrupt; `ChatModel.lastPersistenceError` / `loadCorruptionQuarantineURL` | REPAIRED |
| C-02 | `Tasks/TaskStore.swift` | user tasks | CRITICAL | silent; corrupt→empty | `save() throws`; quarantine; `AppModel.lastPersistenceError` / `loadCorruptionQuarantineURL` | REPAIRED |
| C-03 | `Tasks/ScheduledTaskStore.swift` | scheduled tasks | CRITICAL | silent; corrupt→empty | `save() throws`; quarantine; `TaskScheduler.lastPersistenceError` / `loadCorruptionQuarantineURL` | REPAIRED |
| C-04 | `Memory/MemoryStore.swift` | long-term memory | CRITICAL | silent write; corrupt(non-array)→empty | `save() throws`; quarantine non-array; `MemoryModel.lastPersistenceError` / `loadCorruptionQuarantineURL` | REPAIRED |
| C-05 | `AI/ProviderStore.swift` | provider/model config (+ secret refs) | CRITICAL | silent write; `upsert` returned `.success` even when write failed; corrupt→silent default reset | `writeSnapshot() throws`; `upsert` returns `.failure` on write failure; `persist()` surfaces `lastPersistenceError`; init quarantines corrupt | REPAIRED |
| C-06 | `Relationship/RelationshipModel.swift` `RelationshipStore` | relationship/vitals snapshot | CRITICAL (gamification) | silent; corrupt→reset | `save() throws`; quarantine; `RelationshipModel.lastPersistenceError` | REPAIRED |

`Sync/PreferencesModel.swift` — CRITICAL (settings). Already repaired in **P18.1**
(`setToolEnabled` persist-before-publish; `persist()` do/catch surfacing
`lastPersistenceError`). The other setters use the `didSet → persist()` optimistic
path whose failure is disclosed via `lastPersistenceError` (not silent). **SAFE /
pre-existing P18.1 contract — not re-touched.**

New shared helper: `Storage/DurableJSONFile.swift` — stateless `read`
(absent/empty/present) + `quarantineCorrupt` (moves corrupt bytes aside). Not a
"persistence manager"; one tested place for the one behaviour six stores share.

## B. Backup / Export

| ID | File | Status | Notes |
|----|------|--------|-------|
| B-01 | `Sync/BackupService.swift` `export` | **SAFE** | Artifact write is throwing (`try …encode(package).write(to: out, .atomic)`); seal/encode throw. Success genuinely means a usable artifact exists. Missing source category files are `try?`-skipped by design (absent category ≠ error). RNG fail-closed (P18.1) preserved. |
| B-02 | `Sync/BackupService.swift` `restore` | **SAFE** (main) | Restore writes throw (line 81). `snapshotForRollback` uses `try?` copy — best-effort rollback convenience; its failure does not falsify restore success. Recorded T2. |

## C. Agent task / scheduler / recovery (PetAgentRuntime — P14/P18.5 kernel)

| ID | File | Status | Notes |
|----|------|--------|-------|
| K-01 | `PetAgentRuntime/DurableTaskStore.swift` `persist` | **BEST_EFFORT_BY_DESIGN** | Uses proper atomic temp+replace (P5 atomicity SAFE). Write error is caught (not `try?`) and, by documented design, reconciled on next load via `RecoveryClassifier` + side-effect ledger (idempotency). Not a user-facing false success. Re-auditing the P14 durable-task kernel is explicitly out of P18.6 scope; flagged in followup for an *explicit* persistence-failure signal beyond logging. |
| K-02 | `DurableInboxStore` / `DurableAuditLogStore` / `DurableSchedulerSnapshotStore` / `Goal` / `DurableRecoveryStores` / `AgentRunEventStore` | NEEDS_PROOF (deferred) | P14 durable kernel append/snapshot stores. `try?` on `createDirectory` (T1) + some append writes. Backed by kernel recovery/reconciliation. Out of P18.6 scope boundary (P14). Documented in followup. |

## D. RECOVERABLE / DERIVED

| ID | File | Status | Notes |
|----|------|--------|-------|
| R-01 | `AI/AgentTaskActivityStore.swift` | BEST_EFFORT (T2) | `Task { try? await persistence.append/replaceAll/clear }` — activity/observability projection, regeneratable from run-event ledger. Non-authoritative; best-effort acceptable. |
| R-02 | `Storage/JSONToSQLiteMigration.swift` | SAFE | Migration uses throwing `SQLiteStorage`; `try?` only on temp-DB cleanup. Not yet the authoritative path (JSON stores remain authoritative). |

## E. NON-ESSENTIAL / TELEMETRY / HARNESS

| ID | File(s) | Status | Notes |
|----|---------|--------|-------|
| T-01 | `App/P16/P17ProductSurfaceHarness.swift`, `Onboarding/P17OnboardingScreenshotHarness.swift`, `App/P7AppRecoveryHarness.swift`, `App/P9*Harness.swift` | BEST_EFFORT | Acceptance/screenshot harnesses (`try?` png/dir/artifact writes). Not production runtime; failures only affect diagnostic artifacts. Justified. |
| T-02 | `Security/ToolRunnerService.swift`, `AI/LLMService.swift`, `DeskPetLLM/main.swift`, `DeskPetToolRunner/main.swift` | BEST_EFFORT | IPC request/response `try?` encode/decode — ephemeral per-call runtime, not durable state. A failed encode fails that one call; no durable state affected. |
| T-03 | `Onboarding/OnboardingViewModel.swift` / `OnboardingView.swift` | RECOVERABLE (T2) | `try? persistence.recordShown/save` — onboarding "already shown" flag. Failure = onboarding may re-show; no data loss. Best-effort acceptable; noted in followup. |

---

## Category summary

| Category | Sites (representative) | SAFE | DEFECT→REPAIRED | PARTIAL/BEST_EFFORT | NEEDS_PROOF(deferred) |
|----------|------|------|-----------------|---------------------|-----------------------|
| Conversation | ChatStore | – | 1 (C-01) | – | – |
| Tasks | TaskStore, ScheduledTaskStore | – | 2 (C-02,03) | – | – |
| Memory | MemoryStore | – | 1 (C-04) | – | – |
| Provider config | ProviderStore | – | 1 (C-05) | – | – |
| Relationship | RelationshipStore | – | 1 (C-06) | – | – |
| Preferences | PreferencesModel | 1 (P18.1) | – | – | – |
| Backup/export | BackupService | 2 (B-01,02) | – | rollback-snapshot T2 | – |
| Agent task/scheduler | DurableTaskStore + kernel | – | – | 1 (K-01) | K-02 group |
| Cache/derived | ActivityStore, migration | 1 (R-02) | – | 1 (R-01) | – |
| Telemetry/harness/IPC | harnesses, IPC, onboarding | – | – | T-01..T-03 | – |

**Confirmed active silent critical write-failure defects after P18.6: 0.**
**Confirmed false durable-success paths after P18.6: 0.**
