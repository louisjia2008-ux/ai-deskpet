# DeskPet Electron

The Electron edition is a cross-platform companion that lives beside the native Swift/macOS edition. It has a separate application ID and data directory, and it does not bundle Live2D Cubism Core or a character model.

The console's **Minecraft / 陪玩** page connects a Mineflayer companion to Minecraft Java servers, with task controls, observed game status, inventory and chat. It reuses the migrated Minecraft task engine and can use a selected DeskPet provider for planning. See the [bilingual Minecraft guide](docs/MINECRAFT_COMPANION.md) for setup, authentication, architecture and validation limits. The [local real-server guide](docs/MINECRAFT_LOCAL_SERVER.md) installs the project JDK/server and reruns empty-inventory diamond acceptance; [current evidence](docs/MINECRAFT_REAL_VALIDATION.md) records the completed vanilla run and its limits.

## Local development

```bash
cd electron
npm ci
npm start
```

The first start builds the macOS-only migration helper when running on macOS. Import an allowlisted `live2dcubismcore.min.js` from an official Cubism SDK and then a Live2D model ZIP you are licensed to use.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run test:security
npm run test:minecraft
npm run test:e2e
npm run test:coverage
npm run make
npm run audit:package
```

The tests use fixtures and do not require a provider API key. Real provider calls, a real Core/model rendering pass, signing, notarization, and real Windows/Linux desktop behavior are separate evidence gates.

### 手机遥控、长对话与本地笔记

- **Telegram 配对。** 通道默认关闭。准备接入真实服务时，为 DeskPet 单独新建机器人；同一机器人不能同时供 OpenClaw 和 DeskPet 轮询。在桌面的 Telegram 设置里生成配对码，私发给机器人，再回桌面核对账号 ID 并批准。连接检查只列事件类别和拒绝字段，不显示消息正文。开发验收使用本机假 Bot API 和临时资料，不需要创建机器人。
- **Telegram 手机操作。** 普通新消息在当前任务后排队；`/append 内容` 尝试补充当前任务，`/stop` 只停止当前运行。联网和任务工具可用，工作区每次操作都需要手机按钮批准；shell、凭据和权限设置只在桌面使用。工作区操作的批准不等于允许把结果发到手机。需要披露时，在桌面「查看待批准结果」核对原文和卡片标识，手机的批准仅对这份结果有效。记忆须在通道和对应记忆上分别启用。
- **QQ 忙碌时的消息。** 已绑定账号发来的普通消息先保存，再按顺序作为独立任务执行；最多保留 8 条待执行消息。忙碌时会说明已入队，不会把新消息悄悄加到当前任务。`/queue` 查看状态，`/cancel-queue` 取消待执行消息。QQ 的 `/stop` 会停用整个通道并暂停队列；在桌面重新启用后，由同一绑定账号发送 `/resume-queue` 恢复。模型或授权变化会阻止旧任务沿用失效设置；中断且执行结果未知的任务不会自动重放。此处的命令语义与 Telegram 分开。
- **切换模型的指令。** 桌面聊天、已配对的 QQ 私聊和 Telegram 都可以发送：`/model` 查看当前模型，`/models` 列出当前服务的模型，`/model 名称或序号` 切换模型，`/provider` 列出模型服务，`/provider 名称或序号` 切换服务，`/help` 查看说明。名称可以只写能唯一匹配的一部分。指令由应用直接回答，不调用模型，也不占用 QQ 的每日对话次数。切换只影响发出指令的入口：桌面改的是桌面当前服务及其模型，QQ 和 Telegram 各自保存自己的选择，连接和配对不变。QQ 群和未配对账号发来的这些指令不会执行。
- **延迟和定时投递。** 在桌面为需要推送的 cron 单独启用 Telegram；DeskPet 运行时才会执行这些任务。已知离线的结果会保留，连接恢复后重新检查权限。若请求已发出但没有可靠的 Telegram 回执，桌面会标记为未确认；请先在手机上核对，避免重复发送。
- **本地模型。** Ollama 的加载上下文可在服务设置里填写。填写后使用原生 `/api/chat` 的 `options.num_ctx`；留空沿用原有协议。在桌面启用本地/云端路由后，复杂任务会先询问是否改用指定云模型。长对话会标出哪些旧消息用摘录代替全文；取消记忆授权后，旧摘录仍受来源检查。
- **笔记。** 在知识库设置选择目录，然后建索引。DeskPet 只读 Markdown，通过本机 `nomic-embed-text` 分批嵌入，聊天模型驻留时不启动嵌入。笔记问答需要选择可验证为本地的 Ollama 模型；来源附相对笔记路径及行号。编辑或删除笔记会使旧摘录失效，重新建索引后可检索更新内容。
- **技能。** 「设置 → 技能」提供列表、搜索、查看、更新、启停和移除；可从本机目录导入 `SKILL.md`，也可添加随应用提供的中英写作、资料证据检查、IB Economics 自检、项目复盘四个原创中文技能。技能只包含文本方法，不自动导入脚本、附件或运行环境。默认仅限本地：读取私有技能简介或正文需要已核实的本机 Ollama 模型，并使本会话停止外部研究。查看全文并批准具体版本为「公开方法」后，支持工具的桌面模型可按需使用，公开方法本身不会关闭联网；已有的其他隐私限制仍适用。修改、停用、移除或撤回公开授权会使旧版本授权失效，相关历史也继续受来源限制。
- **MCP 服务。** 「设置 → MCP 服务」管理 Streamable HTTP 服务，提供 DeepWiki、Microsoft Learn、Playwright 和 GitHub 推荐项。公共 HTTPS 服务的可选 Bearer 令牌在单项认证设置中输入，绑定当前资料库和精确服务地址后加密保存；不会从 JSON 清单导入凭据。GitHub 使用官方 `/mcp/readonly` 地址及只读请求头。普通桌面聊天在支持工具的模型（本机或云端）、非私有会话和已启用的固定预设地址下，支持五项只读能力：Microsoft Learn 搜索/读取、DeepWiki 结构/正文、GitHub 公开仓库名称搜索。每次调用展示目标、工具及完整参数并逐次批准；需要身份认证的返回内容按私有来源处理。任意 MCP、Playwright 浏览器操作及本地桥仍从设置页使用，不属于普通聊天自动工具。
- **独立浏览器。** Playwright 运行时固定依赖版本并随包附带，使用 Playwright 自带的无头 Chromium（headless shell，存放在 Playwright 默认缓存目录），不调用系统已安装的 Google Chrome。首次列出工具或调用时启动隔离的无头浏览器，多个 MCP 会话可继续操作同一网页；停用、移除或退出 DeskPet 时关闭，重新启用得到新环境。仅本机私有能力地址可连接；不复用日常浏览器登录，且不开放宿主代码执行工具。开发环境可运行 `npm run prepare:playwright-mcp` 安装依赖和对应版本的无头浏览器，`npm run check:playwright-mcp` 核对依赖与浏览器。
- **自动记忆。** 对话停下约 3 分钟后，由刚才回答的那个模型把你在这段对话里说过的话再读一遍，把长期有用的事实和偏好（身份、在做的项目、常用工具、希望怎样回答等）记进「记忆」，标签为 `auto`。只读你本人写的消息，不读定时任务、QQ 群聊和带密码、密钥、链接的消息；标为仅本地的对话只交给本地模型，记下的内容也标为仅本地。每条都能修改或删除，删除后不会再被记住。在「记忆」页顶部可以关闭。QQ 和 Telegram 仍只使用你单独勾选过的记忆。
- **夜间整理（浅层与深层记忆）。** 自动记下的内容先是「浅层」，只在和当前话题相关时带入聊天。每晚（默认 3 点；当时没开着就在下次启动后补做）由当前使用的模型整理一次：合并重复的，新说法替换旧说法，把长期成立的升为「深层画像」（最多 12 条，每次聊天都带上），放下只是一时的内容；30 天没有再被印证的浅层记忆自动淡出。你自己写的或改过的记忆不会被改动，重复的浅层条目只会并入它。整理直接生效，「记忆 → 夜间整理」列出每一步，30 天内可逐条撤销，撤销回来的记忆不再参与整理。仅本地的记忆只交给本地模型。从备份恢复后，自动记忆和夜间整理默认关闭。
- **定时任务结果发到 QQ。** 在「定时任务」里勾选「将结果发送到我的 QQ 私聊」，桌面创建的定时任务跑完后会把回复同时发到已绑定的 QQ 私聊。回复用到仅本地内容时不发送。暂停后恢复、修改任务或重新绑定 QQ 后需要重新勾选。
- **沙盒虚拟机。** 「设置 → 沙盒虚拟机」可以建立一台独立的 Linux 虚拟机（需要先 `brew install lima`；Ubuntu 24.04，4 核、4 GB 内存、20 GB 磁盘，首次建立约 10 分钟）。建立后，桌面聊天里的模型（本地或云端）可以用 `vm.shell` 在里面运行任意 bash 命令：写代码并运行、装 Python/npm 包、处理文件。边界：虚拟机只挂载主目录下的「DeskPet Sandbox」一个文件夹，看不到其他文件；命令以没有 sudo 的用户运行，防火墙拦住这台 Mac 自身（包括本机的 Ollama 和代理端口）和局域网，只能直连公网，所以需要代理才能访问的网站在里面打不开；虚拟机的端口不会映射到 Mac。每条命令默认限时 2 分钟（最长 10 分钟），结束时它启动的进程全部终止；15 分钟没有命令或退出 DeskPet 时虚拟机关机。每个任务的第一条命令需要在聊天里批准，可选“本次任务内都允许”；QQ、Telegram、Minecraft 游戏内聊天、定时任务和研究任务不能使用，含私密内容的任务也不能使用。共享文件夹里出现的文件应当作网上下载的文件对待。虚拟机数据在 `~/.deskpet-vm`，与其他 Lima/Colima 环境分开；在设置页可以停止或删除。
- **受限本地工具。** 保留[显式启动的 macOS 本地 stdio 桥](docs/LOCAL_STDIO_BRIDGE.md)。受限 shell 只处理工作区内的文本，不提供任意命令解释器。

准备替代 OpenClaw 时，见[两周并行和 cron 切换步骤](docs/OPENCLAW_CUTOVER.md)。盘点是只读操作，不会启动第二份定时任务。

See the repository-level [English README](../README.md) or [简体中文 README](../README.zh-CN.md) for architecture, platform limitations, migration behavior, security boundaries, packaging, and licensing.

### 当前源码的使用入口与验收范围

以下描述当前源码中的流程。源码检查、使用合成资料的隔离运行、真实服务验证和已安装日常版是不同的证据；修改源码或通过测试不会自动更新 `~/Applications/DeskPet Electron.app`。

1. **先看当前能做什么。** 展开聊天模型下方的「能力与限制」，查看联网、公开/私有方法、聊天 MCP 与浏览器的条件，并可手动刷新。这里展示配置条件，执行时仍核验服务、模型与权限，不表示服务已经连通。
2. **交给后台研究。** 在「更多 → 任务 → 后台任务」的「后台研究」区域填写目标、选入材料、服务和模型。默认每次最多 10 分钟、20 次工具调用，可设为 2–30 分钟和 4–40 次；发送远端模型必须单独勾选。研究只获得这次选入的材料及本任务可核验的旧成果，不自动带入其他聊天、记忆或个人设定。它可查公开资料、计算、维护计划和本任务目录，不能执行命令、改设置或向外发送消息。报告保存在 `research/<任务 ID>/report.md`；实际文件与保存记录核对通过后才能标记完成。切换页面或隐藏窗口时继续运行；退出后停止，重启后的中断任务由「继续未完成部分」显式恢复为新一轮有上限的执行，旧报告保留到任务的 `attempts/` 目录。模型或权限已变化时需新建任务重新选定范围。
3. **按大意找回记忆，再保存有效做法。** 选择普通桌面对话，在「记忆 → 按大意找回记忆」描述要找的内容，点击「在本机查找」。只有这个显式操作会准备本机语义检索；需可核实为本机运行的 `nomic-embed-text`，不会下载模型或抢占正在使用的聊天模型。模型不可用时明确显示关键词结果，检索覆盖不完整时显示数量。普通聊天使用已准备的匹配结果或关键词，并可带入少量已确认的稳定表达偏好，不等待嵌入模型加载。记忆仍按对话、服务权限和最新版本过滤；「用这个问题继续聊天」只填入输入框，由用户发送。已完成任务的「保存为我的做法」提供可编辑草稿，需审阅、去除私人细节后保存；新方法默认仅限本地且停用，到「设置 → 技能」启用，公开使用另行批准。
4. **忙碌时接住 QQ 消息。** 连续发两条独立请求时，第二条应得到排队提示，并在第一条结束后执行。使用 `/queue` 核对数量；`/cancel-queue` 不停止已经运行的请求。需要紧急停止整个 QQ 通道时使用 `/stop`。真实 QQ 接收与投递须单独验证，合成网关测试不代表真实账号已验收。
5. **找回、预览、继续修改成果。** 「更多 → 文件 → 成果」按文件路径、任务目标或对话名称搜索已记录的成果；Markdown、文本、CSV 和 PDF 在本机预览。文本预览上限 1 MiB、PDF 16 MiB，CSV 表格最多展示 200 行数据、50 列，每格 4,000 字符，并说明截取范围。文件版本变化或来源记录不再可用时停止预览。「继续修改」回到原对话并填入文件及保存版本，仍由用户补充要求后发送；归档对话先恢复。Markdown、TXT、CSV 可点击「导出 PDF」生成保留原文字内容的 A4 PDF，Markdown 标记按文字保留；导出不运行源 HTML、不加载外部图片，也不覆盖源文件。新的 PDF 成果记录保存源路径和摘要；「修改源文件」先核验 PDF 与对应文本源文件，再回到原对话修改源文件，完成后可重新导出。没有已记录可编辑源文件的独立 PDF 不提供继续修改。保存回执不确定时不会显示导出成功或自动重试。

For English UI: use **Capabilities and limits**, **More → Background tasks → Background research**, **Memory → Find memories by meaning**, **Save as my method** in a completed task, and **More → Artifacts**. Public methods require full-text approval of the current version. Background research keeps a bounded, task-specific scope and needs explicit continuation after restart. Semantic preparation is an explicit local action with honest keyword/partial fallbacks. QQ queue commands are `/queue`, `/cancel-queue`, `/resume-queue`; QQ `/stop` disables the channel. Artifact continuation stages a draft for you to send; PDF export preserves source text, including Markdown syntax. None of these source capabilities alone proves a daily installation, live provider, live QQ account, signing or distribution acceptance.

## 本机 macOS 安装与数据

已安装应用位于 `~/Applications/DeskPet Electron.app`，日常数据固定保存在
`~/Library/Application Support/DeskPet Electron`。已安装版本不会使用开发版的
`DESKPET_E2E_USER_DATA` 临时目录覆盖。

本机更新前先退出 DeskPet，再运行 `./script/build_and_run.sh`。此入口使用已有的
Minecraft 打包资源，不准备、更新、启动或测试 Minecraft。安装时校验 `.app`
签名和内部链接，旧应用保留在 `~/Library/Application Support/DeskPet Backups`。
在 macOS 上执行 `npm run release:prepare` 会构建独立标识的验证候选版，检查签名与包内容、冒烟运行包内 Minecraft helper，再生成本地 ZIP 和 SHA-256 清单。产物目录位于 `out/make/zip/darwin/`。安装日常版仍需单独操作。

默认使用 ad hoc 签名，代码变化会改变签名标识要求。若钥匙串里已有可用的签名身份，可用环境变量 `DESKPET_MAC_SIGN_IDENTITY` 指定其名字或指纹；候选及日常构建都会检查所选签名，失败即退出。这条候选命令不进行 Apple 公证。

默认路径的日常升级通过签名和数据检查后，只保留最近三份由本版安装器标记完成的升级备份。迁移备份、自定义检查点和旧版未登记的目录单独保留。

一次性迁移已关闭的开发版数据时，可向该脚本传入
`--source-profile=/absolute/path/to/profile`。安装器先保留完整源数据副本和原目标
目录，再逐文件校验后切换；不会删除原开发版目录。首次启动新 `.app` 时，macOS
可能要求用户亲自在钥匙串弹窗中允许读取原来的加密配置。

在「设置 → 通用」启用开机启动。界面读取系统实际登录项状态；若显示需要授权，
点击「打开系统登录项」完成授权。开发版不注册其通用 Electron 可执行文件。
聊天使用本机 Ollama 时，Ollama 服务及所选模型也需要在本机可用。

在「设置 → 隐私与数据」创建加密备份：输入至少 12 字符的密码，再确认一次密码，
选择数据目录之外的保存位置。备份包含聊天、记忆、任务、配置、服务凭据和已导入
的 Live2D 资源，整体使用密码派生密钥和 AES-256-GCM 加密。密码不会被保存，
也无法找回；请将密码与备份分别妥善保管。Ollama 的大模型权重不包含在备份中。

恢复时输入原备份密码，点击「恢复备份」，选择文件并确认替换。校验通过后点击
「重启并恢复」。密码错误、文件被篡改或格式不支持时不会替换当前数据。恢复在
服务加载前应用；恢复前数据保留在固定数据目录的 `recovery/<操作 ID>/previous`
中，中途退出造成的未完成切换会在下次启动回滚。这些本机副本包含设备钥匙串
保护的数据；便携恢复请使用导出的加密备份文件。Live2D 资源仍受各自授权约束。

每次本机升级也会逐文件校验并保留最新资料快照。若主资料或设置损坏，启动时会
进入独立恢复界面，可选择这些快照或密码加密备份；不会把隔离的旧资料当成新安装。
截断的事件日志会保留有效前缀和完整原文件，并记录一次修复事件。

聊天生成时约每秒保存一次片段；正常退出会取消生成并等待保存，异常中断后重开会
将遗留回复标为中断，点击「重试」会重新回答原问题并保留原问题所在的对话。
极端崩溃仍可能丢失尚未保存的末尾片段。本机模型首次等待最多三分钟，流式传输
空闲超时为一分钟；正常持续输出不再受一分钟总时限限制。

聊天输入框下方可选择当前服务，选择会跨重开保留。在 Provider 设置中可编辑
已有配置、启停服务、刷新模型或选择当前聊天服务；编辑时密钥留空会保留原密钥。
定时任务支持修改标题与间隔、暂停/恢复、立即运行和确认删除；只改标题不会
推迟原定执行时间。


### Stream, model and timer recovery

Ordinary interactive chats accept additional requirements while a reply is running.
Send the addition from the same composer; **Stop** remains a separate control.
The app saves additions before applying them at the next model/tool boundary.
Already-running operations may have started; additions do not undo completed work.
Each run accepts up to eight additions, 8,000 characters each and 32,000 in total.
Retry includes the original question and its saved additions.

When a tool needs permission, the chat displays its operation and input with
**Allow once**, **Deny** and, for repeatable data access, **Allow for this task**.
Neither creates a reusable permission; a task-long approval ends with the task or
a new addition. Reloading the window restores a pending request; cancel, expiry,
permission changes and a new addition invalidate the old request. Unattended jobs
continue to require their existing grants.

With a model not confirmed to run locally, reading a local file or system summary
always needs this approval, even with a saved grant, and the card names the
recipient. Approving sends that result to that exact service and model only. The
conversation stays marked local-only: it cannot use web tools, other models and
chat channels do not receive it, and switching models or restarting the app hides
that history from non-local models again.

Schema errors and selected read/network failures can return safe error codes to
the model: up to eight corrections per run and two per identical call. Cancellation,
authority loss, blocked web targets, workspace-boundary violations and uncertain
writes still stop execution. A chat that reaches its 24-step limit makes one
tool-free request to report progress, and replying "continue" carries on. Scheduled
runs still fail at that limit rather than record unfinished work as a success.

Without a configured output limit, requests allow 4,096 output tokens, reduced to
a quarter of a small confirmed context window; the setting accepts up to 32,768.
Reaching the limit ends the turn with the received text preserved.
Saved-memory recall filters unrelated facts and combines lexical matches with a
small set of approved, stable communication preferences. **Memory → Find memories
by meaning** explicitly prepares local semantic matches for the selected query
and conversation; ordinary chat uses ready matches without dispatching embeddings.
Missing or busy local embeddings fall back to keywords, and partial semantic
coverage is labeled. Memory edits, deletion and scope changes invalidate reuse.
Inference queues are separated by service origin, with foreground priority within
each origin. The chat shows preparation, queueing, tool and approval states, and
coalesces streamed text every 40 ms with an immediate final flush.

运行时可在同一输入框发送补充要求，停止按钮单独保留。补充先落盘，再在下一步采用；
已开始或已完成的操作不会被撤回。工具需要权限时，聊天内显示本次操作及参数，
可选「仅允许这一次」「本次任务内都允许」或拒绝；这些都不会增加永久权限，任务内允许在
任务结束或补充新要求后失效。使用未确认在本机运行的模型时，读取本地文件或系统信息即使
已有长期授权也要确认，卡片会写明接收方；批准后内容只发给该服务和模型，对话仍标记为
仅本地，不能再联网，切换模型或重启应用后云端模型看不到这段历史。

读取和网络错误每个任务最多交给模型修正 8 次，相同调用最多 2 次。聊天达到 24 步上限时，
会再发一次不带工具的请求汇报进度，回复“继续”可以接着做；定时任务达到上限仍记为失败。
未设置输出上限时默认 4096 token，上下文窗口较小时取其四分之一，最高可设为 32768。
记忆召回会过滤不相关内容，等待状态和流式显示也会及时更新。

- A stream needs an explicit completion marker or finish reason. Premature EOF keeps received text, marks the reply failed, and offers Retry. A truncated tool call is never executed. Token-limit/filter truncation is shown separately.
- A newly imported Live2D model is committed only after the overlay loads it. Failure (including a 30-second loading deadline) removes staging and restores the previous model, scale and expression. The Companion page also offers Cancel import.
- Chat timers save absolute deadlines in the encrypted profile before creation succeeds. Pending timers resume after restart; timers that expired offline are delivered on reopening. Schedules shows pending/completed/cancelled timers and lets you cancel a pending timer. Existing version-one profiles default to no timers.
- Notification handoff and the completion-file commit cannot be one atomic transaction: a crash between those two operations may repeat a reminder. Completed timers are otherwise not replayed.

Tool effects use the assistant message, model turn and call position as their execution identity. Independent messages execute independently even when providers reuse call IDs; retrying the same reply reuses completed effects only when the tool and canonical input match. Changed retry parameters stop with a specific conflict message. Permissions, arguments, unknown tools, workspace access and network failures have localized guidance; permission failures link to the permission settings. Timer results include an explicit local deadline and IANA time zone, and the timer list displays the same time format. A persisted confirmation card renders the actual timer result in chat even if the model returns no text; the model does not need to recalculate or repeat its deadline.

Providers receive readable function names such as `web_read`, with collision disambiguation when required. Declarations, assistant history and incoming calls use the same exact mapping; unknown tool names still fail explicitly.

For tool-enabled Ollama conversations, complete Chinese commands such as `现在几点？` and `两分钟后提醒我喝水` can use the direct command path. It proposes a tool call to the same runtime, so permissions, validation, effect identities, persisted timer receipts and retries still apply. Confirmation comes from the actual result. Unrecognized, conditional, compound, quoted or ambiguous requests use the configured reasoning model. A preceding general conversation also uses the model, preserving contextual instructions; direct routing is limited to new conversations or a sequence of independently recognized commands. Model choice, thinking settings and context limits are unchanged.

A standalone command explicitly annotated `（仅演示这句话）` is answered by the model with tools disabled for that turn; an invented tool call is also blocked before execution. Quoted timer names must be copied exactly. System summaries distinguish kernel version, logical processors and unused physical memory so the model does not mistake those for the OS product version or memory pressure.

`web.read` defaults to readable HTML text with titles, headings, links, table cells, code and JSON-LD. It does not summarize or truncate that text. `format: "html"` returns the original source when markup, styles or scripts matter; plain text and JSON are unchanged. The same bounded HTTPS reader and target checks run for either format. Model/tool duration metadata contains no prompts or reasoning text.

The separate real-model tool evaluation is opt-in and uses a disposable profile, test workspace files and intercepted notifications. It records tool selection, arguments, returned results and actual effects separately. Run with `DESKPET_TOOL_EVAL=1 npx playwright test --config playwright.tools.config.ts --output <dedicated-output-directory>` after building. Its behavioral failures are findings, not a passing model certification.

The evaluation distinguishes deterministic direct commands from real-model decisions and includes conditional actions, multiple timers, arithmetic, context recall, raw HTML and restraint. Request timing and token counts separate model latency from execution. `DESKPET_TOOL_CASES` selects comma-separated case IDs for diagnosis; a filtered run is not full acceptance. `DESKPET_TOOL_BASELINE=1` is only for comparing an older build without direct commands.

### Expanded everyday tools

The model can now use 11 built-in tools. New tools are `web.search`,
`workspace.list`, `workspace.search`, and `math.calculate`. They use the same
argument validation, permission checks, cancellation and execution records as
the existing tools; search requests use the reasoning model, without a direct
command shortcut.

- **Web search / 网页搜索:** searches Bing public HTML with keywords, returning up to
  ten titles, HTTPS links and excerpts. Only the query is sent to Bing; it has
  its own `web.search` permission. Use `web.read` to verify a source page. This
  requires no additional API key, but public search availability and page layout
  can change. Challenges or unrecognized pages report search unavailable rather
  than an empty result. It is not a guaranteed search API.
- **Workspace browsing and text search / 工作区浏览与搜索:** list a directory or find
  literal text with paths, line numbers and excerpts under `workspace.read`.
  Search skips hidden entries, symlinks, dependency/build output, binary files
  and files over 1 MiB. It scans at most 2,000 entries and 8 MiB, reports skipped
  files and truncation, and does not claim a complete disk search. Files stay
  inside DeskPet's existing workspace directory.
- **Calculator / 计算器:** evaluates numbers, parentheses, `+ - * / ^` and `%`
  (remainder), including scientific notation. It does not execute code. Results
  use double precision, so decimal arithmetic may be approximate. It has a
  local `math.calculate` permission.

In Settings → Permissions, allow web search and page reading to use “搜索相关
资料，再读原网页核实并给出处”. For local files, allow workspace reading; for
arithmetic, allow the calculator. The permission list explains each capability
in Chinese and English.

Chat expressions now react to emotional cues in the user message and streamed
reply, stay visible while the reply is being generated, and fade six seconds
after it finishes. Cancellation or failure clears the temporary face. The
latest reaction received during model loading is applied after the saved
expression, so a saved Watermark or outfit choice remains intact. This is a
local text heuristic, not an additional model call or emotion-understanding
guarantee.

## Chat tasks, history and recurring work / 聊天任务、历史回查与周期任务

A chat can search public sources, read the actual pages, compare supported claims and save a `.md`, `.txt`, `.csv` or `.json` file in the DeskPet workspace. Its reply stays in the originating conversation, including when you switch pages. Open **Tasks, history & schedules / 任务、历史与定时** below the conversation to inspect the saved plan, working notes, next step, pages actually read and files actually written. Recorded files can be previewed, revealed in Finder or selected for a continuation draft. **Artifacts / 成果** provides a searchable catalog across conversations and local Markdown, CSV and PDF previews. Text files in Markdown, TXT or CSV format can be exported to a separate PDF preserving their text. If a file changed, the app asks you to inspect the current file rather than claiming the saved version still matches. A source receipt means the page was read, not that every claim on it is true.

For example: “查三篇官方资料，核对异同，写成 reports/comparison.md，列出来源和仍不确定的地方。” / “Find three official sources, compare their claims, and save reports/comparison.md with citations and unresolved questions.” You can add instructions while it runs. The bounded tool loop allows up to 24 model steps; a failed or interrupted task retains its notes, and you can ask to continue in its original conversation. The app does not automatically replay unfinished file operations after restart.

Ask “继续上次的比较报告，先回查当时的结论” / “Continue the earlier comparison; first look up its conclusion.” The model can retrieve literal, paginated old messages with source identifiers; the panel also provides a manual search and a link back to the original chat. Privacy and memory-scope filters still apply. Correcting or deleting a source invalidates its derived history references for future recall; unverified legacy messages may be excluded rather than guessed from.

To create recurring work, ask “每天北京时间 9 点查询官方更新，写成 reports/daily.md，把结果发回这里” / “Every day at 09:00 Asia/Shanghai, check the official updates, save reports/daily.md and report back here.” Before approval, inspect the instruction, numeric five-field cron expression, IANA time zone, missed-run policy and allowed tools. **Confirm recurring settings** saves that specific recurring scope until paused or cancelled. Future runs use the captured provider/model and return to the original chat. They can use only the reviewed public web, arithmetic/time and workspace-write tools; they cannot read private files, modify memory or create further cron tasks. Ask in chat to list, change, pause, resume or cancel schedules; the panel also provides controls. Resuming a stale card is rejected if its reviewed revision or tool scope changed.

DeskPet must be running for these schedules to execute. There is no system cron entry or always-running daemon. Choose skip or one catch-up run for missed times; uncertain runs interrupted by shutdown are recorded without blindly replaying them. Revoking a tool capability pauses affected schedules and interrupts their running work. Cron supports numeric lists, ranges and steps, with one-minute precision; daylight-saving gaps are skipped and a repeated wall time runs only once. Task and cron records are additive fields in the existing encrypted version-one profile and its backups. Limits are 1,000 task records, 200 recurring schedules, 10,000 recurring execution records, and 40 source/file receipts per task (receipt truncation is labelled).
