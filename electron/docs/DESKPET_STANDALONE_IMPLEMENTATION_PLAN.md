# DeskPet Electron 独立运行实施计划

更新时间：2026-10-29。状态：**E-P1 至 E-P3 及工具边界已由用户接受；本轮推进 E-P4 手动、有来源、单批次记忆整理。工程、摘要忠实性与实际上下文收益分别验收，以本轮 REPORT/results/runtime-identity 为准。自动整理、P5、PAO 与通用 OS 沙箱继续暂停。**

本文是后续独立聊天、记忆、后台任务与受控委派的当前实施计划。产品目标为 **Electron**。本文完整替代旧 [原生实施计划](/private/tmp/deskpet/output/deskpet-p3-p4-20261026/DESKPET_STANDALONE_IMPLEMENTATION_PLAN.md) 作为后续实施依据，尤其修正其第 5、11、19–35 行对实施目录和 Swift 组件的选择前提。旧文全文仅作为不可变的原生历史记录保留，其通过状态不能继承为 Electron 已完成。

## 目标与约束

1. 在现有 Electron 产品内，让主聊天、必要上下文、可核对的长期记忆、无工具后台任务与少量受控子任务形成可用体验。
2. 沿用当前 `AppController`、领域服务、`DomainRepository`、TS `AgentRuntime`、`RuntimeScheduler`、Provider utility process、typed preload/IPC 和 React 页面。扩展已有实现，不从零搭建另一套应用或执行框架。
3. 原生 `/桌宠/DeskPet` 的修改、测试、真实模型样本与 GUI 证据完整保留；可复用契约、算法与测试材料，不能以原生通过结果替代 Electron 验收。停止原生扩展，尚未编译验证的配置对照草稿保持原样。
4. 不以复用代码为由强制引入 Swift AI 后端。当前 Electron 的 Swift migration helper 仅服务用户触发的一次性旧数据导入，保持窄职责；是否优化它的构建步骤须由独立问题驱动。
5. P5 新工具链扩展继续暂停。保留 Electron 已有工具、权限、Minecraft、桌宠和平台能力；本计划不默认重写或关闭它们。PAO、通用 DAG、递归自治、数据库替换不作为前置工程。
6. 不提交、不推送；保护现有 dirty state。功能实施按本轮明确授权边界继续，不能因为本轮上下文修复而默认开始后台 job、委派、整理或新工具。

## 2026-11-01 用户修订：用量费用记录、待处理与观察模式

用户要求取消预算设置，按累计用量查看 Token。用量服务仅记录请求及实报输入／输出 Token，不再以每日请求数、每日 Token 额度或委派的 Token 预算拒绝调用。用量页采用只读统计与请求记录，移除价格填写和预算表单。按用户后续补充保留累计实报 USD、累计估算 USD 和未知费用请求数；已有保存价格只读用于估算，不把缺失金额伪装为零或历史账单。旧 `usageBudget`、`usageRates` 及委派预算字段留在加密资料中用于兼容历史读取，不再作为经济额度执行；不抹除旧请求或虚构缺失 usage。

累计值仅累加已派发请求的已知实报部分，估算与未知另列；单次峰值只采用输入／输出均完整实报的请求。同一宿主 request ID 仅计一次，父批次分组不再次计入总量。保留提供商的单次上下文／输出能力检查，以及委派每批 1–3 个子任务、每子任务一次生成、隐私、取消、截止时间与未知派发恢复规则。下文早期的每日／委派 Token 预算描述仅为历史实现记录，以本节修订为准。

待处理中心从同一加密仓库聚合独立后台任务、委派父批次和记忆候选。标记绑定具体来源版本，仅从待处理列表收起，不改源任务、生成结果或启用记忆；来源更新后重新出现。提供今日、侧栏和托盘入口，显式跳转只读打开目标。

主动事件策略增加 `off / observe / auto`。缺少 mode 的旧配置仍按 enabled 映射，默认和个人原关闭状态保持关闭。观察模式只判断明确选择的应用事件和规则，记录原因，不创建 job/trigger、不调用模型、不发主动通知；观察事件不在切换 auto 后重放。沿用现有 tick、权限和三阶段自动执行复核，无新守护进程。观察日志最多200条，事件身份及频控元数据继续保留用于去重；旧备份不能回滚这些状态。

## 2026-10-27 本轮实施状态

本轮以当前 Electron 磁盘工作树的 738 个可见文件为增量基线，先走正常 `npm start` 建立源码、webpack 产物与运行实例身份，再沿 renderer → 版本化 preload/IPC → `AppController`/领域服务 → provider utility process → 最终 HTTP 修复。运行时记录完整工作树构建输入摘要，不以 Git HEAD 代替未提交源码身份。最终 204 个构建输入的 SHA-256 为 `c4829e254bba9d6b509bd1afaebad96f88e24345353f5541e1519fec5acc397f`。

| 本轮范围 | 已完成与边界 |
| --- | --- |
| E0 开发启动与身份 | 正常 Forge 启动、合成 profile、main/utility 产物摘要、实际 PID/executable/profile、正常界面与重启持久化已核对；日常安装包未替换，安装包 GUI 未验收 |
| E-P0 请求策略 | 冻结实际 provider/model/配置；最终目的地隐私过滤、完整消息投影、统一 wire 预算与输出预留；每个工具轮次重新校验来源、隐私与预算；缺失 usage 保持 unknown |
| E-P1 必需的最小元数据 | 可选版本化 trust/origin/scope/privacy/revision/sourceReferences/sentCount/lastSentAt；旧缺失来源记录仍 unverified；分享/scope/标签调整保留原始聊天来源；本轮不宣称完整 E-P1 已完成 |
| 正常 Electron + 合成 HTTP | 最终源码重启实例实际捕获 14 次 generation HTTP，逐条与持久化回执 body hash 对上；隐私、scope、来源变更、首轮及工具后续轮预算、网络工具拒绝与 unknown usage 均有证据 |
| 正常 Electron + 真实本地模型 | 已有本机 Ollama `qwen3.5:0.8b` 完成 3 次真实 generation，经声明的透明回环记录代理逐字节转发；历史与记忆到达实际请求，usage 与原始 SSE 一致；本次跨会话记忆代号回答未达要求，质量未通过 |
| 离线验证 | 最终源码 507/507 unit、15/15 IPC security、typecheck、范围内 ESLint 通过；不是整个含 Minecraft 的 `npm run verify` 通过 |
| 当前与后续 | E-P1 与工具边界采用已接受冻结交付；E-P2 本轮验收另列；E-P3 采用已接受冻结交付；E-P4 本轮验收另列；自动整理、P5、PAO 继续暂停，不重跑旧模型矩阵 |

详细变更、真实失败、请求及记录链路、构建与保留证据见 [本轮 Electron 交付](/private/tmp/deskpet/output/deskpet-electron-context-20261026/ELECTRON_CONTEXT_DELIVERY.md)。此前 `976248…` 的候选验收单独保留；最后两行等价方法绑定 lint 修复后，最终源码重新构建、重启、重跑测试及关键 HTTP 场景，没有将旧候选身份替换成最终身份。

主动聊天旧入口没有可证明的个人上下文来源投影，本轮让它只使用公共 persona，并在界面说明不自动带入记忆、聊天历史或导入风格；没有关闭或开启用户的 proactive 配置。该安全降级是明确限制，不能写成个性化主动聊天已验收。

## 当前身份与正常启动路径

| 项目 | 本轮核实结果 |
| --- | --- |
| 实际仓库 | `/private/tmp/deskpet/personal-ai-deskpet-electron-work` |
| Electron 工程 / 命令 cwd | 仓库下 `electron/` |
| 当前分支 | `codex/minecraft-companion`，保留原有工作分支，不切换或重置 |
| 当前 HEAD | `4bb4f0e984aee839d799b4dec1a426958faad9b1`；不能表示全部工作区内容 |
| 工作区 | 纠偏只读轮为 700 条 status / 737 个文件；本轮实施基线为 701 条 status / 738 个 Electron 可见文件，保留各轮独立基线 |
| 开发入口 | 在 `electron/` 执行 `npm start`，即 `npm run build:migration && electron-forge start` |
| macOS 本地安装入口 | 在 `electron/` 执行 `./script/build_and_run.sh`；构建迁移 helper、Forge package、包审计、安装到用户 Applications，再打开安装包 |
| 已安装产品 | `~/Applications/DeskPet Electron.app`，bundle ID `com.deskpet.companion.electron` |
| 数据身份 | Electron 使用 `DeskPet Electron` userData，与原生 DeskPet 分离；不得让两端并发写同一 profile |

命令来自当前 [package.json](/private/tmp/deskpet/personal-ai-deskpet-electron-work/electron/package.json:22) 和 [build_and_run.sh](/private/tmp/deskpet/personal-ai-deskpet-electron-work/electron/script/build_and_run.sh:3)。纠偏只读轮没有执行；本轮正常运行了 `npm start`，并仅做输出到新目录的隔离 Forge package，没有运行安装脚本。安装脚本会替换已安装 App；若发现日常 profile 的 `SingletonLock`，会直接拒绝，要求先退出 App，并不会代为关闭当前实例。不能作为只读审查步骤执行。

纠偏只读轮发现主进程 PID 为 81010，安装包与工程旧 `out/DeskPet Electron-darwin-arm64/DeskPet Electron.app` 的 `app.asar` 均为 `9e2f21cf3cb71234a9db5a29a8d165ff228828c1154da73f29d1534a270dad26`。这些只证明当时两个旧 ASAR 相同，不能代表本轮最终源码。本轮身份见独立交付与正常启动证据，未替换日常安装。PID 均为当时观察值，不作为后续操作授权或固定身份。

## 沿用的实现与需要补齐的契约

| 现有接入点 | 已有实现 | 后续增量 |
| --- | --- | --- |
| `src/main/bootstrap.ts` / `app-controller.ts` | 正常启动、服务装配、窗口、退出、chat run 归属 | 在同一装配根接通持久 job 生命周期，统一退出协调 |
| `src/preload` / `shared` / `ipc-policy.ts` | 版本化窄 API、schema、窗口角色和 origin 校验 | 仅新增所需领域 API；renderer 只提交、订阅、显示，不持有执行器或凭据 |
| `domain/chat-service.ts` / `chat-context.ts` | 会话持久化、同会话 turn 串行、已完成历史、相关记忆、字符上限 | 最终 binding 的数据策略、token 预算、输出预留、来源及实际消费记录 |
| `domain/memory-service.ts` | 显式记住/修改/忘记、原子聊天回执、去重、候选 stale 保护 | 来源/版本/信任/owner/隐私、纠正与跨批次删除抑制，不破坏旧回执 |
| `DomainRepository` / encrypted persistence | schema 校验、串行事务、保存成功后发布内存状态 | 兼容迁移和 typed job/receipt；优先扩展现有存储，不另设 UI 权威库 |
| `runtime/agent-runtime.ts` / `scheduler.ts` / `task-event-stream.ts` | 受限 loop、权限、取消、排程、事件日志 | 持久接收、attempt、稳定绑定、恢复、预算、执行与质量状态分离 |
| `providers/utility-client.ts` / `utility/entry.ts` / adapter | 真实 HTTP 隔离到 utility process、streaming、超时、取消、截断检测 | 全链路预算参数、请求准入、前台优先、取消后的 transport 生命周期确认 |
| `ConversationImportService` / `ConversationImports.tsx` | 选择说话人与消息、无工具蒸馏、来源 ID 检查、草稿、人审、原子 apply、防重复应用 | 可复用的 sourced candidate 提交流程、稳定批次/来源版本/撤销、checkpoint 与回执恢复 |

当前 Ollama 也通过 Electron 的 OpenAI-compatible `POST <base>/chat/completions` SSE 路径。不能照搬 Swift `/api/chat` 的参数或假定服务支持相同 schema。新增参数必须同时穿过 renderer 所需输入、main、utility schema、adapter，到最终 HTTP，并按 provider 能力验证。

## 分阶段实施及退出条件

下列 E-P0…E-P4 是 Electron 阶段，与旧原生 P0…P4 语义相对应。本轮仅完成上表注明的请求策略和必需最小元数据边界；没有整体宣布全部阶段通过。每阶段先读当前差异、明确兼容迁移，再做该阶段必要实现。禁止先复制所有 Swift 类型再寻找用途。

### E0：冻结正常 Electron 路径

目录、分支、源码装配与旧安装包的只读核对已保留。本轮另在正常 Forge 启动路径完成合成 profile 的基线与最终验收，保留普通生产装配；测试配置只隔离数据与 provider，没有引入第二个 runtime。正常重启后 provider、记忆、session、message 与回执内容一致，会话权限已清除。验证实例在空闲后只停止自己创建的进程组；本轮不声称观测到 AppKit 正常菜单退出。

当前 [bootstrap.ts:14](/private/tmp/deskpet/personal-ai-deskpet-electron-work/electron/src/main/bootstrap.ts:14) 只在非 packaged 模式接受绝对路径 `DESKPET_E2E_USER_DATA`。开发验收可沿用它；安装包验收则在专用 macOS 测试用户及其合成 profile 中走正常安装/打开流程。没有该隔离条件时，安装包合成流程记为未运行，不把环境变量当成已生效，也不把合成资料迁入日常 profile。安装器的 `--source-profile` 是真实 profile 切换工具，不能用于伪装测试隔离。

退出条件：记录源码 manifest、构建日志、bundle/ASAR hash、实际 PID/executable/profile；验证 `npm start` 的 Console/overlay、聊天、记忆、任务和 provider 基本路径；再按正常本地安装路径验证安装包。没有源码到构建产物的身份链，不把当前已运行旧 App 当作新功能验收。

### E-P0：真实聊天上下文与 Provider 请求预算

保留本会话已完成历史、相关记忆及现有 untrusted-reference 指令。扩展 `buildChatContext` 与 typed provider 请求，对实际 endpoint/binding 执行隐私与 scope 判断；为固定提示、消息、记忆、工具 schema 与输出预留统一预算。现有 24,000/6,000 字符上限是已有防线，不能称为 token 预算。

只对必要字段扩展 `ProviderChatRequest` 和严格 utility 协议。确定未知容量策略、能力不支持时的明确拒绝/降级及使用量缺失状态；不把缺失 usage 记为 0。冻结每次发送的 provider/model/配置身份，后续默认选择变化不影响当前 turn。

退出条件：从正常 Electron chat 输入捕获最终 HTTP，证明必需前轮事实与允许记忆到达；受限资料在不允许的目的地不会发送；取消显示 `cancelled`，超时、断流和 `length` 显示 `failed` 并保留错误原因。真实本地和真实云端覆盖分别记录。

### E-P1：记忆来源、纠正、删除与可检查的提交

以现有 `saveFromChat`、`editFromChat`、`forgetFromChat`、选择卡片和 `DomainRepository.transaction` 为基础。兼容扩展来源事件引用、来源 revision、稳定实体 key、scope/owner、有效/待确认/待复核/撤销状态、隐私及 mutation receipt。宿主用户行为、原始事实、模型候选、风格样本分别建模。

保留当前同消息重试防复活、候选 text/updatedAt stale 检查，以及导入 `savedMemoryId` 的永久应用标记，防止重复应用覆盖后续编辑或复活后续删除。新增跨新批次、再次导入和备份恢复的 tombstone/suppression，明确与仅删除当前行的区别。旧条目缺失来源字段时标记 unknown 并提供审阅路径；迁移先预览，不静默提权为已验证，也不无提示删除旧用户数据。

退出条件：Electron 正常聊天显式记住并返回真实提交回执；新会话请求带入允许记忆；修改沿用稳定身份并使旧值失效；忘记后新会话、旧卡片重试、新整理批次及恢复不能复活；多义请求继续要求选择。普通叙述不会冒充显式长期记忆授权。原生 canonical-key 行为在移植前不视为 Electron 已有能力。

### E-P2：同一 Electron 运行时中的无工具后台文本 job

本轮范围固定为用户显式提交的文本任务；每个 job 一个宿主 attempt ID、最多一次生成，无自动重试。Console“后台文本任务”选择既有 provider/model，预览指令、粘贴材料和隐私后提交；任务结果只在固定结果区显式查看。离开页面、切换聊天、renderer reload、隐藏窗口不取消；退出 App 结束进程，没有守护进程或断点续传。前台聊天独立可提交并完成。

`BackgroundJobService` 使用现有 `DomainRepository` 的同一加密 profile/串行原子事务。profileId/jobId/attemptId/resultOwner/执行 host ID 分开，renderer 只能提交严格字段。不可变输入快照、显式粘贴来源、privacy、冻结 provider/model/endpoint/预算/binding digest/credential reference、状态、取消意图、request 观察与幂等回执同属权威记录。相同 operation ID/相同内容复用，异内容拒绝；新的明确运行使用新 job。前台写入与后台提交都从 transaction 内的新状态开始，禁止旧 profile 快照覆盖。

状态为 queued → dispatching → running → succeeded/failed/cancelled/interrupted/blocked。queued 有可信未派发证据，重启可重新核对准入；dispatching 的持久意图表示 HTTP 可能已发送，不证明实际发送。遗留 dispatching/running 在新进程标为 interrupted/result unknown，不能自动重发。终态直接复用结果。旧备份中的任何非终态 job 恢复为 interrupted/job.restoredUnknown，不能用备份回滚获得新派发授权。提交确认不确定沿用 repository.commitUncertain，先回读权威，再复用原 operation，不在未知期间派发或发布成功。

provider service 的单容量 admission 让下一可用容量优先前台；job service 仅一个 worker 执行持久 queued 记录，不新增通用队列平台。准入后重新检查凭据/配置/取消，并原子提交 attempt、执行 owner、预算与 dispatch-intent 后才能发送。job 的 executionMode=background-text 不声明 tools，wire tool_choice=none；宿主拒绝任何结构化 tool_calls/function_call，禁止工具执行器、续轮及重新询问。全链路复用 provider utility、最终 wire 预算、first-response/idle timeout，另有 180 秒宿主总期限。usage 缺失维持 unknown。

取消与结果按 repository 持久提交顺序裁决：cancel 先提交，迟到结果不得成功；success 先提交，后到 cancel 返回已完成。取消只针对目标请求，utility transport 清理等待 complete/error 或实际进程退出确认；2 秒仍未知则 generation 失败关闭，直到该 utility 真正退出，不能换进程盲目重做。该确认只表示本地 transport 收尾，远端执行/计费未知。晚到观察可以保留 usage，不发布业务结果。存储未知、旧 attempt/owner、已撤回 credential reference 或不再允许的隐私目的地均不能发布结果。

验收锚点：`/private/tmp/deskpet/output/deskpet-electron-ep2-20261028`。正常 npm start、renderer/preload/IPC/TS/utility/受控 HTTP、持久结果重启、真实进程中断、取消竞争、确认丢失/未知和临时副本已知错误对照分别记录。16 次冻结模型实验仅引用历史交付，不重跑。本轮不宣称回答质量、agent 集群隔离或任意代码 OS 沙箱。

### E-P3：主聊天中的受控 child 委派与独立结果检查

使用主聊天“委派文本任务”按钮，或真实用户提交的明确 `委派文本任务：目标`（也接受ASCII冒号）进入同一宿主草稿；不扫描模型回答、工具结果或材料，不自动规划／拆分。用户审阅1–3个child各自的指令、明确粘贴材料、privacy、provider/model及检查规则后显式提交。binding初始为空，不能回退到主聊天模型。当前只支持粘贴材料，标为用户提供；未实现聊天消息片段选择，不虚构来源。

父批次／意图／child关系扩展同一加密profile，业务owner与执行owner分开。每child仍是E-P2无工具job，一个attempt、最多一次生成，无重试；host生成batch/child/job/session标识并在最终读写处双向验证。请求只包含自身指令、已确认规则与自身材料，不继承父聊天、记忆、兄弟输出或工具。主聊天、独立job与child共用原provider单容量准入，前台取下一空闲槽位，后台worker仍同时一个。

草稿验证、父批次、最多三个child、冻结binding与合计预留在一个repository事务内接受；任何非法字段／预算不足均整体拒绝。同operation/content复用，异内容拒绝；失败和取消仍占原child名额，不提供批次内补建。预算只覆盖children，记录保守byte-based输入估算加输出预留及请求槽位；已结算计数加未结算预留不超过准入额，未派发有证明才释放。usage未知／可能已发保留预留；报告超过预留则保留原预留、单列报告值并阻止后续派发，不能宣传成供应商账单硬上限。

父绝对deadline冻结，排队计时，每child不晚于父deadline。实际utility派发前等待repository的当前提交完成／权威恢复，再同步检查当前凭据、父目标版本／取消／deadline／预算和transport状态；不能因为rename已发布而确认未返回，使用旧内存启动新请求。原始取消确认延迟反例及修复后受控顺序分别保留。

普通聊天、查看状态、未发送输入编辑、其他child完成与遥测不改变意图版本。明确“替换委派目标”持久化历史标记并取消未完成工作，生成新版本待确认草稿；不改写运行中指令或自动提交。父取消按同一权威提交顺序生效：先前成功结果保留，迟到结果不能成功；单child取消不影响兄弟或主聊天。父状态从child状态与控制标记归约，执行结束不等于质量通过。

沿用E-P2恢复：终态复用；可能已发中断／未知且不重发；未派发仅在父当前、未取消／过期、预算和凭据允许时恢复。旧备份非终态父历史化／delegation.restoredUnknown，child中断，不能补建绕过禁止重派；commitUncertain先恢复原权威。App退出不保活生成，没有守护进程。

结果卡分列执行、逐项要求检查、事实未核验。支持全文精确比较（仅NFC与CRLF→LF，不trim/大小写折叠）及英文词数闭区间（ASCII字母串，内部apostrophe/curly apostrophe/hyphen算一词，代码和markup文本也计数）；其他要求unchecked。检查同一持久正文，事实始终unverified，不相信模型自述。原17/26词固定失败材料离线复用。正文、实际词数和任意原始finish reason仅显式结果读后展示；列表／全局事件IPC／普通JSONL仅有限安全原因，原始完成原因保留在加密请求回执。空输出、截断、工具请求按实际失败标记。

本轮交付锚点：`/private/tmp/deskpet/output/deskpet-electron-ep3-20261028`。正常npm start与最终Electron E2E、实际受控HTTP、新进程持久状态、父级取消／到期真实中断、有效临时副本预算错误对照分别记录；可选双本地真实冒烟最多两次，另列执行与质量，不重跑16模型矩阵。P4整理、P5、PAO、递归委派与通用OS沙箱不在本轮。

### E-P4：有来源的候选整理、手动单批与收益验证

没有持久会话时，用户可点“开始整理审阅”，只通过现有宿主接口创建审阅会话，不先发聊天或生成。

本轮实现以 `consolidation-service.ts` / `consolidation-state.ts` 和现有 Memory 页新“手动整理”标签为入口。宿主从当前 profile 的有效、已确认、有稳定来源的记忆冻结整个正文范围、semantic revision、内容及权限指纹、每来源表示选择版本；先冻结实际 binding 再做隐私过滤。只允许明确选入最多20条，不扫描个人历史。

预览只保存 draft；显式生成一次，在同一权威事务创建该批次唯一 E-P2 无工具 job，继续使用同一预算、准入、provider utility、凭据引用、取消及中断恢复。严格解析一次完整 JSON：segments/text/sourceIds、整条记录覆盖清单、未覆盖清单及冲突。失败、截断、工具调用或非法引用保持失败，无自动修复／重试。

候选默认不检索、不发送。编辑只改变候选版本，不能新建事实证据；用户必须对保存的那个版本逐项核对并显式确认，启用表示另行勾选、默认关闭。apply 同一事务检查全部相关来源和每来源选择版本，并保存表示选择及幂等回执。不同批次竞争不依赖整个 profile revision；旧基线不能覆盖先确认者。历史回执复用不会重新激活摘要。

来源纠正、删除、权限变化或原始来源不可用时，共享 repository 事务使整批失效、撤销选择，并清除该批来源正文／标签、候选及关联 job 的材料／结果派生副本；保留 ID/指纹/必要回执。发送前和结果发布时也重新检查依赖。来源未知、待复核或被删除的内容不能通过整理升级。原事实 revision、来源数、证据数和导入游标不因整理变化。

原文仍是检索依据；检索后按完整覆盖范围选择一种表示。仅完整、无冲突、当前全部依赖仍在所选范围、选择关系有效的已启用候选可替代；部分覆盖、重叠无法安全替代、依赖不符或完整请求预算不足时保留当前有效原文。生产路径另有 UTF-8 完整记忆包装的保守字节收益门槛，这不是精确 token 测量或语义质量证明。上下文回执记录表示和回退原因；被预算省略的祖先回复仍传递表示依赖，最终发送递归核对传递来源，避免停用后经后续回复继续使用。停用只撤销选择，不回写旧事实。

恢复优先复用已保存的候选／终态和原 operation 回执；可能已发送的 job 不重发；commitUncertain 暂停变更与派发，先恢复权威。旧备份合并当前可读来源保护与同批权威回执，所有恢复的表示选择停用，非终态 job 中断，draft 不能重新派发。候选、job结果、apply回执均使用同一个加密 profile；没有第二个数据库或调度器。

### E-P4 有界摘要收尾（2026-10-29）

已接受E-P4工程与其摘要截断、忠实性／收益未成立结论保持封存。零调用对齐旧原始HTTP/SSE、单次usage与job回执，离线重放确认服务端length而非客户端拼接截断。新的本机Ollama无工具整理批次，在预览的binding.limits冻结reasoningEffort:none；旧批次／job缺失此字段继续原请求语义。仍使用1536输出、16384上下文、安全余量256、原提示／结构／四源；不能声称reasoning独立token数已知或这次修正必然有效。

新独立上限5次：一次摘要；仅在完整、逐源忠实性通过且正常产品选择器确实使用摘要后，D3/D4摘要各一次，再正常停用，D3/D4原文各一次。每题新会话、同参数，无evaluation override；任何槽失败占槽，无重试／换模型／借用旧额度。D3历史性措辞问题独立保留。成功失败均交付停止，下一重点仅列packaged GUI和安装候选入口／缺口，本轮不安装或启动下一阶段。

### 本轮固定表示诊断与调用上限

先盘点原生冻结候选；其失败和构建归属保持原样，不算 Electron 通过。四个固定合成案例分别覆盖事实／条件、偏好范围、纠正／时效、缺失信息与弃答，先冻结来源、候选生成提示、问题、答案依据、binding 和参数。不是独立保留集，不做提示搜索或模型切换。

本轮真实生成上限12次，摘要生成也计入。预登记采用一个既有本机27B binding，1次摘要 + 最多11次问答；D4原文加摘要组合预先不运行。先独立对照来源审阅摘要；失真或未形成候选时跳过对应摘要／双表示问答，不消耗剩余额度补跑。完整请求量分别报告实际 provider usage、保守估算、unknown；生成和失败开销另列。隔离 host 诊断可指定 original/summary/both，正式 IPC 不提供该开关；正常产品不双重注入。

工程流程、忠实性与上下文收益是三项独立结论。真实实验后若源码变化，保留其原构建身份，不扩充调用上限重测。历史16次矩阵与 E-P3 两次模型冒烟不重跑。本轮证据根：`/private/tmp/deskpet/output/deskpet-electron-ep4-20261029`。达到交付条件后停止 E-P4，不自动进入闲时／夜间整理、P5 或 PAO。

## 验收与证据格式

每阶段用同一源码/构建身份，分别记录：

| 层次 | 可证明内容 | 不能代替的内容 |
| --- | --- | --- |
| 静态审查 | handler、依赖、存储、协议和请求路径存在 | 构建通过、真实用户可用 |
| 离线测试 | 确定性状态机、schema、IPC、取消与恢复边界 | 真实模型质量与 GUI |
| 正常 Electron + fixture HTTP | renderer→preload→main→utility→持久化/最终 wire | 真实 provider 的能力、语义与耗时 |
| 正常 Electron + 真实 provider | 对应 binding 下实际输入、输出、usage、错误与质量 | 其他模型、云服务、平台或总体性能 |
| 正常安装包 GUI / 退出恢复 | 实际用户入口、界面状态、自己的测试进程与 profile 恢复 | Windows/Linux、签名、公发、长周期稳定性 |

现有 `npm run typecheck`、`npm test`、`npm run test:security`、Playwright Electron tests 和包审计可扩展。本轮已运行 typecheck、unit、IPC security、范围内 ESLint、正常 Forge GUI/HTTP 与隔离打包核对；具体退出状态见本轮交付。`npm run verify` 还包含 Minecraft 套件与打包，本轮没有整体执行，不将已有 Minecraft、Live2D 或原生测试计入本轮通过数。未来 GUI 验收继续使用正常启动装配，测试夹具只隔离合成资料；不得启动原生 App 来代替。

每次报告附工作区 manifest、源码差异范围、构建/ASAR/PID/profile 身份、最终请求与原始结果、持久回执/恢复证据。只导出合成必要字段，不导出 vault、凭据、个人聊天或完整用户 profile。

## 历史成果的处理

- [原生 P3/P4 工程记录](/private/tmp/deskpet/output/deskpet-p3-p4-20261026/P3_P4_DELIVERY.md) 与 [原生质量记录](/private/tmp/deskpet/output/deskpet-quality-20261026/QUALITY_DELIVERY.md) 保持原样。其任务契约、取消/恢复窗口、来源校验、质量三态、失败样本及测试 oracles 可按 TypeScript 接口移植。
- Swift actor/TaskLocal/MainActor、SwiftUI 布局、AppKit 退出钩子、原生 HTTP dialect 和现成测试二进制不能直接套入 Electron。需要在 Electron 的 utility/IPC/存储生命周期重新实现和验证对应语义。
- 本轮原生配置对照草稿尚未构建、测试或实际推理，标为暂停的未验证草稿。保留文件不等于产品交付。
- [本次纠偏审查与身份基线](/private/tmp/deskpet/output/deskpet-electron-realignment-20261026/ELECTRON_REALIGNMENT_AUDIT.md) 记录当前源码事实和保护校验；它也不宣称 Electron 新阶段已通过。
