# P5.0 — Agent Runtime Contracts

所有纯 contract 位于 `Sources/PetAgentRuntime/`（Swift 6 严格并发，全部 `Sendable` 正确；错误用强类型 `enum`，核心路径无 `force unwrap`、无 `fatalError`）。

## 模块职责与依赖方向

```
App → AgentRuntimeContainer → RuntimeLifecycleController → PetAgentRuntimeCoordinator(唯一)
                              ├── RuntimeEventBus
                              ├── ActionDispatcher ─(PermissionGate)→ ToolRegistry
                              ├── CapabilityPermissionGate ─composes→ CapabilityGate(broker) + SystemAuthorizationProviding
                              ├── BehaviorPolicy ─uses→ ProactivePolicyEngine
                              ├── CharacterBehaviorStateMachine
                              ├── CharacterPresentationDriver
                              └── RuntimeAuditSink
```

## Runtime lifecycle（`RuntimeLifecycle.swift`）

`AgentRuntimeState = stopped | starting | idle | processing | suspended | stopping | failed(reason)`。`RuntimeLifecycleController`（actor）**拥有**一个 `PetAgentRuntimeCoordinator`：

- `start()` 幂等——重复 start 不重复初始化（`startCountForTesting` 验证）；start 时调用 `reconcileAfterRestart`。
- `stop()` 幂等——取消并 `await` 所有受管 `Task`，无 orphan。
- `suspend()/resume()`；`submit(_:onOutput:)` 仅在 idle/processing 接受，否则抛 `RuntimeLifecycleError.notRunning`。
- `activeRequestCount()` 跟踪在途请求；`runForResult(_:)` 为非流式便捷入口（同一 coordinator）。

## Event model（`RuntimeEventBus.swift`）

强类型 `RuntimeEvent`（runtimeStarted/Stopped/Suspended/Resumed、request*、permission*、action*、behaviorStateChanged、presentationCommandIssued、tool*、auditWarning）。`RuntimeEventEnvelope` 携带 `correlationID` + **注入时钟**时间戳。`RuntimeEventBus`（actor）：`subscribe()` 返回 `(id, AsyncStream)`，`unsubscribe`，多订阅者 fan-out，流终止时自动清理（无 retain cycle）。事件只含 metadata，绝不含原始用户输入。

## Action model（`ActionDispatcher.swift`）

`DeskPetAction = speak | setExpression | playMotion | showNotification | requestPermission | invokeTool | wait | updatePresence`。`ActionPriority = ambient < proactiveCompanion < assistantResponse < userInitiated < userCritical`。`ActionEnvelope` 带 id/source/priority/correlationID/createdAt/timeout。`ActionDispatcher`（actor）：

- 优先级排序；同类表现动作合并（队列不膨胀）。
- 高优先级（userInitiated+）入队即打断挂起的 ambient/proactive。
- `requestPermission` 在执行前必过 `PermissionGate`；`invokeTool` 在 `ToolRegistry` 内过 gate——**敏感 Action 不经 PermissionGate 不执行**。
- `cancel(id)` 标记取消：drain 时报 `.cancelled`，绝不报 `.completed`。
- 超时经 `withTimeout` → `.timedOut`（与 failure/cancel 区分）。
- 本轮显式 drain（`runNext`/`runAll`），后台 pump loop 留待 P5.1。

## Permission model（`PermissionModel.swift`）

区分 **app 策略**与 **macOS 系统授权**（doc §6.4）：

- `CapabilityPermissionState`（unknown/notRequested/denied/grantedOnce/grantedForSession/grantedPersistently/restricted/unavailable）。
- `SystemAuthorizationStatus`（notRequired/notDetermined/granted/denied/restricted/unavailable）。
- `EffectivePermission.isExecutable = applicationPolicyGranted && (!systemAuthorizationRequired || systemAuthorizationStatus == .granted)`——**app 内 granted 不会被当作系统已授权**。
- `PermissionGate` 协议；`CapabilityPermissionGate` 组合现有 `CapabilityGate`(broker) 与 `SystemAuthorizationProviding`，并审计每次决策。
- 默认拒绝高敏感（screen/microphone/keyboardMonitoring 等系统门控；P1+ broker → askUser → 不执行）。
- `InMemorySystemAuthorizationStore` / `InMemoryPermissionStore` 仅供测试，绝不查询真实 macOS 状态。

## Tool model（`ToolRegistry.swift`）

`RuntimeTool`：identifier/displayName/toolDescription/requiredCapabilities/riskLevel(`safe|sensitive|highRisk`)/timeout/`execute(arguments:context:)`。`ToolContext` 只暴露最小依赖（correlationID、clock、diagnostics 闭包）——**无全局单例**。`ToolRegistry`（actor）：`register`（重复 id 抛 `duplicateIdentifier`）、`invoke`（未注册→`notFound`；能力不满足→经 gate→`capabilityNotPermitted`；超时→`timedOut`；取消→`cancelled`）。样例工具：`EchoTool`(safe, 无能力)、`CurrentRuntimeStatusTool`(safe, 需 `state.read`)——均无副作用。

## Behavior modes（`BehaviorPolicy.swift`）

复用现有 `ProactiveMode`，命名映射 quiet→quiet、companion→companion（**默认**）、active→assistant、agentWorking→agent。`BehaviorPolicy.decide(environment:)` → `BehaviorModeDecision`（allowProactive、cooldown、maxConsecutiveProactive、allowInterruptUser、allowSensitiveCapability、degraded）。全屏/会议/勿扰抑制主动；低电量/高负载降级。`gateProactive(...)` 折叠环境后交给现有 `ProactivePolicyEngine`。**agent 模式也不能绕过 PermissionGate**——`allowSensitiveCapability` 只表达意愿，授权权威仍是 gate。

## State machine（`CharacterBehaviorStateMachine.swift`）

`dormant | idle | observing | listening | thinking | speaking | acting | waitingForPermission | interrupted | errorRecovery | sleeping`。显式 `from→event→to`；非法转换抛 `BehaviorTransitionError.invalid` 并由容器审计为 `invalidTransition`。覆盖 speaking、permission、interrupt、errorRecovery 路径。`sleeping.suppressesAmbient == true`，且不可自动进入 `acting`，仅 wake/userMessage 唤醒。每状态有语义 `BehaviorPresentationCommand`（expression+motion+speaking）。

## Presentation abstraction（`CharacterPresentationDriver.swift`）

runtime 只依赖此协议（`setExpression/playMotion/setSpeaking/setAttentionTarget/updateEmotion/resetToIdle/setReduceMotion`，全部非抛 async，表现失败不会崩 runtime）。枚举 `CharacterExpression`(7)、`CharacterMotion`(10)、`AttentionTarget`。实现：`RecordingPresentationDriver`(测试)、`NoOpLive2DPresentationDriver`(**明确 Stub**，不读 live2d_model)、app 侧 `StaticSpritePresentationDriver`（驱动现有 `PetRenderer`，单向）。

## Audit privacy（`RuntimeAuditLog.swift`）

`RuntimeAuditEvent` 只记 metadata（kind、capabilityID、redacted summary、注入时间戳），默认不记完整对话/token/凭据/文件内容。`RuntimeAuditRedactor.redact` 复用 `AICore.AuditLog.redact`。`RuntimeAuditSink` 协议 + `InMemoryAuditSink`。

## Cancellation / timeout（`RuntimeTiming.swift`）

`withTimeout(seconds:operation:)`：超时抛 `RuntimeTimeoutError`，调用方取消抛 `CancellationError`——三者（timeout/cancel/failure）**互不混淆**。`IdentifierGenerator`（`UUIDIdentifierGenerator` / 确定性 `DeterministicIdentifierGenerator`）、`TestClock`(`RuntimeClock`)。

## 后续接入

- LLM：实现 `StructuredDecisionProviding`（替换 `ReasoningModelAdapter`）。
- Memory：实现 `AgentContextBuilding` / `PetBrainRepository`。
- Live2D：实现 `CharacterPresentationDriver` 替换 `NoOpLive2DPresentationDriver`。
- 真实工具：实现 `RuntimeTool` 并声明 `requiredCapabilities`，由 `PermissionGate` 的 system 层把关。

## 非目标

见 AUDIT §6。
