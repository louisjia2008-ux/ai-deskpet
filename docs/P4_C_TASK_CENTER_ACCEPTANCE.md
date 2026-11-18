# P4-C Task Center Acceptance

This checklist must be run on a signed DeskPet app build. Automated tests are supporting evidence only; they do not count as human/device acceptance.

## TEST 1 - 普通文本回复

- 输入普通聊天，例如：`你好，陪我聊一下。`
- 预期：不显示 provider reasoning、开发者日志、raw prompt 或终端式输出。
- 预期：任务活动正常结束，最终只有普通 assistant 回复。

## TEST 2 - 单工具 P0

- 输入：`请告诉我当前本地时间。`
- 预期：聊天内显示紧凑 activity。
- 预期：完成后折叠为完成状态。
- 预期：不显示多步骤计划卡。

## TEST 3 - 多步骤 P0

- 输入：`请告诉我当前时间、macOS 版本和当前使用的应用。`
- 预期：计划步骤实时更新。
- 预期：步骤顺序与实际执行顺序一致。
- 预期：最终只出现一条综合回复。

## TEST 4 - P1 Approval

- 输入：`结合当前时间和今天的日历，告诉我接下来还有哪些安排。`
- 预期：控制面板聊天、Floating Chat、Task Center 同步显示等待确认。
- 预期：只允许批准一次，批准后按钮消失或禁用。
- 预期：批准前不访问 Calendar。

## TEST 5 - 拒绝批准

- 在 TEST 4 中点击拒绝或取消。
- 预期：任务进入终止状态。
- 预期：无工具执行，无 Calendar 权限请求。
- 预期：下一条聊天正常。

## TEST 6 - 停止运行任务

- 启动一个多步骤任务后点击停止。
- 预期：后续步骤不执行。
- 预期：聊天内和 Task Center 都显示 cancelled。
- 预期：迟到结果不覆盖 cancelled。

## TEST 7 - 工具失败

- 让其中一个工具失败或拒绝系统权限。
- 预期：显示安全失败摘要。
- 预期：可点击 retry。
- 预期：不显示 raw error、raw result 或内部 enum。

## TEST 8 - Retry

- 对失败或取消任务点击重试。
- 预期：保留原 taskID 的历史。
- 预期：创建新的 run。
- 预期：旧 run timeline 不被覆盖。
- 预期：重新经过 risk / permission validation。

## TEST 9 - Task Center Filtering

- 检查 `正在执行`、`等待处理`、`已完成`、`失败`、`全部任务`。
- 预期：筛选结果准确。
- 预期：空状态文案清晰。

## TEST 10 - 双窗口同步

- 在 Floating Chat 发起任务。
- 打开控制面板聊天和 Task Center。
- 预期：三者任务、步骤状态、批准状态一致。
- 预期：工具不重复执行。

## TEST 11 - 重启恢复

- 启动任务后退出或重启应用。
- 预期：terminal history 保留。
- 预期：未终止的 running task 变为 interrupted / failed-safe 状态。

## TEST 12 - 隐私

确认聊天 activity、Task Center 和持久化历史不显示：

- 私人日历标题、具体时间、地点
- provider reasoning
- chain-of-thought
- raw arguments
- raw tool result
- API key
- Authorization header
- Cookie
- permission token
- tool call ID

## TEST 13 - UI

- 检查 light mode。
- 检查 dark mode。
- 检查小窗口宽度。
- 检查 VoiceOver label。
- 检查 keyboard navigation。
- 检查 reduced motion 下无多余动画。

## Automation Reference

Automated P4-C coverage lives in:

- `Tests/DeskPetTests/P4CTaskActivityTests.swift`

The automation uses fake/scripted providers, fake gates, fake executors, in-memory state, and temporary JSONL persistence. It must not call a real Provider, EventKit, Keychain, network, shell, browser, or user files.
