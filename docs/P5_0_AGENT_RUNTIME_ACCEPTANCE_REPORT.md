# P5.0 — Agent Runtime Acceptance Report

## A. FINAL_STATUS

**READY**

构建成功；全部 223 个测试通过（3 次连续运行稳定，0 失败）；其中 60 个为本轮新增 P5.0 测试（另有 2 个 `P5SeamTests` 为既有）。Runtime 生命周期、EventBus、PermissionGate 默认安全、ToolRegistry、Action cancellation/timeout、BehaviorPolicy 默认 companion、StateMachine 转换、PresentationDriver 均可运行；Live2D 仅为明确 Stub；未依赖 OpenClaw/Hermes；未触碰 Live2D/concept 素材；未 stage/commit；`git diff --check` 通过。

## B. Safety Boundary Result

- 是否访问 `~/.openclaw` / `~/.config/openclaw` / Application Support 等：**否**。
- 是否调用 OpenClaw CLI：**否**。
- 是否修改 credentials / sessions / tokens：**否**。
- 是否执行 reset/clean/restore/checkout/stash/rebase/merge：**否**。
- 是否 stage / commit / 切分支：**否**。
- 是否触碰 `Live 2D项目/live2d_model` 或 `桌宠/assets/concept`：**否**（git status 对两路径均无输出）。
- 测试隔离：仅 `FileManager.default.temporaryDirectory` 与内存实现；无网络；无真实高风险工具；未申请任何 macOS 系统权限。

## C. Repository Audit

- Git root：`/path/to/workspace`。
- 项目类型：SwiftPM 包，`swift-tools-version:6.0`（Swift 6 严格并发），macOS 14。
- App 架构：`main.swift` + `AppDelegate`（AppKit/SpriteKit；菜单栏 accessory，非 SwiftUI App）。
- 测试架构：单一 `DeskPetTests`（XCTest）。
- 本轮目录结构：纯 contract 入 `Sources/PetAgentRuntime/`；DI + 桥接入 `Sources/DeskPet/`；测试入 `Tests/DeskPetTests/`；文档入 `docs/`。
- 复用现有模块：是（见 D / AUDIT §2）。

## D. Root Architecture Findings

仓库已存在真实可用的原生 Agent Runtime（`PetAgentRuntimeCoordinator` + `CapabilityBroker`/`CapabilityGate` + `RuntimeReliability` + `ProactivePolicyEngine` + agent-aware 动画状态机 + `PetRenderer`）。因此本轮**收敛+补缺**，只补正式缺失的 contract，并以薄层包裹/组合既有实现，杜绝第二套系统：生命周期控制器*拥有*唯一 coordinator；新 PermissionGate *组合*同一个 broker gate；BehaviorPolicy *复用* `ProactiveMode`/引擎；PresentationDriver 经 adapter *驱动* 既有 `PetRenderer`。

## E. Implemented Runtime Contracts

- **AgentRuntime**：`RuntimeLifecycleController`（拥有 coordinator）+ `AgentRuntimeState`；start 幂等、stop 幂等且无 orphan Task、suspend/resume、submit 状态门控、activeRequestCount。
- **EventBus**：`RuntimeEventBus`（actor）+ 强类型 `RuntimeEvent`/`RuntimeEventEnvelope`；订阅/退订、correlationID、注入时间戳、metadata-only。
- **ActionDispatcher**：`DeskPetAction` + `ActionPriority` + `ActionEnvelope`；优先级排序、同类合并、用户操作打断 ambient、敏感动作过 gate、cancel→cancelled、timeout→timedOut。
- **PermissionGate**：`CapabilityPermissionGate` 组合 broker 与系统授权；`EffectivePermission` 区分 app-policy / system-auth；默认拒绝高敏感；`InMemoryPermissionStore`/`InMemorySystemAuthorizationStore`。
- **ToolRegistry**：`RuntimeTool` + `ToolRiskLevel` + `ToolRegistry`（重复/未注册/能力不足/超时/取消）；样例 `EchoTool`、`CurrentRuntimeStatusTool`。
- **BehaviorPolicy**：复用 `ProactiveMode`（默认 companion）；环境抑制/降级；`gateProactive` 接 `ProactivePolicyEngine`；agent 模式不绕过 gate。
- **StateMachine**：`CharacterBehaviorStateMachine`（11 态）显式转换、非法转换抛错并审计、sleeping 抑制 ambient 且不自动 acting。
- **PresentationDriver**：`CharacterPresentationDriver` 协议 + `RecordingPresentationDriver` + `NoOpLive2DPresentationDriver`(Stub) + app 侧 `StaticSpritePresentationDriver`（驱动 `PetRenderer`）。
- **AuditLog**：`RuntimeAuditSink` + `InMemoryAuditSink` + `RuntimeAuditRedactor`（复用 AICore 脱敏）。
- **Cancellation/timeout**：`withTimeout`（timeout/cancel/failure 三者区分）、`IdentifierGenerator`、`TestClock`。

## F. Files Changed

新增（`Sources/PetAgentRuntime/`）：`RuntimeLifecycle.swift`、`RuntimeEventBus.swift`、`ActionDispatcher.swift`、`ToolRegistry.swift`、`PermissionModel.swift`、`BehaviorPolicy.swift`、`CharacterBehaviorStateMachine.swift`、`CharacterPresentationDriver.swift`、`RuntimeAuditLog.swift`、`RuntimeTiming.swift`、`RuntimeDiagnostics.swift`。

新增（`Sources/DeskPet/`）：`Runtime/AgentRuntimeContainer.swift`（单一 DI 容器 + `PresentationActionExecutor`）、`Render/StaticSpritePresentationDriver.swift`（桥接 PetRenderer）。

修改（`Sources/DeskPet/`）：`AppDelegate.swift`——以容器构造唯一 coordinator、`bootstrap()`、`applicationWillTerminate` → `shutdown()`、新增 `DESKPET_RUNTIME_SELFTEST` 调试钩子。

新增（`Tests/DeskPetTests/`）：`P5Support.swift`、`P5RuntimeLifecycleTests.swift`、`P5EventBusActionTests.swift`、`P5ToolPermissionTests.swift`、`P5BehaviorPresentationTests.swift`、`P5AuditSafetyContainerTests.swift`。

新增（`docs/`）：本三份文档。

## G. Security and Privacy Guarantees

- 默认拒绝高敏感能力：screenRead、microphone、keyboardMonitoring、camera、clipboard 持续读、accessibility、contacts 等（system-gated + broker P1+ → 不执行）。
- 应用权限与系统权限分离：`EffectivePermission.isExecutable` 要求 app 策略授予**且**所需系统授权已 granted；app 内 granted 不会被当作系统授权。
- 日志脱敏：`RuntimeAuditEvent` 仅 metadata；`redact` 屏蔽 password/token/key/secret 及长随机串；不记录完整对话/凭据/文件内容。
- 测试隔离：仅临时目录/内存；无网络；未执行真实高风险工具。
- 无 OpenClaw 依赖证明：`PetAgentRuntime` 仅依赖 `AICore`/`PetBrainCore`（见 `Package.swift`）；可在未安装 OpenClaw/Hermes 的机器编译运行；全仓无 OpenClaw import/CLI 调用。

## H. Test Results

- 命令：`swift test`（连续 3 次）。
- 总数：223；passed：223；failed：0；skipped：0。
- 新增 P5.0：60 个用例（11 个新套件）—— RuntimeLifecycle(7)、EventBus(4)、ActionDispatcher(6)、ToolRegistry(6)、PermissionModel(7)、BehaviorPolicy(5)、BehaviorStateMachine(6)、PresentationDriver(5)、AuditLog(4)、SafetyBoundary(3)、ContainerIntegration(7)。
- 关键覆盖：start→idle / 重复 start 不重复初始化 / stop 幂等 / stopped 后拒绝 submit / 无 orphan Task；订阅-退订-correlationID；高敏感默认拒绝 / grantedOnce 一次 / grantedForSession / app-vs-system 分离 / agent 不绕过 gate；注册-重复-未注册-能力不足-超时-取消；优先级-打断-取消不报完成-超时；companion 默认 / quiet 抑制 / sleeping 抑制 ambient；speaking/permission/interrupt/errorRecovery/非法转换；driver thinking/speaking/reset/stub 不崩；脱敏 / deny 记录 / timeout 记录 / cancel 不误记为 failure；容器单 coordinator / 幂等 bootstrap / action 抵达 driver / shutdown 无 orphan / diagnostics 一致。

## I. Build Results

- 命令：`swift build`、`swift build --build-tests`、`swift test`。
- target/scheme：SwiftPM `DeskPet` 包（targets：AICore、PetBrainCore、PetAgentRuntime、DeskPet、DeskPetLLM、DeskPetToolRunner、DeskPetTests）。
- Debug 结果：`Build complete!`。
- 重要 warning：仅 `M6RelationshipTests.swift` 既有 `var s` 未变更 warning（与本轮无关）；新增代码 0 warning。
- `git diff --check`：通过（exit 0）。

## J. Runtime Integration

- 注入：`AgentRuntimeContainer`（`@MainActor`，唯一 DI 容器）在 `applicationDidFinishLaunching` 构造唯一 `PetAgentRuntimeCoordinator` 并 `bootstrap()`（注册样例工具一次 + 启动 runtime 一次）；`applicationWillTerminate` → `shutdown()`（取消并 await 受管 Task）。
- 静态角色表现：`StaticSpritePresentationDriver`（`@MainActor`）实现 `CharacterPresentationDriver`，经既有 `overlay.reactPet/handleAgentAnimationEvent` 驱动现有 `PetRenderer`；单向 `Runtime → Driver → PetRenderer`，overlay 不反向持有 runtime。
- Debug diagnostics：纯代码 `RuntimeDiagnosticsSnapshot`（runtimeState/behaviorMode/behaviorState/activeRequestCount/registeredToolCount/lastAuditSummary，无敏感内容）；`DESKPET_RUNTIME_SELFTEST` 钩子打印 snapshot 并验证 bootstrap→shutdown。
- Release：未暴露任何高风险测试操作；自检钩子仅在显式环境变量下触发。
- **本轮不加 UI 的原因**：当前 App 为 `main.swift + AppKit`，临时引入 SwiftUI diagnostics 视图会扩大生命周期与 UI 风险且非 P5.0 重点。真实集成已通过 DI 容器、renderer adapter、bootstrap/shutdown 与集成测试达成（`P5ContainerIntegrationTests` 验证单一 coordinator、幂等 bootstrap、action 抵达 driver、shutdown 无 orphan、diagnostics 一致、敏感动作仍由 gate 把关）。diagnostics 数据模型已就绪；后续若需界面，优先复用现有 AppKit 菜单/面板或经评估后用 `NSHostingView`。

## K. Known Limitations

- 未接真实 LLM（`ReasoningModelAdapter` 仍为规则回退）。
- 未接真实 Memory（`AppAgentContextBuilder` 仅提供 memory hints）。
- 未申请任何 macOS 系统权限；系统授权状态为 `notDetermined`（seam 预留）。
- Live2D 仍为 `NoOpLive2DPresentationDriver` Stub。
- 未实现真实工具（仅 `EchoTool`/`CurrentRuntimeStatusTool` 无副作用样例）。
- `ActionDispatcher` 为显式 drain；后台 pump loop 留待 P5.1。
- 未在真实 GUI 进程中跑 `DESKPET_RUNTIME_SELFTEST`（会打开 overlay 窗口）；等价路径已由集成测试覆盖。

## L. Git Evidence

修改前工作区：仓库已有大量与本轮无关的未跟踪改动（`.ralph/`、`ComfyUI/`、`docs/LTX_*`、`workflows/` 等 LTX 相关产物）——本轮**未触碰**这些。

修改后（`git status --short --untracked-files=all -- "桌宠/DeskPet"`）：1 个修改（`AppDelegate.swift`）+ 13 个新增源/测试文件 + 3 份新文档，全部位于 `桌宠/DeskPet`。

`git status --short -- "Live 2D项目/live2d_model"`：无输出（未变化）。
`git status --short -- "桌宠/assets/concept"`：无输出（未变化）。
`git diff --cached --name-only -- ...`：无输出（未 stage）。
`git diff --check`：exit 0。

## M. Next Recommended Phase

**P5.1** 聚焦：ConversationOrchestrator、request planning、response streaming UX、tool-call 生命周期、message projection、cancellation UX；并为 `ActionDispatcher` 增加后台 pump loop（小心保持 gate→token→execute 顺序与取消语义）。

## N. Honest Final Assessment

状态为 **READY**：所有验收门槛均满足——成功构建、核心自动化测试通过且稳定、Runtime 生命周期/EventBus/PermissionGate 默认安全/ToolRegistry/Action cancellation+timeout/BehaviorPolicy 默认 companion/StateMachine 转换/PresentationDriver 均有实测、Live2D 仅 Stub、无 OpenClaw/Hermes 依赖、未触碰 Live2D/concept 素材、未 stage/commit、`git diff --check` 通过、文档与代码一致、改动全在允许范围。诚实保留项见 K：本轮是 contract 收敛与可测试集成，不包含真实 LLM/Memory/Live2D/工具与系统权限——这些是有意的非目标，已在文档与 Stub 命名中明确标注，未将 Stub 冒充为完成功能。
