# P5.0 — Agent Runtime Architecture Audit

## 1. 现有架构（审计结论）

DeskPet 是一个 **SwiftPM 包**（`swift-tools-version:6.0`，`platforms: [.macOS(.v14)]`，因此默认 Swift 6 严格并发），Git 根目录为 `/path/to/workspace`。App 入口是 `Sources/DeskPet/main.swift`（`NSApplication` + `AppDelegate`，AppKit，菜单栏 accessory；非 SwiftUI App）。

目标（target）划分：

- `AICore` — 纯能力/安全/AI 协议层（`Capability`、`CapabilityBroker`、`AuditLog`、`ToolProtocol`…）。
- `PetBrainCore` — 认知核心（`EmotionReducer`、`Presentation`、`Seams`、`RuntimeReliability`…），无 SwiftUI/AppKit。
- `PetAgentRuntime` — **DeskPet 自己的原生 Agent Runtime**，依赖 `AICore` + `PetBrainCore`，不依赖任何外部 runtime。
- `DeskPet` — 可执行 App（AppKit/SpriteKit/SwiftUI 视图），依赖以上三者。
- `DeskPetLLM` / `DeskPetToolRunner` — 隔离进程（fault domain）。
- `DeskPetTests` — XCTest，已有 ~210 个测试。

**关键发现：P5.0 规格描述的大部分能力已经存在。** 不能新建第二套系统。

| P5.0 模块 | 现状 | 处理方式 |
| --- | --- | --- |
| AgentRuntime 生命周期 | `PetAgentRuntimeCoordinator`（actor）已是唯一编排核心：`handle`/`run`/`cancel`/`reconcileAfterRestart`，dedup、ledger、注入式 `RuntimeClock`。**缺** 显式 `start/stop/suspend/resume` + 状态枚举 | 新增 `RuntimeLifecycleController` **包裹**该 coordinator，不替换 |
| EventBus | ledger + 每请求 `AsyncStream<PetAgentRuntimeOutput>`。**缺** 通用强类型发布/订阅总线 | 新增 `RuntimeEventBus` |
| ActionDispatcher | `ActionScheduler`（顺序排序 plan step）。**缺** `DeskPetAction` + 优先级队列/超时/打断 | 新增 `ActionDispatcher` |
| PermissionGate | `CapabilityBroker`/`CapabilityGate`/`CapabilityCatalog`（26 能力，默认拒绝，combination risk，tier 上限）。**缺** app-vs-system 区分 | 新增 `CapabilityPermissionGate` **复用** broker |
| ToolRegistry | 仅 `ToolRunnerCapabilities.implemented` 隐式集合。**缺** 正式注册表 | 新增 `ToolRegistry` + 样例工具 |
| BehaviorPolicy | `ProactiveMode`(quiet/companion/active/agentWorking) + `ProactivePolicyEngine`（确定性、已测）。**缺** 模式→策略映射 | 新增 `BehaviorPolicy` **复用** 现有枚举/引擎 |
| StateMachine | `CharacterAnimationStateMachine`(视觉) + `PetStateMachine`(移动)。**缺** 高层行为 FSM | 新增 `CharacterBehaviorStateMachine` |
| PresentationDriver | `PetRenderer`(MainActor，SpriteKit) + `AgentAnimationEventMapper`。**缺** runtime 面向的抽象协议 | 新增 `CharacterPresentationDriver` + adapter 桥接 `PetRenderer` |
| AuditLog | `AICore.AuditLog`（脱敏，append-only） | 新增 `RuntimeAuditLog` **复用** 脱敏 |
| Cancellation/timeout | cancellation 已有；timeout 仅 ToolRunner 硬编码 6s | 新增 `withTimeout` 统一原语 |
| DI（clock/id） | `RuntimeClock` 已有；**缺** id generator | 新增 `IdentifierGenerator` |

## 2. 可复用模块

`ProactiveMode` / `ProactivePolicyEngine` / `ProactiveInputs`、`CapabilityBroker` / `CapabilityCatalog` / `CapabilityGate` / `CapabilityToken`、`AuditLog.redact`、`RuntimeReliability`（`TerminalStateResolver`、`TaskStateReducer`、`EventDeduplicator`…）、`EmotionState` / `EmotionReducer`、`CharacterAnimationStateMachine` / `AgentAnimationEventMapper` / `PetAgentAnimationEvent`、`PetRenderer`、`RuntimeClock` / `WallClock`、`AgentTaskState` 机。

## 3. 冲突风险与规避

- **双 coordinator 风险**：生命周期控制器*拥有*而非重建 coordinator；DI 容器只构造一个。
- **双权限/能力层风险**：同一个 `BrokerCapabilityGate` 实例同时供 coordinator 与新 `PermissionGate` 使用。
- **跨 target 可见性**：`CharacterAnimationIntent` 等是 `DeskPet` 内部类型，`PetAgentRuntime` 无法引用——这正好强制了正确分层：纯协议在 runtime 层用自有枚举，app 层 adapter 负责映射到动画 intent。

## 4. 本轮文件布局

- 纯 contract（`Sources/PetAgentRuntime/`）：`RuntimeLifecycle`、`RuntimeEventBus`、`ActionDispatcher`、`ToolRegistry`、`PermissionModel`、`BehaviorPolicy`、`CharacterBehaviorStateMachine`、`CharacterPresentationDriver`、`RuntimeAuditLog`、`RuntimeTiming`、`RuntimeDiagnostics`。
- App 桥接 + DI（`Sources/DeskPet/`）：`Runtime/AgentRuntimeContainer.swift`、`Render/StaticSpritePresentationDriver.swift`、`AppDelegate.swift`（最小改动）。
- 测试（`Tests/DeskPetTests/`）：`P5*Tests.swift` + `P5Support.swift`。

## 5. 依赖方向

```
App (AppDelegate)
  → AgentRuntimeContainer (DI, @MainActor)
      → RuntimeLifecycleController → PetAgentRuntimeCoordinator (唯一)
      → RuntimeEventBus / ActionDispatcher / PermissionGate / ToolRegistry
      → BehaviorPolicy / CharacterBehaviorStateMachine
      → CharacterPresentationDriver → (StaticSpritePresentationDriver) → PetRenderer
      → RuntimeAuditLog
```

禁止边：`AgentRuntime → SwiftUI/AppKit View`、`AgentRuntime → Live2D SDK`、`AgentRuntime → OpenClaw`、`Tool → 全局单例`、`PresentationDriver → PermissionStore`、`PetRenderer → Runtime`。

## 6. 非目标

不接真实 LLM/OpenClaw/Hermes、不实现真实 shell/file/screen 工具、不申请 macOS 系统权限、不监听麦克风/键盘/剪贴板、不实现完整 Memory DB、不接入正式 Live2D、不重构 UI、不改角色 canonical 素材。

## 7. 安全边界

未访问 `~/.openclaw` 等任何真实 OpenClaw 状态；未调用 OpenClaw CLI；未触碰 `Live 2D项目/live2d_model` 与 `桌宠/assets/concept`；测试只用 `FileManager.default.temporaryDirectory` 与内存实现；未 stage/commit；未执行破坏性 Git 命令。

## 8. P5.1–P5.6 演进路径

- **P5.1**：ConversationOrchestrator、request planning、response streaming UX、tool-call 生命周期、message projection、cancellation UX；`ActionDispatcher` 增加后台 pump loop。
- **P5.2**：真实工具（受限文件读、reminders/calendar，经系统授权）接入 `ToolRegistry` + `PermissionGate` 的 system 层。
- **P5.3**：审批 UI（接通 `askUser` / `waitingForApproval`）。
- **P5.4**：Memory 6 层落地，接 `AgentContextBuilding`。
- **P5.5**：真实 LLM provider 实现 `StructuredDecisionProviding`。
- **P5.6**：Live2D 正式 driver 替换 `NoOpLive2DPresentationDriver`。
