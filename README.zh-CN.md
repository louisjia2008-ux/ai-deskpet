# DeskPet

[简体中文](README.zh-CN.md) | [English](README.md)

DeskPet 是一个本地优先的 AI 桌面伙伴，仓库内并行保留两套实现：

- `Sources/` 是现有 macOS 原生版，使用 Swift、SwiftUI、AppKit、SpriteKit、WebKit 和 Live2D 运行时。
- `electron/` 是跨平台核心版，使用 Electron、React、严格 TypeScript、PixiJS 和 Live2D。它不替换、也不修改原生版。

Electron 版包含单一 Live2D 伙伴、透明桌面悬浮层、托盘、Companion Console、聊天、AI Provider、任务与专注、记忆、关系、定时任务、可审计的权限门控 Agent Runtime，以及英文/简体中文界面。它使用独立标识 `com.deskpet.companion.electron` 和数据目录 `DeskPet Electron`，可与原生版同时安装运行。

Electron 控制台新增 **Minecraft 陪玩**：迁入 [`minecraft-companion`](https://github.com/louisjia2008-ux/minecraft-companion)（原名 `live2d-mc-companion`）的任务引擎，支持 Java 版入服、任务控制、状态/背包/聊天同步，以及复用 DeskPet 模型的混合规划。使用方法、进程和数据边界见 [Minecraft 陪玩指南](electron/docs/MINECRAFT_COMPANION.md)。

## 状态与支持矩阵

| 能力 | macOS | Windows | Linux X11 | Linux Wayland |
|---|---|---|---|---|
| Electron 构建与打包目标 | 支持 | 支持 | 支持 | 支持 |
| 透明桌宠悬浮层 | 支持 | 支持 | Electron/X11 支持 | 降级，取决于合成器 |
| 精确定位与始终置顶 | 支持 | 支持 | 支持 | 降级，合成器可能忽略 |
| 透明区域精确点击穿透 | 支持 | 支持 | 尽力支持 | 降级，不保证逐像素转发 |
| 托盘、通知、开机启动 | 支持 | 支持 | 取决于桌面环境 | 取决于桌面环境 |
| 全局快捷键 | 默认 `Option+Space` | 默认 `Ctrl+Alt+P` | 默认 `Ctrl+Alt+P` | 可能需 Portal 授权，行为因桌面而异 |
| Swift 原生版数据迁移 | 通过 macOS helper 支持 | 不可用 | 不可用 | 不可用 |

应用会把每项平台能力显示为 `available`、`degraded` 或 `unavailable`，并给出真实原因。Electron API 存在不等于桌面环境一定遵守请求。DeskPet 不会自动修改用户的 Wayland/X11 启动参数。

当前真实桌面证据刻意保持窄化：

| 验收面 | 结果 |
|---|---|
| macOS Console 与透明 overlay 首启、本地协议、Core/模型缺失状态 | 开发 Mac 上 PASS |
| macOS 导入合法 Core+模型后的渲染、拖动、命中、穿透、动作、多显示器、睡眠唤醒、全屏、DPI/Retina、托盘/快捷键 soak | 本次变更中尚未观察 |
| Windows 真实桌面 | 尚未观察 |
| Linux X11 真实桌面 | 尚未观察 |
| Linux Wayland 真实桌面 | 尚未观察；自动化能力判定不等于真机观察 |

编译、E2E 冒烟或截图都不能替代未观察平台上的真实桌面 Live2D 验收。

## 环境要求

Electron 版需要 Node.js 22+、npm 10+ 和当前 Electron 支持的 macOS/Windows/Linux。macOS 构建迁移 helper 还需要 Swift 6/Xcode Command Line Tools。用户必须自行从官方 [Live2D Cubism SDK for Web](https://docs.live2d.com/en/cubism-sdk-manual/cubism-sdk-for-web/) 合法取得 Core，并准备有权使用的 Live2D 模型 ZIP。编译和默认 fixture 测试不需要 Provider 密钥。

macOS 原生版需要 macOS 14+、Swift 6 和当前 Xcode Command Line Tools；只有通过 `project.yml` 重生 Xcode 工程时才需 XcodeGen。原生 Live2D 渲染还可选用你合法取得、哈希在 allowlist 内的 Cubism Core，并仅放在本机已忽略路径 `Resources/Live2DRuntime/live2dcubismcore.min.js`；不得提交该专有文件。

## 开发与测试 Electron 版

```bash
cd electron
npm ci
npm start
```

```bash
npm run lint
npm run typecheck
npm test
npm run test:security
npm run build
npm run test:e2e
npm run audit:package
```

`npm run build` 在 `electron/out/` 下生成未打包应用。E2E 前需先运行它以生成 production webpack bundle。`npm run make` 创建当前平台的未签名预览安装包。GitHub Actions 会构建 macOS ZIP、Windows x64 Squirrel `Setup.exe`、Linux x64 `.deb`，并上传覆盖率、Playwright 报告和仅含脱敏 fixture 的失败证据。

CI 只上传 artifact，不创建 GitHub Release。这些安装包是未签名预览版；Apple notarization 和 Windows Authenticode 是独立发布门槛。

## 首启：Cubism Core 与模型

Electron 版不包含 Cubism Core、默认模型、PNG fallback 角色或开发模型。

1. 自行下载官方 Cubism SDK for Web，并接受相应条款。
2. 在“伙伴”设置中选择 `live2dcubismcore.min.js`。DeskPet 只接受精确文件名、有界大小和 SHA-256 allowlist。首个允许哈希为 `944988f1523c9f888afe3611b630121ff503ea6246971d2eeee76f45cbfb8004`。
3. 选择你有权使用的模型 ZIP，其中必须且只能有一个可解析 `model3.json` 及引用资源。
4. DeskPet 校验路径、重复/冲突、符号链接、扩展名、条目数、单文件与展开大小、资源引用，然后解压到受控 staging。
5. 只有 sandbox renderer 报告模型真正加载成功后，才原子提交 active model。取消或失败会清理 staging 并保留旧配置。

通过验证的文件仅复制到应用管理目录，并通过受限 `deskpet://managed` 本地协议加载。任意用户路径和网络页面都不能执行 Core。

## Companion Console 与 Agent 边界

Console 包含今日、聊天、伙伴、专注/任务、记忆、定时任务、任务中心、Provider、工具权限、隐私、迁移、外观与诊断。main process 拥有窗口、托盘、快捷键、持久化、调度、权限与唯一运行时；preload 只暴露有类型的 `window.deskpet`；React renderer 无法访问 Node.js、文件系统、通用 IPC 或任意导航；utility process 在 renderer 之外执行 Provider 网络请求，main process 的唯一运行时负责校验并调度已授权工具。每个工具调用都携带 run/task 身份、能力 ID 和经过 schema 校验的参数。

所有 BrowserWindow 都启用 context isolation 和 Chromium sandbox，并关闭 Node integration。IPC 验证 channel、API 版本、精确 schema、payload 大小、本地 origin、发送者 WebContents 和窗口角色；两个 renderer 都有严格 CSP，禁止任意导航与新窗口。

首版工具为当前时间、有界系统概览、应用内计时器、本地通知、受限工作区文件读写，以及带 DNS/IP、重定向、内容类型、大小和超时限制的 HTTPS 网页读取。副作用受权限门控，使用幂等键记录。重启后错过的副作用定时任务只标记 `missed`，不静默补执行。

## AI Provider 支持

| Provider | Electron 状态 | 协议 |
|---|---|---|
| OpenAI | 支持 | OpenAI-compatible chat/models/streaming |
| OpenAI-compatible endpoint | 支持 | 可配置 Base URL |
| MiniMax | 通过 OpenAI-compatible endpoint 支持 | OpenAI-compatible |
| GLM / 智谱 | 通过 OpenAI-compatible endpoint 支持 | OpenAI-compatible |
| DeepSeek | 支持 | OpenAI-compatible |
| Ollama | 支持 | 本地 OpenAI-compatible endpoint |
| LM Studio | 支持 | 本地 OpenAI-compatible endpoint |
| Anthropic | 未实现、不宣称支持 | — |
| Gemini | 未实现、不宣称支持 | — |
| 任意 Custom HTTP | 未实现、不宣称支持 | — |

已实现流式文本、取消、重试/错误映射、模型列表和已声明工具调用。默认 CI 只用本地 fixture server。由于用户选择不创建密钥，本次 OpenAI 真实连接验证记为 `NOT_RUN_NO_CREDENTIAL`。

## macOS 原生数据迁移

在 macOS 上，“设置 → 迁移”可把 `~/Library/Application Support/DeskPet` 中选定数据导入空 Electron Profile。

- 预检由用户主动触发，列出类别、数量、警告和源摘要。
- Swift helper 通过现有 `ai.deskpet.vaultkey` Keychain 项读取原生明文或 `DPET1` AES-GCM 存储，不创建、也不修改该密钥。
- 源目录始终只读；导入前备份 Electron 目标目录，提交前再次校验源摘要。
- 可导入普通/项目对话、记忆、任务、关系/外观、定时任务、已支持 Provider 配置和由 ZIP 支撑的当前模型选择。
- 不导入临时/私密对话、运行中 continuation、grant、副作用 ledger、诊断、日志、缓存与测试状态。
- Provider API Key 需额外勾选和第二次确认。密钥只通过专用子进程私有管道进入 main process，并立即用 `safeStorage` 加密；不写明文临时文件，不返回 renderer。
- Keychain 拒绝时仍可导入 Provider 配置，密钥标记为缺失。
- 成功后写入带摘要的一次性标记，不重复合并；提交前取消可之后重试。

已解压的原生模型目录不会被暗中重新打包，用户需重新导入合法原始 ZIP。如原生配置指向 ZIP，仍会经过普通 Electron 导入的全套恶意压缩包校验与 renderer 确认。

## 本地数据、隐私与安全

- macOS：`~/Library/Application Support/DeskPet Electron`
- Windows：`%APPDATA%\DeskPet Electron`
- Linux：通常为 `~/.config/DeskPet Electron`

领域数据使用版本化 AES-256-GCM 信封、临时文件+原子 rename、schema 验证和损坏隔离。随机 vault key 与 Provider API Key 由 Electron `safeStorage` 保护。Linux 上会拒绝 `basic_text` 后端：在安装并解锁 GNOME Keyring、KWallet 或其他可接受秘密服务前 fail closed。

工作区工具被限制在 DeskPet Electron 工作区目录内。Provider 密钥、模型内容、用户数据和诊断秘密不进入仓库 fixture 或 CI artifact。

## macOS 原生版开发

```bash
swift test
bash scripts/build_app.sh debug
bash scripts/run.sh debug
```

`scripts/build_app.sh` 在没有 Cubism Core 时仍可构建，并将原生 Live2D 标记为不可用；如果本机忽略路径中存在 Core，则会先按 allowlist 验证 SHA-256 再复制。静态/项目自有角色渲染不依赖 Core。

原生正式工具目录当前不暴露通用网页读取，旧 ToolRunner 的
`network.fetch`/`network.search` 也默认不可用。仅校验主机名无法锁定
URLSession 最终连接的地址，所以在实现地址锁定传输层前保持 fail closed。
这不影响 Electron 版独立的有界 HTTPS 读取器。

`scripts/run.sh` 会停止已运行的原生 `DeskPet` 进程，只在明确期望此行为时使用。签名、TCC、Keychain、真实桌面行为和 notarization 都是独立于编译的门槛。

## 仓库结构

```text
electron/         Electron/React 跨平台版与 macOS 迁移 helper
Sources/          Swift/macOS 原生应用与运行时模块
Tests/            Swift 原生测试源码
Live2DRuntime/    原生版现有 TypeScript/WebKit Live2D 运行时
Resources/        原生应用资源
ThirdParty/       现有第三方来源与 Live2D 通知
.github/          Electron 跨平台预览 CI
```

## 许可与再分发边界

顶层 [MIT 许可](LICENSE) 只适用于项目自有源码与文档，不重新许可 Live2D Cubism Core、Cubism SDK 组件、用户模型、角色美术、图片、音频、字体或任何第三方作品。保留的项目自有创意素材单独采用“保留所有权利”。再分发前请阅读 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、[ASSETS_AND_MODELS.md](ASSETS_AND_MODELS.md) 和 [ASSET_LICENSE.md](ASSET_LICENSE.md)。

`electron/minecraft-companion-runtime/` 和 `electron/minecraft-runtime/` 下的 Minecraft 运行时来自独立仓库 [louisjia2008-ux/minecraft-companion](https://github.com/louisjia2008-ux/minecraft-companion)（原名 `live2d-mc-companion`），采用 **AGPL-3.0-only**，不适用 MIT。见各目录的 `LICENSE`、`COMPANION_SOURCE.json` 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

AIRI 派生 Live2D 算法保留固定来源 `moeru-ai/airi@00c6867b7fd8064938de1805814578db8273dafe`、版权通知和 `ThirdParty/` 下 MIT 文本。

两套实现的已跟踪源码和 Electron 安装包都不包含 Cubism Core 或用户模型。原先的第三方示例角色、带本机路径的 rejected 评审证据和来源未确认的参考视频已从公开源码配置中移除。旧私有 Git 提交仍需经授权历史改写和全引用复扫，之后才能改变仓库可见性。源码公开本身不等于已经满足 Live2D 应用发布、签名、notarization 或商业分发要求。
