# Agent OS Acceptance Report

## Status

Current status after the 2026-07-27 P7 durable recovery repair and the 2026-07-28 App process recovery harness:

```text
AGENT_OS_FOUNDATION_COMPLETE
```

The P7 persistence/conformance blocker called out by independent audit is repaired in code and covered by cross-instance durable tests, two-process SwiftPM recovery proof, a DEBUG-only real App process seed/reload recovery harness, real provider cancellation proof, and full SwiftPM regression. The App process harness is the accepted recovery/integration substitute for the current macOS XCUITest runner issue; it does not claim that the XCUITest automation service itself is healthy.

## Baseline Context

- Date: 2026-07-24.
- Workspace: `/path/to/DeskPet`.
- Git top-level: `/path/to/workspace`.
- HEAD recorded during P0 audit: `af6979ec5bc4cac278ea5d51de901e1a4def5ea8`.
- Worktree: dirty before P0 docs; many modified and untracked files already existed. No destructive git commands were run.

## P0 Audit Coverage

Audited:

- runtime entry and coordinator
- bounded loop
- event hub and run event store
- task activity store and reducer
- provider routing and provider clients
- tool registry and tool manifests
- capability broker, permission gate, approval grants
- security kernel and isolated tool runner
- memory policy and storage
- chat, floating chat, task card, Task Center, result renderer
- scheduler and app scheduled-task layer
- existing architecture and acceptance docs

## Reusable Architecture

The existing single-runtime architecture is reusable. The correct evolution path is:

```text
PetAgentRuntimeCoordinator
 -> canonical Agent events
 -> unified reducer
 -> ToolRegistry / PermissionGate / Trust Kernel
 -> AgentEventHub / AgentRunEventStore
 -> Chat / Floating Chat / Task Center / AgentResultView
```

## P0 Conflict Summary

These were the P0 audit conflicts before the phased implementation:

- State was split across task, activity, loop, and scheduler models.
- Event data was split across runtime outputs, activity events, agent event envelopes, and runtime event bus.
- Provider true streaming was not implemented for the current OpenAI-compatible/Ollama paths.
- Tool call streaming accumulator existed but was not wired to live provider streaming.
- Floating Chat still had a local preview timeline store that had to remain transitional.
- Generative UI validated actions but did not yet dispatch them through Trust Kernel.
- Tool Factory was not implemented.

Later P1-P8 sections below record which of these were resolved or explicitly deferred.

## Gate Commands

`xcodegen generate`

Result:

```text
Created project at /path/to/DeskPet/DeskPet.xcodeproj
```

`xcodebuild -list -project DeskPet.xcodeproj`

Result: command exited 0 and listed targets and schemes. The sandbox emitted CoreSimulator and DerivedData log permission warnings, but the project information was readable.

Targets:

```text
AICore
DeskPet
DeskPetLLM
DeskPetToolRunner
DeskPetUITests
PetAgentRuntime
PetBrainCore
```

Schemes:

```text
AICore
DeskPet
DeskPet-Package
DeskPetLLM
DeskPetToolRunner
PetAgentRuntime
PetBrainCore
```

`swift test --disable-sandbox --disable-dependency-cache --scratch-path /private/tmp/deskpet-agentos-p0-swiftpm`

Result:

```text
Executed 686 tests, with 0 failures (0 unexpected)
```

`git diff --check`

Result: PASS after P0 documents were written.

## P0 Gate

P0 Gate: PASS.

## P1 Implementation Evidence

Implemented:

- `AgentStreamEvent`, `AgentStreamEventKind`, and `AgentRunState` as the additive canonical event/state protocol.
- `AgentTaskProjectionReducer` as the canonical task/run projection.
- adapters from `AgentEventEnvelope` and legacy `AgentTaskActivityEvent` into canonical stream events.
- `AgentTaskActivityStore.canonicalTasks` and `canonicalTask(id:)` so Chat, Floating Chat, and Task Center can share the same event-derived projection while legacy UI remains compatible.
- isolated ChatModel unit-test activity stores so provider/runtime tests do not load the user's persisted app activity history.

Focused tests:

```text
swift test --disable-sandbox --disable-dependency-cache --scratch-path /private/tmp/deskpet-agentos-p1-single-swiftpm --filter CompanionChatViewModelTests
Executed 14 tests, with 0 failures (0 unexpected)

swift test --disable-sandbox --disable-dependency-cache --scratch-path /private/tmp/deskpet-agentos-p1-single-swiftpm --filter P31ProviderAdapterAcceptanceTests
Executed 61 tests, with 0 failures (0 unexpected)

swift test --disable-sandbox --disable-dependency-cache --scratch-path /private/tmp/deskpet-agentos-p1-band-swiftpm --filter 'P1AgentEventStateMachineTests|P4CTaskActivityTests|P5IntegrationClosureTests|P6ActivityProjectionTests|CompanionChatViewModelTests|P31ProviderAdapterAcceptanceTests'
Executed 110 tests, with 0 failures (0 unexpected)
```

Regression found and fixed:

- After adding canonical projection, several ChatModel provider tests timed out when the suite loaded the user's real Application Support activity JSONL through default `AgentTaskActivityStore` instances. The tests now inject `AgentTaskActivityStore(persistence: nil)`, preserving real runtime/event flow while removing unrelated persisted user history from unit-test timing.

Full gate commands:

```text
xcodegen generate
Created project at /path/to/DeskPet/DeskPet.xcodeproj

xcodebuild -list -project DeskPet.xcodeproj
Result: exited 0 and listed targets/schemes. Sandbox/CoreSimulator/DerivedData warnings persisted but did not block project discovery.

swift test --disable-sandbox --disable-dependency-cache --scratch-path /private/tmp/deskpet-agentos-p1-full2-swiftpm
Executed 689 tests, with 0 failures (0 unexpected)

git diff --check
Result: PASS
```

## P1 Gate

P1 Gate: PASS.

## P2 Implementation Evidence

Implemented:

- `ProviderDelta` now carries visible text, hidden reasoning, tool-call deltas, metadata, usage, finish reason, error, and cancellation acknowledgement.
- `ProviderHTTPClient.streamLines(for:)` and `URLSessionProviderHTTPClient.streamLines(for:)` provide line-based transport streaming.
- OpenAI-compatible providers now parse SSE `data:` chunks through `LLMClient.streamChat`.
- Ollama now parses real `/api/chat` NDJSON chunks through `LLMClient.streamChat`.
- MiniMax M3 request shaping now uses `thinking.type=disabled` plus `reasoning_split=true`.
- `StreamingModelResponseSanitizer` blocks split `<think>` / `<thinking>` leaks and separates provider reasoning fields from visible assistant text.
- `ProviderToolCallStreamAccumulator` is wired into `LLMProviderAgentLoopDecisionProvider` so streamed native tool calls can continue through the existing tool loop.
- `ChatResponseDeltaCoalescer` buffers ChatModel UI deltas with monotonic sequence protection, cancellation barriers, and terminal flush behavior.
- Opt-in live provider probes were added for local Ollama and cloud MiniMax. They are skipped unless `DESKPET_LIVE_PROVIDER_PROBE=1`.

Focused and live tests:

```text
swift test --disable-sandbox --disable-dependency-cache --scratch-path /private/tmp/deskpet-agentos-p2-p31b-swiftpm --filter P31ProviderAdapterAcceptanceTests
Executed 69 tests, with 2 tests skipped and 0 failures (0 unexpected)

DESKPET_LIVE_PROVIDER_PROBE=1 swift test --disable-sandbox --disable-dependency-cache --scratch-path /private/tmp/deskpet-agentos-p2-live-ollama-swiftpm2 --filter P31ProviderAdapterAcceptanceTests/testLiveOllamaStreamChatUsesRealAdapterTransportWhenEnabled
Executed 1 test, with 0 failures (0 unexpected)

DESKPET_LIVE_PROVIDER_PROBE=1 swift test --disable-sandbox --disable-dependency-cache --scratch-path /private/tmp/deskpet-agentos-p2-live-minimax-swiftpm2 --filter P31ProviderAdapterAcceptanceTests/testLiveMiniMaxStreamChatUsesRealAdapterTransportWhenEnabled
Executed 1 test, with 0 failures (0 unexpected)

swift test --disable-sandbox --disable-dependency-cache --scratch-path /private/tmp/deskpet-agentos-p2-band2-swiftpm --filter 'P31ProviderAdapterAcceptanceTests|CompanionChatViewModelTests|PetAgentRuntimeTests|P4AToolPlatformTests'
Executed 122 tests, with 2 tests skipped and 0 failures (0 unexpected)
```

Sandbox note:

- The same live provider probes failed inside the restricted test sandbox at the transport permission layer.
- The successful live evidence above was collected by rerunning the identical filtered tests outside the sandbox.
- No API key values were printed or written to disk; the MiniMax key was read from environment and stored only in `InMemorySecretStore`.

Full gate commands:

```text
xcodegen generate
Created project at /path/to/DeskPet/DeskPet.xcodeproj

xcodebuild -list -project DeskPet.xcodeproj
Result: exited 0 and listed targets/schemes. Sandbox/CoreSimulator/DerivedData warnings persisted but did not block project discovery.

swift test --disable-sandbox --disable-dependency-cache --scratch-path /private/tmp/deskpet-agentos-p2-full-swiftpm
Executed 697 tests, with 2 tests skipped and 0 failures (0 unexpected)

git diff --check
Result: PASS
```

## P2 Gate

P2 Gate: PASS.

## P3 Implementation Evidence

Implemented:

- `verificationStarted`, `verificationSucceeded`, and `verificationFailed` activity events for deterministic tool-result validation.
- `verificationStarted`, `verificationSucceeded`, and `verificationFailed` canonical envelope kinds, mapped to `verifierStarted`, `verifierCompleted`, and `verifierFailed` stream events.
- runtime validation for the required `get_current_datetime` vertical path: the coordinator verifies a successful tool observation contains `status=success`, a time field, and a timezone before final user reply synthesis is accepted as successful.
- invalid successful datetime observations are downgraded to `toolFailure` / failed terminal state before ledger terminal recording.
- `verificationFailed` remains failure evidence for the verifier step; the run is finalized by the subsequent `taskFailed` terminal event so replay has one terminal anchor.
- Chat activity tool records keep verification on the same `tool-get_current_datetime` step so the UI still reports one tool step, not a fake second tool.
- legacy activity reducer, canonical stream reducer, and envelope replay sorting now compare sequence numbers only within the same source; cross-source scheduler/runtime events are ordered by timestamp so scheduler terminal events cannot overtake runtime verification.

Focused P3 tests:

```text
swift test --disable-sandbox --disable-dependency-cache --disable-build-manifest-caching --manifest-cache local --cache-path /private/tmp/deskpet-agentos-p3-cache --config-path /private/tmp/deskpet-agentos-p3-cache/config --security-path /private/tmp/deskpet-agentos-p3-cache/security --scratch-path /private/tmp/deskpet-agentos-p3-cache/p3-focused --filter 'P31ProviderAdapterAcceptanceTests/testRuntimeActivityRecordsDatetimeToolStartVerifySynthesizeAndCompleteInOrder|P31ProviderAdapterAcceptanceTests/testRuntimeActivityRecordsDatetimeToolFailureAsTaskFailed|P31ProviderAdapterAcceptanceTests/testDatetimeToolActivityStoreReplayAndSharedChatSurfaceStayConsistent'
Executed 3 tests, with 0 failures (0 unexpected)
```

Verified behavior:

- real datetime request enters the tool loop and emits tool started/completed before final reply text.
- verifier events occur after the tool observation and before final answer synthesis/response delta.
- tool failure emits real `stepFailed`, `verificationFailed`, and `taskFailed` states; no success terminal is emitted.
- `AgentTaskActivityStore` legacy replay and canonical projection preserve the same verifier-completed run after scheduler/runtime event interleaving.
- `ChatModel` and `CompanionChatViewModel` see the same active task and terminal activity record for the datetime path.

Regression found and fixed:

- Full regression initially found 6 failures in `P5IntegrationClosureTests`: legacy tests did not expect the new visible verifier step, and `P5FakeExecutor` returned non-JSON text for `get_current_datetime`. The fake executor now returns the minimum valid datetime JSON, visible activity expectations include `已验证工具结果`, and verifier failure remains non-terminal until `taskFailed` anchors replay.

P3 regression band:

```text
swift test --disable-sandbox --disable-dependency-cache --disable-build-manifest-caching --manifest-cache local --cache-path /private/tmp/deskpet-agentos-p3-cache --config-path /private/tmp/deskpet-agentos-p3-cache/config --security-path /private/tmp/deskpet-agentos-p3-cache/security --scratch-path /private/tmp/deskpet-agentos-p3-cache/p3-band --filter 'P31ProviderAdapterAcceptanceTests|P4CTaskActivityTests|P1AgentEventStateMachineTests|P6ActivityProjectionTests|CompanionChatViewModelTests|PetAgentRuntimeTests|P3BoundedAgentLoopTests|P5IntegrationClosureTests'
Executed 119 tests, with 2 tests skipped and 0 failures (0 unexpected)
```

## P3 Gate

Full gate commands:

```text
xcodegen generate
Created project at /path/to/DeskPet/DeskPet.xcodeproj

xcodebuild -list -project DeskPet.xcodeproj
Result: exited 0 and listed targets/schemes. Sandbox/CoreSimulator/DerivedData warnings persisted but did not block project discovery.

swift test --disable-sandbox --disable-dependency-cache --disable-build-manifest-caching --manifest-cache local --cache-path /private/tmp/deskpet-agentos-p3-cache --config-path /private/tmp/deskpet-agentos-p3-cache/config --security-path /private/tmp/deskpet-agentos-p3-cache/security --scratch-path /private/tmp/deskpet-agentos-p3-cache/p3-full
Executed 698 tests, with 2 tests skipped and 0 failures (0 unexpected)

git diff --check
Result: PASS
```

P3 Gate: PASS.

## P4 Implementation Evidence

Implemented:

- `DefaultTaskGovernor` for validated-plan risk classification, role assignment, confirmation requirements, and verification budgets.
- `DeterministicPlanCritic` for pre-execution hard-constraint review, including required/forbidden tools, required text, write confirmation, and step-budget limits.
- `AgentEvidenceRecord` with source/status/detail metadata and SHA-256 content hashes for verifier input.
- `DeterministicPlanVerifier` for post-synthesis evidence checks, overclaim detection, partial-result repair, and terminal-state classification.
- `AgentLoopController` wiring for `validator -> governor -> critic -> executor -> synthesizer -> verifier` inside the existing plan branch.
- plan verification activity events projected through the existing `AgentTaskActivityStore` and UI status mappings.

Focused P4 tests:

```text
swift test ... --scratch-path /private/tmp/deskpet-agentos-p4-cache --filter P4TaskGovernorVerifierTests
Executed 5 tests, with 0 failures (0 unexpected)
```

P4 regression band:

```text
swift test ... --scratch-path /private/tmp/deskpet-agentos-p4-band --filter 'P4TaskGovernorVerifierTests|P4BTaskPlannerTests|P4AToolPlatformTests|P4CTaskActivityTests|P31ProviderAdapterAcceptanceTests|P5IntegrationClosureTests|P1AgentEventStateMachineTests|P6ActivityProjectionTests'
Executed 161 tests, with 2 tests skipped and 0 failures (0 unexpected)
```

## P4 Gate

Full gate commands:

```text
xcodegen generate
Created project at /path/to/DeskPet/DeskPet.xcodeproj

xcodebuild -list -project DeskPet.xcodeproj
Result: exited 0 and listed targets/schemes. Sandbox/CoreSimulator/DerivedData warnings persisted but did not block project discovery.

swift test --disable-sandbox --disable-dependency-cache --disable-build-manifest-caching --manifest-cache local --cache-path /private/tmp/deskpet-agentos-p3-cache --config-path /private/tmp/deskpet-agentos-p3-cache/config --security-path /private/tmp/deskpet-agentos-p3-cache/security --scratch-path /private/tmp/deskpet-agentos-p4-full
Executed 703 tests, with 2 tests skipped and 0 failures (0 unexpected)

git diff --check
Result: PASS
```

P4 Gate: PASS.

## P5 Implementation Evidence

Implemented:

- extended `AgentResultDocument` schema with revisions, component state, accessibility metadata, and P5 components: progress, choiceList, comparisonList, cardGrid, form, confirmation, map, chart, artifact, and emptyState.
- `AgentResultPatch`, `AgentResultPatchOperation`, and `AgentResultPatchReducer` for explicit base revision patching, stale patch rejection, nonblank safeguards, resolved choices, and collapsed sections.
- explicit event kinds for `resultSnapshot`, `resultPatch`, `uiInteractionRequested`, and `uiInteractionResolved`, while keeping legacy `resultProduced` replay-compatible.
- `AgentResultInteractionEvent` with task/run/document/component/action/payload/timestamp and stream/envelope adapters.
- native SwiftUI rendering for the extended schema and choice interactions in `AgentResultView`.
- Task Center interaction forwarding through `CompanionAgentRuntimeModel.handleResultInteraction`, which records the interaction and applies a deterministic resolved/collapsed patch.
- terminal-safe UI patching: post-terminal result patches can update UI state without changing terminal task status.

Focused P5 tests:

```text
swift test ... --scratch-path /private/tmp/deskpet-agentos-p5-focused --filter P5GenerativeUIFlowTests
Executed 5 tests, with 0 failures (0 unexpected)
```

P5 regression band:

```text
swift test ... --scratch-path /private/tmp/deskpet-agentos-p5-band --filter 'P5GenerativeUIFlowTests|P6ResultSchemaTests|P6ActivityProjectionTests|P5EventBusTests|P5ActionDispatcherTests|P5IntegrationClosureTests|P4TaskGovernorVerifierTests|P31ProviderAdapterAcceptanceTests|P1AgentEventStateMachineTests'
Executed 124 tests, with 2 tests skipped and 0 failures (0 unexpected)
```

## P5 Gate

Full gate commands:

```text
xcodegen generate
Created project at /path/to/DeskPet/DeskPet.xcodeproj

xcodebuild -list -project DeskPet.xcodeproj
Result: exited 0 and listed targets/schemes. Sandbox/CoreSimulator/DerivedData warnings persisted but did not block project discovery.

swift test --disable-sandbox --disable-dependency-cache --disable-build-manifest-caching --manifest-cache local --cache-path /private/tmp/deskpet-agentos-p3-cache --config-path /private/tmp/deskpet-agentos-p3-cache/config --security-path /private/tmp/deskpet-agentos-p3-cache/security --scratch-path /private/tmp/deskpet-agentos-p5-full
Executed 708 tests, with 2 tests skipped and 0 failures (0 unexpected)

git diff --check
Result: PASS
```

P5 Gate: PASS.

## P6 Implementation Evidence

Implemented:

- `CapabilityDescriptor` normalization from the existing `CapabilityCatalog`, `ToolManifest`, and `ToolCatalogSnapshot`.
- `CapabilityKernel` graph construction for capability, tool, and workflow nodes with `requires`, `provides`, and `precedes` edges.
- capability gap detection for available, disabled, missing, permanently denied, and unknown requirements.
- duplicate tool-id detection against release and generated catalogs.
- `DynamicWorkflowComposer` for snapshot-based workflow composition.
- `DynamicWorkflowExecutor` for real composed execution through `PermissionGate`, `ToolPlatformExecuting`, input/output schema validation, and `AgentEvidenceRecord`.
- `ToolFactory` lifecycle for task-scoped ephemeral tools: static validation, sandbox testing, current task execution, result verification, reusable candidate, explicit promotion, and rollback.
- default-deny ToolFactory Permission Gate so ephemeral execution cannot run until the real caller injects a gate.
- `RestrictedEphemeralToolRunner` safe fixture for structured sort/deduplicate/sum transforms only.
- runtime denial for unauthorized paths outside the task workspace, project source paths, timeout, cancellation, schema-invalid output, and self-registration signals.
- successful current-task ephemeral execution remains a reusable candidate only; it is not auto-promoted or registered as a permanent reusable tool.

Focused P6 tests:

```text
swift test ... --scratch-path /private/tmp/deskpet-agentos-p6-focused --filter P6CapabilityKernelToolFactoryTests
Executed 6 tests, with 0 failures (0 unexpected)
```

P6 regression band:

```text
swift test ... --scratch-path /private/tmp/deskpet-agentos-p6-band --filter 'P6CapabilityKernelToolFactoryTests|P6PermissionGrantTests|SkillPipelineTests|P6ResultSchemaTests|P6ActivityProjectionTests|P4AToolPlatformTests|P4TaskGovernorVerifierTests|P5ToolRegistryTests|P5EventBusActionTests|P5GenerativeUIFlowTests|P5IntegrationClosureTests'
Executed 101 tests, with 0 failures (0 unexpected)
```

## P6 Gate

Full gate commands:

```text
xcodegen generate
Created project at /path/to/DeskPet/DeskPet.xcodeproj

xcodebuild -list -project DeskPet.xcodeproj
Result: exited 0 and listed targets/schemes. Sandbox/CoreSimulator/DerivedData warnings persisted but did not block project discovery.

swift test --disable-sandbox --disable-dependency-cache --disable-build-manifest-caching --manifest-cache local --cache-path /private/tmp/deskpet-agentos-p6-cache --config-path /private/tmp/deskpet-agentos-p6-cache/config --security-path /private/tmp/deskpet-agentos-p6-cache/security --scratch-path /private/tmp/deskpet-agentos-p6-full
Executed 714 tests, with 2 tests skipped and 0 failures (0 unexpected)

git diff --check
Result: PASS
```

P6 Gate: PASS.

## P7 Implementation Evidence

Implemented:

- `AgentCheckpoint`, `AgentCheckpointBuilder`, and `AgentRecoveryPlanner` for deterministic checkpoint, replay, and resume planning from the existing `AgentEventEnvelope` stream.
- replay deduplication by event id before projection, so duplicate delivery does not double-apply UI or terminal state.
- `AgentSideEffectLedger` for stable operation-id based idempotency, with privacy-safe argument/result hashes and no repeated execution for started or succeeded side effects.
- recovery classification for terminal replay, cancellation replay, tool-started resume, tool-completed/model-missing synthesis resume, provider stream interruption, and active checkpoints that require user review.
- `ModelConformanceProfile`, `ModelConformanceRequest`, `ProviderConformanceReport`, and `ModelConformanceGate` for provider/model role limits, true streaming, native tool calling, required/incompatible flags, and max tool-call limits.
- MiniMax M3 conformance derivation from existing provider config and `ProviderToolCapabilityPolicy`, including `thinking.type=disabled` and `reasoning_split=true`.
- P7 documentation in `RECOVERY_REPLAY_CONFORMANCE.md`, `MODEL_CONFORMANCE.md`, and the main architecture document.

Focused P7 tests:

```text
swift test ... --scratch-path /private/tmp/deskpet-agentos-p7-focused --filter P7RecoveryConformanceTests
Executed 6 tests, with 0 failures (0 unexpected)
```

P7 regression band:

```text
swift test ... --scratch-path /private/tmp/deskpet-agentos-p7-band --filter 'P7RecoveryConformanceTests|P5AgentReplayAndExportTests|P4AgentTaskTests|P6ActivityProjectionTests|P5IntegrationClosureTests|P4AToolPlatformTests|P6CapabilityKernelToolFactoryTests|P6PermissionGrantTests|P31ProviderAdapterAcceptanceTests'
Executed 147 tests, with 2 tests skipped and 0 failures (0 unexpected)
```

## P7 Gate

Full gate commands:

```text
xcodegen generate
Created project at /path/to/DeskPet/DeskPet.xcodeproj

xcodebuild -list -project DeskPet.xcodeproj
Result: exited 0 and listed targets/schemes. Sandbox/CoreSimulator/DerivedData warnings persisted but did not block project discovery.

swift test --disable-sandbox --disable-dependency-cache --disable-build-manifest-caching --manifest-cache local --cache-path /private/tmp/deskpet-agentos-p7-cache --config-path /private/tmp/deskpet-agentos-p7-cache/config --security-path /private/tmp/deskpet-agentos-p7-cache/security --scratch-path /private/tmp/deskpet-agentos-p7-full
Executed 720 tests, with 2 tests skipped and 0 failures (0 unexpected)
```

git diff --check
Result: PASS

P7 Gate: PASS.

## 2026-07-27 P7 Durable Repair Addendum

Implemented in this repair:

- `AgentCheckpointStore` persists schema-versioned checkpoints per task/run with atomic replacement and latest/load/delete/prune support.
- `AgentSideEffectLedgerStore` persists append-only side-effect transitions before execution and blocks duplicate `started`, `succeeded`, and `outcomeUnknown` side effects after runtime recreation.
- `ModelConformanceProfileStore` persists model conformance by provider/model/adapter/conformance version and feeds rebuilt router policy.
- `AgentRecoveryBootstrap` loads persisted events, checkpoint, side-effect ledger, and conformance policy through the existing event/reducer path, with safe fallback for corrupt, ahead, duplicate, or gapped checkpoints.
- Production wiring now injects checkpoint, side-effect, and conformance stores through `AppDelegate`, `AgentRuntimeContainer`, `AgentTaskActivityStore`, `ProviderStore`, `AIServices`, and `ToolRegistry` without adding a second runtime, router, event hub, task ledger, or side-effect execution path.
- `ModelRouter` now accepts persisted conformance policy and fails closed for missing/expired/insufficient profiles when a policy is present.
- A live MiniMax cancellation probe was added and gated behind `DESKPET_LIVE_PROVIDER_PROBE=1`.

Focused and regression proof from this repair:

```text
swift test --filter P7RecoveryConformanceTests
Executed 18 tests, with 2 tests skipped and 0 failures (0 unexpected)

DESKPET_P7_PROCESS_INTEGRATION_PHASE=seed DESKPET_P7_PROCESS_INTEGRATION_ROOT=/private/tmp/deskpet-p7-process-20260727-234217 swift test --filter P7RecoveryConformanceTests/testProcessPhaseASeedsDurableRecoveryIntegrationRootWhenEnabled
Executed 1 test, with 0 failures (0 unexpected)

DESKPET_P7_PROCESS_INTEGRATION_PHASE=reload DESKPET_P7_PROCESS_INTEGRATION_ROOT=/private/tmp/deskpet-p7-process-20260727-234217 swift test --filter P7RecoveryConformanceTests/testProcessPhaseBReloadsDurableRecoveryIntegrationRootWhenEnabled
Executed 1 test, with 0 failures (0 unexpected)

Two-process integration root:
/private/tmp/deskpet-p7-process-20260727-234217
Evidence files: events JSONL, checkpoint JSON, side_effects JSONL, conformance profile JSON, process metadata JSON, durable-counter.txt.
Durable counter after reload: 1

DESKPET_LIVE_PROVIDER_PROBE=1 swift test --filter testLiveMiniMaxStreamCancellationStopsRealAdapterTransportWhenEnabled
Executed 1 test, with 0 failures (0 unexpected)

swift test --filter testLiveMiniMaxStreamCancellationStopsRealAdapterTransportWhenEnabled
Executed 1 test, with 1 test skipped and 0 failures (0 unexpected)

swift test --disable-sandbox --disable-dependency-cache --disable-build-manifest-caching --manifest-cache local --cache-path /private/tmp/deskpet-agentos-p7-cache --config-path /private/tmp/deskpet-agentos-p7-config --security-path /private/tmp/deskpet-agentos-p7-security --scratch-path /private/tmp/deskpet-agentos-p7-full-swiftpm
Executed 758 tests, with 5 tests skipped and 0 failures (0 unexpected)

DragonV1ManifestTests/testCharacterV2ManifestStillLoadsWithDragonAssetsPresent
Initial full regression exposed cwd-sensitive test pollution after Lumi Scholar runtime tests. The test now derives the repository root from `#filePath` instead of `FileManager.default.currentDirectoryPath`; `DragonV1ManifestTests` then passed 20 tests with 0 failures, and the full suite passed.

git diff --check
Result: PASS

xcodegen generate
Created project at /path/to/DeskPet/DeskPet.xcodeproj

xcodebuild -project DeskPet.xcodeproj -scheme DeskPet -destination platform=macOS -derivedDataPath /private/tmp/deskpet-p7-xcode-derived build
Result: BUILD SUCCEEDED
```

Original GUI/integration blocker:

```text
P6_XCUITEST_EVIDENCE_DIR=/private/tmp/deskpet-p7-ui-evidence xcodebuild test -project DeskPet.xcodeproj -scheme DeskPet -destination platform=macOS -only-testing:DeskPetUITests/DeskPetMinimumSmokeUITests/testMinimumSmokeLaunchesAutomationProfileAndClicksStableControl
Result: FAILED before product assertions
Failure: Timed out while enabling automation mode.
xcresult: /path/to/DeskPetMinimumSmokeUITests.xcresult

P6_XCUITEST_EVIDENCE_DIR=/private/tmp/deskpet-p7-ui-evidence-rerun xcodebuild test -project DeskPet.xcodeproj -scheme DeskPet -destination platform=macOS -only-testing:DeskPetUITests/DeskPetMinimumSmokeUITests/testMinimumSmokeLaunchesAutomationProfileAndClicksStableControl -resultBundlePath /private/tmp/deskpet-p7-minimum-smoke-rerun.xcresult
Result: FAILED before product assertions
Failure: DeskPetUITests-Runner failed to initialize for UI testing; timed out while enabling automation mode.
Action log: testsPassedString="0 tests total, 0 passed"

P6_XCUITEST_EVIDENCE_DIR=/private/tmp/deskpet-p7-temp-probe-rerun xcodebuild test -project DeskPet.xcodeproj -scheme DeskPet -destination platform=macOS -only-testing:DeskPetUITests/DeskPetTemporaryDirectoryProbeUITests/testXCTestRunnerTemporaryDirectoryWriteProbe -resultBundlePath /private/tmp/deskpet-p7-temp-probe-rerun.xcresult
Result: FAILED before probe body
Failure: DeskPetUITests-Runner failed to initialize for UI testing; timed out while enabling automation mode.
Action log: testsPassedString="0 tests total, 0 passed"
```

Follow-up App process recovery/integration harness:

```text
xcodegen generate
Result: Created project at /path/to/DeskPet/DeskPet.xcodeproj

xcodebuild -project DeskPet.xcodeproj -scheme DeskPet -destination platform=macOS -derivedDataPath /private/tmp/deskpet-p7-app-derived build
Result: ** BUILD SUCCEEDED **

DESKPET_P7_APP_RECOVERY_HARNESS_PHASE=seed DESKPET_P7_APP_RECOVERY_EVIDENCE_DIR=/private/tmp/deskpet-p7-app-harness-evidence-0001 /private/tmp/deskpet-p7-app-derived/Build/Products/Debug/DeskPet.app/Contents/MacOS/DeskPet --automation-profile p7_app --data-root /private/tmp/deskpet-p7-app-harness-20260728-0001
Result: P7_APP_RECOVERY_HARNESS phase=seed ok=true evidence=/private/tmp/deskpet-p7-app-harness-evidence-0001/p7_app_recovery_seed.json

DESKPET_P7_APP_RECOVERY_HARNESS_PHASE=reload DESKPET_P7_APP_RECOVERY_EVIDENCE_DIR=/private/tmp/deskpet-p7-app-harness-evidence-0001 /private/tmp/deskpet-p7-app-derived/Build/Products/Debug/DeskPet.app/Contents/MacOS/DeskPet --automation-profile p7_app --data-root /private/tmp/deskpet-p7-app-harness-20260728-0001
Result: P7_APP_RECOVERY_HARNESS phase=reload ok=true evidence=/private/tmp/deskpet-p7-app-harness-evidence-0001/p7_app_recovery_reload.json
```

App process harness evidence:

```text
Seed PID: 55815
Reload PID: 55895
Shared data root: /private/tmp/deskpet-p7-app-harness-20260728-0001
Evidence files:
- /private/tmp/deskpet-p7-app-harness-evidence-0001/p7_app_recovery_seed.json
- /private/tmp/deskpet-p7-app-harness-evidence-0001/p7_app_recovery_reload.json
Durable files:
- AgentCheckpoints/2FB4B889-5568-449E-9896-E3E926A6796C/D86D3DAD-237F-40E8-AB76-C9C440803E44.json
- AgentRunEvents/2FB4B889-5568-449E-9896-E3E926A6796C/D86D3DAD-237F-40E8-AB76-C9C440803E44.jsonl
- AgentSideEffects/2FB4B889-5568-449E-9896-E3E926A6796C/D86D3DAD-237F-40E8-AB76-C9C440803E44/side_effects.jsonl
- ModelConformanceProfiles/p7.app.provider__p7-app-model__ollama__v1.json
- agent_task_activity.jsonl
- providers.json
```

Reload evidence assertions:

```text
checkpointLastSequence=5
checkpointText="app process recovery text"
completedToolCallIDs=["app-process-tool"]
pendingStepIDs=["app-process-pending"]
currentUIRevision=31
activityTaskVisible=true
canonicalTaskVisible=true
counterValue="1"
writeResultCount=1
durableLedgerStatuses=["started","succeeded"]
recoveryWarnings=["conformanceProfileApplied","sideEffectLedgerLoaded"]
routeAppliedProfileID="p7.app.provider:p7-app-model:ollama:v1"
routeMaxAutonomousSteps=2
routeDeniedSteps="autonomous_step_limit"
routeDeniedParallel="parallel_tool_calls_disabled"
```

Full post-harness regression:

```text
swift test ... --scratch-path /private/tmp/deskpet-p7-full-test
Executed 758 tests, with 5 tests skipped and 0 failures (0 unexpected)

git diff --check
Result: PASS
```

Gate conclusion for this repair: durable P7 code blocker is fixed. The macOS XCUITest automation service still timed out before product assertions in this environment, but the allowed DEBUG App process seed/reload harness proved recovery/integration against the real DeskPet app executable, isolated app data root, production paths, the existing AgentRuntimeContainer ToolRegistry, production ActivityStore projection, durable checkpoint store, durable side-effect ledger, ProviderStore defaults, persisted conformance profile, and recreated ModelRouter.

## P8 Implementation Evidence

Implemented:

- additive `AgentEventEnvelope.parentEventID` for grouped event hierarchy.
- `AgentStreamEvent` projection preserves `parentEventID` from envelope to stream event and back to envelope.
- `P8EndToEndAcceptanceTests` covers the 12 required P8 flows through explicitly marked runtime/fixture acceptance, not by pretending a GUI runner executed.
- XCUITest data-root isolation is covered by unit-level acceptance: a test-unique temporary root under `FileManager.default.temporaryDirectory` is accepted, a fixed `/tmp/DeskPetAutomation` root is rejected, unsafe roots are reported, and no fallback to the normal user data root is allowed.
- deterministic DEBUG automation providers and tools for P8 GUI acceptance, injected through the existing `AgentRuntimeContainer`, existing `ToolRegistry`, existing permission gate, and existing activity/ledger stores.
- `AgentPlanProposalStep.toolID` as an additive field so plan steps can name the real tool id while keeping capability ids intact.
- terminal-failure safeguards in `AgentLoopController` so denied, failed, and timed-out tool observations cannot be converted into success by a later final response.
- cancellation recording in `PetAgentRuntimeCoordinator` so user Stop produces cancelled conversation state, scheduler activity, and terminal cancelled ledger state without emitting completed/succeeded terminal state.
- Task Center, result renderer, chat bubbles, input, Stop control, and choice actions now expose stable accessibility identifiers used by real macOS XCUITest.

Runtime/fixture flow coverage:

1. Ordinary streaming chat has no tool event, hides thinking, and Stop yields cancelled terminal state.
2. Datetime success/failure emits real tool activity, developer tool detail, verifier events, correct replay, and failure terminal state when the tool fails.
3. Tool failure is preserved as failed activity and is not projected as completed.
4. Verifier rejection repairs an unsupported claim into an evidence-honest partial terminal state.
5. Allow once grants only the current task/run/tool call and requires a new decision on the next task.
6. Deny prevents execution and records denied/degraded state without bypass.
7. Dynamic choice UI streams candidates, records selection, collapses/resolves the UI, and continues.
8. Cancellation suppresses later visible events across model, tool, and verifier stages.
9. Tool Factory ephemeral execution verifies output and remains a reusable candidate only; it is not auto-promoted.
10. Restart/replay restores checkpoint state without repeating completed side effects.
11. Parallel read-only tools preserve sequence and parent relationships through stream/envelope round-trip.
12. Old completed tasks do not become active live cards in a new conversation.

Focused P8 tests:

```text
swift test ... --scratch-path /private/tmp/deskpet-agentos-p8-focused --filter P8EndToEndAcceptanceTests
Executed 11 tests, with 0 failures (0 unexpected)
```

P8 regression band:

```text
swift test ... --scratch-path /private/tmp/deskpet-agentos-p8-band --filter 'P8EndToEndAcceptanceTests|P7RecoveryConformanceTests|P6CapabilityKernelToolFactoryTests|P6PermissionGrantTests|P6ActivityProjectionTests|P5GenerativeUIFlowTests|P5IntegrationClosureTests|P4TaskGovernorVerifierTests|P4AToolPlatformTests|P31ProviderAdapterAcceptanceTests|P62AutomationDataRootTests|P61AcceptanceInfrastructureTests'
Executed 182 tests, with 2 tests skipped and 0 failures (0 unexpected)
```

Current focused runtime acceptance:

```text
swift test --filter P8EndToEndAcceptanceTests --scratch-path /private/tmp/deskpet-p8-swiftpm-scratch
Executed 11 tests, with 0 failures (0 unexpected)

swift test --filter P3BoundedAgentLoopControllerTests --scratch-path /private/tmp/deskpet-p8-swiftpm-scratch
Executed 19 tests, with 0 failures (0 unexpected)
```

Full SwiftPM gate:

```text
swift test --disable-sandbox --disable-dependency-cache --disable-build-manifest-caching --manifest-cache local --cache-path /private/tmp/deskpet-agentos-p8-cache --config-path /private/tmp/deskpet-agentos-p8-cache/config --security-path /private/tmp/deskpet-agentos-p8-cache/security --scratch-path /private/tmp/deskpet-agentos-p8-full
Executed 731 tests, with 2 tests skipped and 0 failures (0 unexpected)

SWIFTPM_MODULECACHE_OVERRIDE=/private/tmp/deskpet-p8-module-cache CLANG_MODULE_CACHE_PATH=/private/tmp/deskpet-p8-clang-cache swift test --scratch-path /private/tmp/deskpet-p8-swiftpm-scratch
Executed 731 tests, with 2 tests skipped and 0 failures (0 unexpected)
```

Project discovery:

```text
xcodegen generate
Created project at /path/to/DeskPet/DeskPet.xcodeproj

xcodebuild -list -project DeskPet.xcodeproj
Result: exited 0 and listed targets/schemes. Sandbox/CoreSimulator/DerivedData warnings persisted but did not block project discovery.
```

Real GUI/XCUITest attempts:

```text
xcodebuild test -project DeskPet.xcodeproj -scheme DeskPet -destination 'platform=macOS' -derivedDataPath /private/tmp/deskpet-p8-derived -resultBundlePath /private/tmp/deskpet-p8-temp-probe.xcresult -only-testing:DeskPetUITests/DeskPetTemporaryDirectoryProbeUITests/testXCTestRunnerTemporaryDirectoryWriteProbe
Result: exit 133. No result bundle Info.plist was produced and no evidence directory was written.

xcodebuild test -quiet -project DeskPet.xcodeproj -scheme DeskPet -destination 'platform=macOS' -derivedDataPath /private/tmp/deskpet-p8-derived-quiet -resultBundlePath /private/tmp/deskpet-p8-temp-probe-quiet.xcresult -only-testing:DeskPetUITests/DeskPetTemporaryDirectoryProbeUITests/testXCTestRunnerTemporaryDirectoryWriteProbe
Result: exit 133. Visible environment warnings included CoreSimulatorService connection invalidation and screen-saver suppression failure. No result bundle was produced.

env P6_XCUITEST_EVIDENCE_DIR=/private/tmp/deskpet-p8-continuation-ui-evidence xcodebuild test -quiet -project DeskPet.xcodeproj -scheme DeskPet -destination 'platform=macOS' -derivedDataPath /private/tmp/deskpet-p8-continuation-derived -resultBundlePath /private/tmp/deskpet-p8-continuation-temp-probe.xcresult -only-testing:DeskPetUITests/DeskPetTemporaryDirectoryProbeUITests/testXCTestRunnerTemporaryDirectoryWriteProbe
Result: exit 133 inside the restricted sandbox. A result bundle path was created, but the run did not prove test success.

env P6_XCUITEST_EVIDENCE_DIR=/private/tmp/deskpet-p8-continuation-ui-evidence-escalated xcodebuild test -quiet -project DeskPet.xcodeproj -scheme DeskPet -destination 'platform=macOS' -derivedDataPath /private/tmp/deskpet-p8-continuation-derived-escalated -resultBundlePath /private/tmp/deskpet-p8-continuation-temp-probe-escalated.xcresult -only-testing:DeskPetUITests/DeskPetTemporaryDirectoryProbeUITests/testXCTestRunnerTemporaryDirectoryWriteProbe
Result: Passed. xcresult summary: totalTestCount=1, passedTests=1, failedTests=0, skippedTests=0.

env P6_XCUITEST_EVIDENCE_DIR=/private/tmp/deskpet-p8-continuation-minimum-smoke-evidence xcodebuild test -quiet -project DeskPet.xcodeproj -scheme DeskPet -destination 'platform=macOS,arch=arm64' -derivedDataPath /private/tmp/deskpet-p8-continuation-minimum-smoke-derived -resultBundlePath /private/tmp/deskpet-p8-continuation-minimum-smoke.xcresult -only-testing:DeskPetUITests/DeskPetMinimumSmokeUITests/testMinimumSmokeLaunchesAutomationProfileAndClicksStableControl
Result: Failed. xcresult summary: totalTestCount=1, failedTests=1. Failure was pgrep failed with status 3 after the UI assertions had run.

env P6_XCUITEST_EVIDENCE_DIR=/private/tmp/deskpet-p8-continuation-minimum-smoke2-evidence xcodebuild test -quiet -project DeskPet.xcodeproj -scheme DeskPet -destination 'platform=macOS,arch=arm64' -derivedDataPath /private/tmp/deskpet-p8-continuation-minimum-smoke2-derived -resultBundlePath /private/tmp/deskpet-p8-continuation-minimum-smoke2.xcresult -only-testing:DeskPetUITests/DeskPetMinimumSmokeUITests/testMinimumSmokeLaunchesAutomationProfileAndClicksStableControl
Result: Passed after replacing the pgrep-based residual process probe with NSRunningApplication. xcresult summary: totalTestCount=1, passedTests=1, failedTests=0, skippedTests=0.

xcodebuild test -quiet -project DeskPet.xcodeproj -scheme DeskPet -destination platform=macOS,arch=arm64 -derivedDataPath /private/tmp/deskpet-p8-gui-flow56-derived-fresh -resultBundlePath /path/to/DeskPet/.codex_tmp/p8-results/p8-gui-all-fresh2.xcresult -only-testing:DeskPetUITests/DeskPetP8GUIAcceptanceUITests -test-timeouts-enabled YES -default-test-execution-time-allowance 120
Result: Passed. xcresult summary: totalTestCount=5, passedTests=5, failedTests=0, skippedTests=0.
```

Escalation note:

- On July 24, 2026, a non-sandbox rerun request was rejected by the platform usage limit.
- On July 25, 2026, non-sandbox XCUITest execution was available. The temporary-directory probe and the minimum smoke test both passed.
- On July 25, 2026, the P8 real GUI acceptance class executed through macOS XCUITest and passed. The class covers the GUI-observable flows: ordinary streaming chat, real datetime tool, tool failure, allow-once permission, deny permission, dynamic choice UI, and user cancellation. The non-GUI P8 flows remain covered by the runtime/fixture acceptance suite.

Real GUI evidence:

```text
/path/to/DeskPet/.codex_tmp/p8-results/flow12-real8.xcresult
Flow 1 and Flow 2 passed: ordinary streaming chat and datetime tool.
Profile: /private/tmp/deskpet-p8-gui-automation-data/P8GUI-flow1-flow2-39FFF0E8

/path/to/DeskPet/.codex_tmp/p8-results/flow3-real2.xcresult
Flow 3 passed: tool failure remains failed and is not projected as completed.
Profile: /private/tmp/deskpet-p8-gui-automation-data/P8GUI-flow3-7FE07FFA

/path/to/DeskPet/.codex_tmp/p8-results/flow56-fresh2.xcresult
Flow 5 and Flow 6 passed: allow once and deny permission.

/path/to/DeskPet/.codex_tmp/p8-results/flow7-fresh19.xcresult
Flow 7 passed: dynamic choice UI records Alpha selection and resolved result state.
Profile: /private/tmp/deskpet-p8-gui-automation-data/P8GUI-flow7-09E6221D

/path/to/DeskPet/.codex_tmp/p8-results/flow8-fresh6.xcresult
Flow 8 passed: Stop records cancelled chat, taskCancelled activity, and cancelled ledger terminal.
Profile: /private/tmp/deskpet-p8-gui-automation-data/P8GUI-flow8-4E6D075F

/path/to/DeskPet/.codex_tmp/p8-results/p8-gui-all-fresh2.xcresult
Full P8 GUI acceptance class passed: totalTestCount=5, passedTests=5, failedTests=0, skippedTests=0.
```

Flow 8 persistence proof:

```text
/private/tmp/deskpet-p8-gui-automation-data/P8GUI-flow8-4E6D075F/ApplicationSupport/conversations.json
Pet message persisted with "status" : "cancelled".

/private/tmp/deskpet-p8-gui-automation-data/P8GUI-flow8-4E6D075F/ApplicationSupport/agent_task_activity.jsonl
Scheduler activity persisted taskCancelled with failureCategory=cancelled.

/private/tmp/deskpet-p8-gui-automation-data/P8GUI-flow8-4E6D075F/ApplicationSupport/agent_task_ledger.json
Terminal ledger event persisted "kind" : "cancelled" and "state" : "cancelled"; no completed/succeeded terminal event was present in the ledger.
```

## P8 Gate

P8 runtime/fixture gate: PASS.

P8 real GUI minimum-smoke gate: PASS.

P8 real GUI acceptance class gate: PASS.

git diff --check
Result: PASS

Additional untracked-file sanity:

```text
Checked P7/P8 source, tests, and docs for trailing whitespace and merge-conflict markers.
Result: no matches
```

P8 Gate: PASS.

## A. HISTORICAL_2026_07_25_FINAL_STATUS

Historical status recorded on 2026-07-25:

```text
AGENT_OS_FOUNDATION_COMPLETE
```

This historical status is refreshed by the 2026-07-27 P7 durable repair and the 2026-07-28 App process recovery harness:

```text
AGENT_OS_FOUNDATION_COMPLETE
```

## B. BASELINE_AUDIT

- Initial HEAD: `af6979ec5bc4cac278ea5d51de901e1a4def5ea8`.
- Initial worktree: dirty before P0; many modified and untracked files already existed. No destructive Git operation was run.
- Existing architecture: one reusable runtime around `PetAgentRuntimeCoordinator`, `AgentLoopController`, `ToolRegistry`, `PermissionGate`, `AgentEventHub`, `AgentRunEventStore`, `AgentTaskActivityStore`, provider adapters, Memory V2, scheduler, Task Center, Floating Chat, and native result rendering.
- Reused components: existing runtime, provider router, tool registry, capability/permission gates, event/activity stores, Memory V2, scheduler, Task Center, and native SwiftUI result renderer.
- P0 issues: state/event duplication, provider streaming gaps, transitional Floating Chat preview state, missing Tool Factory, missing recovery/conformance/idempotency layer, and incomplete GUI acceptance.
- Baseline tests recorded at P0: `swift test ... /private/tmp/deskpet-agentos-p0-swiftpm` executed 686 tests with 0 failures.

## C. ARCHITECTURE_IMPLEMENTED

- Event Stream: additive `AgentStreamEvent`, canonical kind mapping, visibility, redaction, replay adapters, and `parentEventID` round-trip.
- State Machine: `AgentRunState` plus `AgentTaskProjectionReducer`, terminal handling, replay sorting, dedupe, and active-task isolation.
- Streaming: `ProviderDelta`, true OpenAI-compatible SSE, Ollama NDJSON, hidden reasoning separation, streamed tool-call accumulation, cancellation barriers, and UI coalescing.
- Tool Activity: runtime-originated tool/verification events, datetime vertical verification, failure projection, developer details, and history replay.
- Multi-Agent: `TaskGovernor`, deterministic plan critic, executor boundary, verifier, repair loop, and bounded plan execution through the existing runtime.
- Trust Kernel: schema validation, capability/permission gates, approval grants, side-effect ledger value layer, evidence records, redaction, cancellation, and idempotency rules.
- Capability Kernel: descriptors, graph, gap detection, workflow composition, dynamic workflow execution, and provider snapshot discipline.
- Tool Factory: static validation, sandbox testing, task-scoped execution, verification, reusable-candidate state, explicit promotion, rollback, cancellation, timeout, and unauthorized path rejection.
- Generative UI: schema validation, native snapshot/patch renderer, choice interactions, resolved/collapsed state, replay, and no arbitrary HTML/JS execution path.
- Recovery: checkpoint builder, replay state restoration, recovery planner, duplicate-event handling, side-effect idempotency, and model-missing resume.
- Conformance: model/provider profiles, role gating, native tool/true-streaming/request-flag limits, provider conformance reports, and MiniMax M3 policy derivation.

## D. FILES_CREATED

- `docs/agent_os/AGENT_OS_ARCHITECTURE.md`: architecture audit, migration path, P1-P8 state, and data flow.
- `docs/agent_os/AGENT_EVENT_PROTOCOL.md`: event protocol, visibility, reducer, redaction, and migration rules.
- `docs/agent_os/TASK_STATE_MACHINE.md`: canonical run state mapping and invariants.
- `docs/agent_os/PROVIDER_STREAMING_PROTOCOL.md`: ProviderDelta streaming and live-provider policy.
- `docs/agent_os/MULTI_AGENT_GOVERNANCE.md`: governor, critic, executor, verifier, and role boundaries.
- `docs/agent_os/TRUST_KERNEL.md`: deterministic trust, side effects, injection boundaries, and remaining gaps.
- `docs/agent_os/CAPABILITY_KERNEL.md`: capability descriptors, graph, gaps, and dynamic workflows.
- `docs/agent_os/TOOL_FACTORY.md`: Tool Factory lifecycle, sandbox, promotion, and rollback.
- `docs/agent_os/GENERATIVE_UI_SCHEMA.md`: native result schema, patching, interaction, and gaps.
- `docs/agent_os/MODEL_CONFORMANCE.md`: model/provider capability profiles and conformance gates.
- `docs/agent_os/RECOVERY_REPLAY_CONFORMANCE.md`: checkpoint, replay, recovery, idempotency, and model role limits.
- `docs/agent_os/ACCEPTANCE_PLAN.md`: serial P0-P8 gate plan.
- `docs/agent_os/ACCEPTANCE_REPORT.md`: phased evidence and this final structured status.
- `Sources/PetAgentRuntime/RecoveryConformance.swift`: P7 checkpoint, recovery, side-effect ledger, and model conformance types.
- `Tests/DeskPetTests/P7RecoveryConformanceTests.swift`: P7 replay/recovery/conformance tests.
- `Tests/DeskPetTests/P8EndToEndAcceptanceTests.swift`: P8 runtime/fixture flow tests.
- `Tests/DeskPetUITests/DeskPetP8GUIAcceptanceUITests.swift`: P8 real macOS GUI acceptance flows.

## E. FILES_MODIFIED

- `Sources/PetAgentRuntime/AgentEventModels.swift`: additive `parentEventID` on `AgentEventEnvelope`.
- `Sources/PetAgentRuntime/AgentStreamEvent.swift`: stream/envelope parent relationship preservation.
- `Sources/PetAgentRuntime/AgentTypes.swift`: additive `toolID` on plan proposal steps.
- `Sources/PetAgentRuntime/AgentLoopDecisionParser.swift`: raw tool-call parsing resolves explicit tool ids while preserving capability ids.
- `Sources/PetAgentRuntime/AgentLoopController.swift`: terminal failed/denied/timeout observations cannot be overwritten by a later success response.
- `Sources/PetAgentRuntime/PetAgentRuntimeCoordinator.swift`: user cancellation now persists cancelled conversation/task/ledger terminal state.
- `Sources/DeskPet/AI/AutomationAgentLoopDecisionProvider.swift`: deterministic automation scripts/providers for real P8 GUI acceptance.
- `Sources/DeskPet/AppDelegate.swift`: DEBUG automation provider selection and profile wiring.
- `Sources/DeskPet/Runtime/AgentRuntimeContainer.swift`: test-only additional tools are registered through the existing release registry path.
- `Sources/DeskPet/UI/CompanionChatView.swift`: stable accessibility identifiers and cancelled status presentation.
- `Sources/DeskPet/UI/AgentResultView.swift`: stable result section and choice accessibility identifiers.
- `Sources/DeskPet/UI/TaskCenterView.swift`: real task titles, result panel visibility, and narrow-layout accessibility for GUI acceptance.
- `Tests/DeskPetUITests/DeskPetMinimumSmokeUITests.swift`: replaced `pgrep` residual-process probe with `NSRunningApplication` so GUI smoke does not depend on sysmond process enumeration.
- `Tests/DeskPetTests/P3BoundedAgentLoopTests.swift`: expectations updated for deterministic P8 terminal fallback semantics.
- Agent OS docs listed above were updated to reflect current P7/P8 implementation rather than stale P0-only gaps.

## F. MIGRATIONS

- Data model changes are additive: `AgentEventEnvelope.parentEventID` is optional and old JSONL rows can decode without it.
- Data model changes are additive: `AgentPlanProposalStep.toolID` is optional and old JSON rows can decode without it.
- Canonical stream/reducer layers adapt existing `AgentEventEnvelope` and legacy `AgentTaskActivityEvent` instead of replacing stores.
- Recovery/conformance/side-effect ledger types are additive value layers; no irreversible persistence migration was introduced.
- Old activity/history rows remain replay-compatible through adapters and reducer fallbacks.

## G. TEST_RESULTS

- `xcodegen generate`: PASS; project regenerated.
- `xcodebuild -list -project DeskPet.xcodeproj`: PASS; targets/schemes readable, with sandbox/CoreSimulator/DerivedData warnings.
- P8 focused SwiftPM: 11 tests, 0 failures.
- P3 bounded-loop focused SwiftPM: 19 tests, 0 failures.
- P8 regression band: 182 tests, 2 skipped, 0 failures.
- Full SwiftPM gate after the July 25 GUI/runtime fix: 731 tests, 2 skipped, 0 failures.
- `DeskPetTemporaryDirectoryProbeUITests/testXCTestRunnerTemporaryDirectoryWriteProbe`: sandbox exit 133; non-sandbox rerun PASS, 1 test passed.
- `DeskPetMinimumSmokeUITests/testMinimumSmokeLaunchesAutomationProfileAndClicksStableControl`: first non-sandbox run failed only at `pgrep` residual process check; after AppKit residual check fix, non-sandbox rerun PASS, 1 test passed.
- `DeskPetP8GUIAcceptanceUITests`: PASS; totalTestCount=5, passedTests=5, failedTests=0, skippedTests=0.
- `git diff --check`: PASS after P8 documentation update.

## H. GUI_ACCEPTANCE

Evidence paths:

- Runner probe PASS: `/private/tmp/deskpet-p8-continuation-temp-probe-escalated.xcresult`.
- Minimum smoke PASS: `/private/tmp/deskpet-p8-continuation-minimum-smoke2.xcresult`.
- GUI Flow 1 and Flow 2 PASS: `/path/to/DeskPet/.codex_tmp/p8-results/flow12-real8.xcresult`.
- GUI Flow 3 PASS: `/path/to/DeskPet/.codex_tmp/p8-results/flow3-real2.xcresult`.
- GUI Flow 5 and Flow 6 PASS: `/path/to/DeskPet/.codex_tmp/p8-results/flow56-fresh2.xcresult`.
- GUI Flow 7 PASS: `/path/to/DeskPet/.codex_tmp/p8-results/flow7-fresh19.xcresult`.
- GUI Flow 8 PASS: `/path/to/DeskPet/.codex_tmp/p8-results/flow8-fresh6.xcresult`.
- Full P8 GUI acceptance class PASS: `/path/to/DeskPet/.codex_tmp/p8-results/p8-gui-all-fresh2.xcresult`.

Flow status:

1. Ordinary streaming chat: GUI PASS and runtime/fixture PASS.
2. Real datetime tool: GUI PASS and runtime/fixture PASS.
3. Tool failure: GUI PASS and runtime/fixture PASS.
4. Verifier rejection: runtime/fixture PASS.
5. Allow once permission: GUI PASS and runtime/fixture PASS.
6. Deny permission: GUI PASS and runtime/fixture PASS.
7. Dynamic choice UI: GUI PASS and runtime/fixture PASS.
8. Cancel task tree: GUI PASS and runtime/fixture PASS.
9. Tool Factory: runtime/fixture PASS.
10. Restart/replay: runtime/fixture PASS.
11. Parallel read-only tools: runtime/fixture PASS.
12. Old task isolation: runtime/fixture PASS.

## I. SECURITY_AND_PERMISSION_RESULT

- Thinking/reasoning isolation: covered by streaming sanitizer and provider tests; hidden reasoning is not user-visible text.
- Secrets redaction: covered by provider/keychain and event redaction paths; raw API keys, bearer tokens, cookies, and raw hidden prompts are not user-visible payload.
- Write operations: governed by capability/permission gates, approval grants, schema validation, and side-effect ledger rules.
- Prompt Injection: external/tool content remains untrusted data and cannot change runtime policy, permission grants, schema validation, or reducer semantics.
- Sandbox: Tool Factory rejects unauthorized roots, project source access, timeout, cancellation, and self-registration signals.
- Idempotency: side-effect operation ids and hashes prevent replay/resume from repeating completed writes.
- Runtime reuse: no second runtime, registry, permission stack, ledger, scheduler, or persistence stack was introduced for P8; GUI automation uses the existing composition path with additive DEBUG fixtures only.

## J. KNOWN_LIMITATIONS

- Scheduled model conformance refresh remains follow-up work. The macOS XCUITest runner should still be repaired separately so visual GUI acceptance can run again, but P7 recovery/integration is covered by the accepted App process seed/reload harness above.
- Browser/location/web restaurant vertical is not implemented because the current release tool catalog does not expose those capabilities.
- Result UI actions are validated and routed for current interactions, but broader high-risk action dispatch still needs continued Trust Kernel integration.
- Evidence binding is implemented for plan verification/workflow execution, but not every final user-facing claim is yet linked to an evidence id.

## K. NEXT_REQUIRED_ACTION

Current follow-up after the 2026-07-28 P7 closure: repair the local macOS XCUITest automation-mode service so visual GUI acceptance can execute again in addition to the accepted App process seed/reload harness. Product hardening should continue through the existing registry, router, trust kernel, and event/reducer paths.
