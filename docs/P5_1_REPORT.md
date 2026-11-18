# P5.1 — Pet-Centered Visual System & Interaction Polish · Report

## A. FINAL_STATUS

**READY_FOR_HUMAN_VISUAL_REVIEW**（视觉风格需用户主观确认；自动化部分已完成并通过）

- 代码完成、构建通过、254/254 测试通过（含 25 个 P5.1 新测试）、App 实际启动运行无崩溃。
- 视觉截图证据因环境限制标记 **HUMAN_REVIEW_REQUIRED**（见 K 与 `docs/p5_1_visual_evidence/README.md`）。

## B. Safety Boundary Evidence

- 未访问 `~/.openclaw` / 任何 OpenClaw 状态；未运行 OpenClaw CLI。
- 未触碰 credentials / sessions / tokens；未申请任何系统权限；未触发权限弹窗。
- 未执行 reset/clean/checkout/restore/stash/rebase/merge/commit/add；未 stage、未 commit、未切分支。
- 未修改 `Live 2D项目/live2d_model`、`桌宠/assets/concept`（git status 对两路径无输出）。
- 测试数据：仅 `FileManager.default.temporaryDirectory` 与内存（tasks/memory/relationship 临时 store）。
- 进程：只启动/结束本会话自己的 DeskPet（PID 记录于运行日志）。

## C. Repository Audit

- pwd `/path/to/DeskPet`；Git root `/path/to/workspace`；branch `main`；无嵌套 .git。
- 构建入口：SwiftPM（`swift build`）+ `scripts/run.sh`/`build_app.sh`。测试入口：`swift test`（DeskPetTests）。
- UI 根视图：`RootView`(`MainViews.swift`) → `AppShellView`。
- 窗口管理：`MainWindowController`（单一 `NSWindow`，懒创建、复用，切页/重开不重建 Runtime）。
- Runtime Coordinator 所有权：`AgentRuntimeContainer`（P5.0，唯一）；本轮未改其所有权。
- PetRenderer 入口：`OverlayWindowController`；animation FSM 入口：`overlay.handleAgentAnimationEvent`。
- 开始前工作区：含 P5.0 未提交改动 + 无关的 LTX/ralph 产物（均未触碰）。

## D. Root Cause Summary

原 UI 简陋的真实根因：①无 Design System（颜色/字体/间距/圆角/动效散落，全靠默认控件）；②默认
`TabView` + `Form` + `List` 视觉占主导，像系统设置页；③页面职责与导航层级不清，低频「数据」占一级
导航；④空状态缺失（输入框 + 空列表 = 大片空白）；⑤桌宠与主窗口零事件联动；⑥窗口无形态管理；
⑦视觉状态无 accessibility fallback（仅靠颜色、无 Reduce Transparency/Motion 退化）。

## E. Implemented Visual System

`Sources/DeskPet/DesignSystem/`：
- `DesignColors.swift` — `DSColorToken`(14 语义色)、纯函数 `DSPalette.rgba/resolved`（Light/Dark/Increase
  Contrast/Reduce Transparency 全部可测）、`DSColor` 动态色。冷蓝/淡青/柔白 + 暖粉强调；Dark 非纯黑。
- `DesignTokens.swift` — `DSSpacing`(4–32)、`DSRadius`、`DSFont`(pageTitle…numericDisplay)、`DSMotion`
  (quick/standard/emphasized/content/completion + Reduce Motion 退化)、`WindowMode`(mini/compact/expanded)。
- `DesignComponents.swift` — `CardContainer`、`AppGlassContainer`(Reduce Transparency 退化近实色)、
  `SectionHeader`、`StatusPill`、`MetricChip`、`PrimaryButtonStyle`/`SecondaryButtonStyle`(hover/pressed/
  disabled)、`IconButton`(a11y label+tooltip+点击区)、`EmptyStateView`、`SegmentedProgress`、`DSProgressBar`、
  `InlineNotice`。
- `PetIntentEnvironment.swift` — `\.sendPetIntent`、`\.setWindowMode` 环境注入。

## F. Page Redesign

- **今日**（`UI/TodayView.swift`）：问候头部（时间驱动，无硬编码名字）→ 当前/下一项任务卡 →
  任务进度（真实 done/total，无任务时隐藏）→ 快速输入（草稿确认）→ 任务卡列表 → 完整空状态
  （图标+文案+「专注25分钟」「添加任务」）。完成任务只发一次 `taskCompleted` 意图。a11y：行可读、
  完成按钮 label、VoiceOver value。
- **专注**（`UI/FocusBoardView.swift`）：复用唯一 `FocusEngine`（不新建 Timer）；大号 rounded 数字计时、
  阶段/轮次、开始/暂停/继续/跳过/结束、模式选择、关联任务、本次会话概览（MetricChip）。专注期文案与
  角色陪伴状态；开始/继续/暂停/完成发对应 UI 意图。
- **陪伴**（`UI/RelationshipView.swift`）：阶段 + 模糊进度（`SegmentedProgress`，永不显示数字）+
  `progressHint`；情绪用真实 `moodHint`（定性，不伪造数值）；已解锁的话内容卡 + 空状态；配饰为可选
  卡片（非裸 Radio，含锁定原因/已佩戴 value）；小窝开关；陪伴伦理说明。
- **记忆**（`UI/MemoryView.swift`）：卡片化（文本 + 类别/来源/敏感/仅本地/禁云端/到期 badge），展开看
  原因/使用次数/是否上云/控制开关；新增输入；待确认提醒；空状态；删除走确认对话框；隐私页脚。不显示
  Prompt/凭据。
- **设置**（`UI/SettingsView.swift`）：隐私与权限说明（屏幕读取仅显式开启、麦克风/键盘/剪贴板默认关，
  不主动弹权限）+ 数据与同步（复用真实 `DataView`）+ 关于（Bundle 版本）。原「数据」从一级导航收敛到此。

## G. Window Modes

- `WindowMode`(mini 288×120 / compact 400×520 / expanded 580×700)；顶部菜单切换，经 `\.setWindowMode`
  到 `MainWindowController.applyMode`（复用同一 NSWindow、顶边锚定、`animate:true`，绝不重建窗口/Runtime）。
- 状态所有权：`@AppStorage("deskpet.windowMode")` + `deskpet.section`（持久化）。初始尺寸由持久化形态决定。
- **Mini 已实现 live 切换**：`MiniView` 简化状态 + 当前任务/专注计时 + 展开入口 + 一个主操作，复用
  `model.focus`/`relationship`（同一状态源）。
- 多显示器：`applyMode` 顶边锚定避免跳出屏；窗口本身可被系统约束在屏内。

## H. Pet / UI Integration

`Render/PetUIIntentRouter.swift`：强类型 `PetUIIntent`(windowOpened/navigationChanged/focusStarted/
focusPaused/taskCompleted/focusCompleted/runtimeAttention/permissionBlocked) → 映射到现有
`PetAgentAnimationEvent`（不新增动画系统）。`navigationChanged` 经 `navThrottle`(0.6s) 去抖。注入：
`AppDelegate` 构造 `PetUIIntentRouter`（sink = overlay.handleAgentAnimationEvent），经
`MainWindowController` 注入 `\.sendPetIntent`。已接线：窗口打开、切导航（节流）、开始/暂停专注、完成
任务/专注。View 不触碰 PetRenderer 内部。

## I. Accessibility

- VoiceOver：导航项 isSelected/isButton、任务行 value、配饰 value、SectionHeader isHeader、IconButton label。
- 键盘：导航/操作为标准 Button（Tab/Return/Space）。
- Reduce Motion：`DSMotion.*(reduceMotion)` 退化为短淡入/无 spring。
- Reduce Transparency：`AppGlassContainer` 与 `DSColor`(reduceTransparency) 退化近实色（可测）。
- Dark Mode / Increase Contrast：`DSPalette` 动态取色（可测）。
- 状态不只靠颜色：选中态加左侧强调条 + 文字；StatusPill/InlineNotice 带符号+文字。

## J. Tests and Build

- baseline：`swift test` → 223 passed / 0 failed。
- final：`swift test` → **254 passed / 0 failed / 0 skipped**（新增 25 个 P5.1 用例：
  DesignSystem 8、Navigation 6、PetIntent 5、Pages 6）。
- build：`swift build` / `swift build --build-tests` → Build complete（新增代码 0 warning）。
- `git diff --check` → exit 0。
- App 启动：`scripts/run.sh` 构建+签名+启动成功，进程稳定无崩溃（PID 记录于会话）。

## K. Visual Evidence

**HUMAN_REVIEW_REQUIRED** — 自动化环境无法安全截取实时桌宠/窗口、无法切换系统辅助设置、且为隐私不对
整桌面 screencapture。采集清单与步骤见 `docs/p5_1_visual_evidence/README.md`（01–10 文件名约定）。

## L. Files Changed

新增：`DesignSystem/{DesignColors,DesignTokens,DesignComponents,PetIntentEnvironment}.swift`、
`Render/PetUIIntentRouter.swift`、`UI/{AppShellView,TodayView,FocusBoardView,SettingsView}.swift`、
`Tests/DeskPetTests/{P5_1DesignSystemTests,P5_1NavigationTests,P5_1PetIntentTests,P5_1PagesTests}.swift`、
`docs/{P5_1_REPORT.md,p5_1_visual_evidence/README.md}`。
修改：`AppDelegate.swift`(注入 router)、`UI/{MainViews,MainWindowController,DataView,MemoryView,
RelationshipView,QuickTaskPanel}.swift`。

## M. Known Limitations

- 本地化：仍硬编码中文；未提取到 `.strings`（SwiftPM 资源化属较大基础设施变更，留待后续）。
- 运行时主动模式（ProactiveMode）与系统权限申请未在设置页做可写控件（需 Runtime 绑定）——本轮以真实
  只读说明呈现，不做假控件。
- 陪伴「最近变化记录」：底层无完整事件历史，未伪造；以来源说明替代。
- 视觉截图为 HUMAN_REVIEW_REQUIRED（环境限制）。
- 对话气泡从角色附近展开的浮动入口重设计未在本轮覆盖（现有 overlay 气泡仍在用）。

## N. Final Git Status

`git status --short -- "桌宠/DeskPet"`：13 新增 + 7 修改，全部位于 `桌宠/DeskPet`。
`-- "Live 2D项目/live2d_model"`、`-- "桌宠/assets/concept"`：无输出（未变化）。
`git diff --cached`：无（未 stage）。`git diff --check`：exit 0。
staged=none，committed=false，live2d unchanged=true，concept unchanged=true，无关文件未触碰=true。
