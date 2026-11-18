# P5.1 视觉证据 — HUMAN_REVIEW_REQUIRED

本轮自动化环境无法安全地对实时桌宠/主窗口截图，也无法切换系统级辅助设置（Reduce
Transparency / Reduce Motion / Increase Contrast / 大字体），并且为保护隐私不对用户整个桌面
做 `screencapture`。因此以下视觉证据标记为 **HUMAN_REVIEW_REQUIRED**，请按步骤人工采集，
文件保存到本目录（不要写入 concept / live2d_model）。

## 启动

```
cd "/path/to/DeskPet"
./scripts/run.sh
```
菜单栏出现 🐾 / app 图标后，点开主窗口（菜单栏图标 → 打开主窗口）。

## 采集清单（建议文件名）

| 文件 | 内容 | 步骤 |
| --- | --- | --- |
| 01_desktop_pet_idle.png | 桌宠单独悬浮桌面 | 不开主窗口，截角色所在区域 |
| 02_today_empty_compact.png | 今日 · 空状态（紧凑） | 删除全部任务，停在「今日」 |
| 03_today_active_task.png | 今日 · 有任务 | 新建 2–3 个任务 |
| 04_focus_active.png | 专注 · 进行中 | 「专注」→ 开始 |
| 05_companion_expanded.png | 陪伴 · 展开 | 顶部形态切到「展开」，进「陪伴」 |
| 06_memory.png | 记忆页 | 进「记忆」 |
| 07_settings_permissions.png | 设置 · 隐私与权限 | 进「设置」 |
| 08_dark_mode.png | 深色模式 | 系统设置切深色后重截「今日」 |
| 09_reduce_transparency.png | 减少透明度 | 辅助功能开启 Reduce Transparency 后重截 |
| 10_large_text.png | 大字体 | 调大文本尺寸后重截 |

## 人工视觉验收要点

- 第一眼不再像默认 Form / 系统设置页。
- 导航选中态清晰（左侧强调条 + 文字 + 符号，不只靠背景色）。
- 玻璃克制、文字始终可读；Light 不刺眼、Dark 非纯黑。
- Reduce Transparency 后界面仍完整可读（玻璃退化为近实色）。
- 空状态有设计（图标 + 文案 + 主操作 + 快捷入口），不是大片空白。
- 关闭主窗口后桌宠仍在；重开主窗口角色有轻微注意反馈；切导航/开始专注/完成任务时角色有适度联动。
