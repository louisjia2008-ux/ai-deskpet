# Agent OS Architecture P0

本文档是 P0 架构审计结论。它描述当前 DeskPet Agent OS 的真实运行路径、可复用组件、需要收敛的冲突源，以及 P1-P8 的目标数据流。

## P0 结论

当前系统已经具备一个可演进的单运行时骨架：

- `Sources/DeskPet/Runtime/AgentRuntimeContainer.swift` 是 app 级依赖注入容器。
- `Sources/PetAgentRuntime/PetAgentRuntimeCoordinator.swift` 是用户消息进入 Agent Runtime 的单一顶层入口。
- `Sources/PetAgentRuntime/AgentLoopController.swift` 是当前受限多步 tool loop。
- `Sources/PetAgentRuntime/ToolRegistry.swift` 是当前权威工具目录和执行边界。
- `Sources/PetAgentRuntime/AgentEventModels.swift`、`Sources/PetAgentRuntime/AgentRunEventStore.swift`、`Sources/DeskPet/AI/AgentTaskActivityStore.swift` 已经构成事件、持久化、Task Center 投影基础。
- `Sources/AICore/Capability.swift`、`Sources/AICore/CapabilityBroker.swift`、`Sources/PetAgentRuntime/PermissionModel.swift`、`Sources/PetAgentRuntime/ToolApprovalGrants.swift` 已经构成权限和一次性 grant 的核心。
- `Sources/AICore/Memory.swift`、`Sources/DeskPet/Memory/MemoryModel.swift`、`Sources/DeskPet/Memory/MemoryStore.swift` 已经构成确定性 Memory V2 边界。
- `Sources/PetAgentRuntime/AgentResultDocument.swift` 和 `Sources/DeskPet/UI/AgentResultView.swift` 已经构成 Native Generative UI 的第一版安全模型。

因此后续阶段必须扩展这些组件，不能新建第二套运行时、第二套事件总线、第二套任务中心状态、第二套工具注册表、第二套 Provider Router、第二套 Memory 存储或第二套 Generative UI renderer。

## P1 进展

P1 已按复用路线新增 canonical event/state projection，而不是替换现有运行时：

- `AgentStreamEvent` 是 `AgentEventEnvelope` 和 `AgentTaskActivityEvent` 之上的 additive protocol adapter。
- `AgentTaskProjectionReducer` 是 canonical run/task state reducer。
- `AgentTaskActivityStore` 同时暴露 legacy `tasks` 和 canonical `canonicalTasks`，为 Chat/Floating Chat/Task Center 共用同一投影做过渡。
- ChatModel/provider 单元测试已改为注入 in-memory activity store，避免测试加载用户真实 Application Support 活动历史；生产路径仍使用 app 配置的持久化 activity store。

## P2 进展

P2 已沿现有 provider/runtime 路径标准化流式协议：

- `ProviderDelta` now carries visible text, hidden reasoning, streamed tool-call fragments, metadata, usage, finish reason, error, and cancellation acknowledgement.
- `ProviderClientFactory` now implements true OpenAI-compatible SSE streaming and Ollama NDJSON streaming instead of slicing full responses.
- MiniMax M3 uses `thinking.type=disabled` and `reasoning_split=true`; split `<think>` and provider reasoning fields are isolated before user-visible text.
- `ProviderToolCallStreamAccumulator` is wired into `LLMProviderAgentLoopDecisionProvider`, so streamed native tool calls are completed, catalog-validated, and then routed into the existing tool governance path.
- `ChatModel` uses `ChatResponseDeltaCoalescer` for buffered UI flush, monotonic sequence protection, final flush, and cancellation barriers.
- Live streaming probes exist for local Ollama and cloud MiniMax and are intentionally opt-in through `DESKPET_LIVE_PROVIDER_PROBE=1`.

## P3 进展

P3 added deterministic tool-result verification events to the same runtime and activity path. The current datetime vertical now validates the real tool observation before final synthesis can count as successful. Verification failures are failure evidence, while the subsequent `taskFailed` event remains the single terminal replay anchor.

## P4 进展

P4 added the multi-role governor without creating a second runtime:

- `DefaultTaskGovernor` classifies plan risk and required roles from the validated plan and tool catalog.
- `DeterministicPlanCritic` blocks plan execution when hard constraints, required tools, write confirmation, or step budgets are violated.
- `DeterministicPlanVerifier` checks final claims against `AgentEvidenceRecord` inputs and can repair one overclaimed response into an evidence-honest partial terminal state.
- `AgentLoopController` runs the governor, critic, executor, synthesizer, and verifier inside the existing `proposePlan` branch.
- Plan verification is projected through the existing task activity and canonical event infrastructure.

## P5 进展

P5 extended the native Generative UI lane:

- `AgentResultDocument` now includes revisions, component state, accessibility metadata, and the missing schema components required by P5.
- `AgentResultPatch` and `AgentResultPatchReducer` implement base-revision patching with stale patch rejection and nonblank safeguards.
- `AgentResultInteractionEvent` captures task/run/document/component/action/payload/timestamp and maps to canonical UI interaction events.
- `AgentResultView` renders the extended schema natively and emits choice interactions without executing tools in SwiftUI.
- `TaskCenterView` forwards result interactions to `CompanionAgentRuntimeModel`, which records the interaction and applies a resolved/collapsed patch for deterministic replay.

## P6 进展

P6 added the Capability Kernel and Tool Factory lifecycle without creating a second reusable registry:

- `CapabilityDescriptor` normalizes capability/tool metadata from the existing `CapabilityCatalog`, `ToolManifest`, and `ToolCatalogSnapshot`.
- `CapabilityKernel` builds capability/tool/workflow graphs, detects gaps, classifies unavailable capabilities, and detects duplicate tool ids.
- `DynamicWorkflowComposer` and `DynamicWorkflowExecutor` compose existing tools from a snapshot and execute them through schema validation, `PermissionGate`, `ToolPlatformExecuting`, output validation, and evidence records.
- `ToolFactory` tracks task-scoped ephemeral proposals through static validation, sandbox testing, current-task execution, result verification, reusable-candidate review, explicit promotion, and rollback.
- `RestrictedEphemeralToolRunner` supports only safe structured data transforms in P6: sort/deduplicate numbers, sort/deduplicate strings, and sum numbers.
- Ephemeral execution defaults to deny unless a real `PermissionGate` is injected, rejects unauthorized paths, honors cancellation and timeout, verifies output schema, and never auto-registers a successful one-off tool.

## P7 进展

P7 added deterministic recovery and model conformance controls on top of the same event store and projection path:

- `AgentCheckpointBuilder` rebuilds a task/run from `AgentEventEnvelope` history, deduplicates duplicate event ids, restores the canonical projection, restores `AgentResultDocument`, and creates an `AgentTimelineReplayState`.
- `AgentRecoveryPlanner` classifies safe recovery as replay only, resume tool, resume model synthesis, retry provider stream, or require user review.
- `AgentSideEffectLedger` records operation ids and privacy-safe hashes so completed write side effects are not executed again after restart, cancellation, duplicate event delivery, or provider interruption.
- `ModelConformanceProfile` and `ModelConformanceGate` restrict model roles, true streaming, native tool calling, request flags, and max tool calls before a provider is used for a role.
- Provider-stream interruption recovery is gated by conformance: only a true-streaming profile may retry the stream; otherwise runtime resumes from recorded evidence.

## P8 进展

P8 added an explicit end-to-end acceptance layer over the existing runtime and replay primitives:

- `AgentEventEnvelope.parentEventID` is now an additive field for representing parent/child relationships such as grouped parallel read-only tools.
- `AgentStreamEvent` preserves `parentEventID` when projecting from and back to envelopes, so replay keeps the same tool hierarchy.
- `P8EndToEndAcceptanceTests` covers the 12 required flows as clearly separated runtime/fixture acceptance: ordinary streaming cancellation, datetime success/failure replay, verifier rejection and repair, allow-once/deny permissions, dynamic choice UI patching, cancellation barriers, Tool Factory ephemeral lifecycle, restart/replay idempotency, parallel read-only parentage, and old-task isolation.
- `P8EndToEndAcceptanceTests` also covers test-unique automation data roots under `FileManager.default.temporaryDirectory` and rejects unsafe fixed roots such as `/tmp/DeskPetAutomation`.
- Real macOS XCUITest execution remains a separate GUI evidence requirement; in the current environment the runner exits before producing a result bundle, so GUI flows must not be marked as passed from the fixture tests alone.

## 当前数据流

```text
CompanionChatView / Floating Chat
 -> ChatModel.send
 -> PetAgentEvent.userMessage
 -> PetAgentRuntimeCoordinator.handle
 -> AppAgentContextBuilder
 -> DecisionEngine.decideStructured
 -> RuntimeRequestPreparer
 -> either converse() or runBoundedToolLoop()
 -> LegacyConversationProvider / AgentLoopController
 -> TaskGovernor / PlanCritic / PlanVerifier for explicit plans
 -> CapabilityKernel / DynamicWorkflowComposer for composed capabilities
 -> ToolRegistry + PermissionGate + SystemAuthorizationProviding
 -> ToolFactory for task-scoped ephemeral transforms only after sandbox + verifier
 -> AgentCheckpointBuilder / AgentRecoveryPlanner for replay and deterministic resume
 -> AgentSideEffectLedger / ModelConformanceGate for idempotency and provider-role limits
 -> AgentEventEnvelope.parentEventID for grouped parallel tool relationships
 -> PetAgentRuntimeOutput
 -> ChatModel.apply
 -> AgentTaskActivityStore.publish
 -> AgentEventHub / AgentRunEventStore
 -> TaskActivityCard / TaskCenterView / AgentResultView
```

## 目标数据流

```text
User / Scheduler / System Trigger
 -> Agent Control Plane
 -> PetAgentRuntimeCoordinator
 -> AgentStreamEvent emitter
 -> Agent Task State Machine reducer
 -> ProviderDelta adapter / Tool Activity adapter / UI Artifact adapter
 -> AgentEventHub + AgentRunEventStore
 -> Chat reducer + Floating reducer + Task Center reducer
 -> Deterministic Trust Kernel for every side effect
 -> ToolRegistry / ToolFactory / ActionDispatcher
 -> Native Generative UI snapshot and patch renderer
```

目标不是替换当前运行时，而是把当前 `PetAgentRuntimeOutput`、`AgentTaskActivityEvent`、`AgentEventEnvelope`、`AgentTaskState`、`AgentTaskStatus`、`AgentLoopState` 和 `AgentTaskSchedulerStatus` 收敛成一条可重放、可恢复、可审计的事件与状态协议。

## 可复用源

- Runtime: `AgentRuntimeContainer`、`PetAgentRuntimeCoordinator`、`AgentLoopController`、`RuntimeRequestPreparer`。
- Tool: `ToolRegistry`、`ToolPlatformModels`、`ToolSchemaValidator`、`ToolCatalogSnapshot`、`ToolApprovalGrantStore`。
- Permission: `CapabilityBroker`、`BrokerCapabilityGate`、`CapabilityPermissionGate`、`DefaultSystemAuthorizationPolicy`。
- Activity: `AgentEventHub`、`AgentRunEventStore`、`AgentTaskActivityStore`、`AgentActivityReducer`、`AgentTimelineReplay`。
- Provider: `ProviderStore`、`ModelRouter`、`ProviderClientFactory`、`ProviderAgentLoopAdapters`、`ProviderToolCapabilityPolicy`。
- Recovery: `AgentCheckpointBuilder`、`AgentRecoveryPlanner`、`AgentSideEffectLedger`、`ModelConformanceProfile`、`ModelConformanceGate`。
- UI: `ChatModel`、`CompanionChatView`、`ChatExpandedView`、`TaskActivityCard`、`TaskCenterView`、`AgentResultView`。
- Memory: `MemoryModel`、`MemoryStore`、`MemoryPolicyEngine`、`TaskReflector`。
- Scheduler: `AgentTaskScheduler` and app `TaskScheduler` as trigger/queue layers, not as success authority.

## Refactor 源

- `PetAgentRuntimeOutput` is a UI subscription contract, not the final `AgentStreamEvent` protocol.
- `AgentTaskActivityEvent` and `AgentEventEnvelope` overlap. P1 should keep the hub and introduce canonical event wrappers instead of publishing both independently.
- `RuntimeEventBus` is useful for low-level runtime lifecycle/tool audit events but currently separate from `AgentEventHub`.
- `ChatModel.apply` mutates visible message text on every delta; P2 needs a stream coalescer.
- `AgentTaskActivityReducer` special-cases current-date-time activity; P3 should move tool display data into tool event payloads.
- `AgentTimelineStore` under Floating Chat still has local preview state. It is a transitional UI store and should not become task truth.
- `LegacyConversationProvider` honestly reports non-streaming and should stay a bottom provider adapter until real provider streaming is implemented.
- `ProviderToolCallStreamAccumulator` exists but is not connected to real streaming transport.
- `AgentResultAction` validates tool-bound actions but UI action dispatch is deferred.

## 冲突源

- State duplication: `AgentTaskState`、`AgentTaskStatus`、`AgentLoopState`、`AgentTaskSchedulerStatus` all describe task progress.
- Event duplication: `RuntimeEventBus` and `AgentEventHub` both carry runtime-like events.
- Provider mismatch: lower-level clients use `sendChat` for tool decisions; `streamChat` is stubbed or full-response wrapped for OpenAI-compatible and Ollama clients.
- Activity authority risk: some user-visible activity text is still derived from presentation heuristics rather than a complete canonical event set.
- Generative UI action gap: result buttons surface intent but do not yet pass through ActionDispatcher and Trust Kernel.
- Tool Factory gap: there is no lifecycle for generated workflows, ephemeral scripts, sandbox validation, or promotion.

## Backward Compatibility

Existing chat, API key storage, provider configuration, local/cloud provider routing, date/time tool, Task Center replay, scheduled tasks, Memory V2, pet animation and window behavior must keep working. Old persisted activity rows without Agent OS P1 fields must replay through the existing projection. New fields must be additive and schema-versioned.

## Phase Gates

- P0: architecture docs and baseline gates only.
- P1: canonical event/state machine and shared reducer.
- P2: ProviderDelta streaming protocol, thinking separation, tool argument accumulation, cancellation, coalescing.
- P3: tool activity protocol and deterministic activity replay.
- P4: multi-agent governance with verifier and side-effect control.
- P5: native generative UI snapshot/patch and safe interactions.
- P6: capability kernel and tool factory lifecycle.
- P7: recovery, replay, conformance, and prompt-injection hardening.
- P8: end-to-end runtime/fixture acceptance plus real GUI flow acceptance when XCUITest can launch.
