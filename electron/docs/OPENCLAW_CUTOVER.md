# 从 OpenClaw 切换到 DeskPet

先并行使用两周。两边用各自独立的 Telegram 机器人；这台 Mac 是否放入新的真实凭据，由你另行决定。两周从你实际开始并行使用时算起。用同一批回归题比较答案和工具操作，另外记下日常真实发生的漏投、重复投递、权限误放和重启后中断。测试通知与日常通知使用不同目标，或仅在桌面查看 DeskPet 结果。

## 切换前的只读盘点

在本仓库的 `electron/` 目录运行，两个路径均由你指定：

```sh
node scripts/openclaw-cutover-inventory.mjs --config '/path/to/openclaw.json' --jobs '/path/to/jobs.json'
```

命令只读取这两个普通文件，单个文件上限为 8 MiB。它不发现配置目录、不展开环境变量、不加载外部 `$include`，也不会启动 OpenClaw。标准 JSON 可直接读取；带注释、单引号、尾逗号的配置使用项目开发依赖里的 Acorn，仅接受数据字面量。不可解析时命令报固定错误，不回显内容或路径。

- `telegram.groupPolicy` 显示明确写入的通道策略。检查它与 `accounts.effectivePolicy.open`，任何 `open` 都需要核对群聊开放是否符合你的决定。显式账号策略优先，未写账号策略只继承通道根；未写或不能辨认的值记作 `unknown`。账号启用数仅统计明确写入的开关。[OpenClaw Telegram 账号策略](https://docs.openclaw.ai/channels/telegram)
- `jobs` 给出启用、停用、未知数，以及 `cron/at/every` 和 `none/announce/webhook` 的数量。它不输出任务或账号 ID、收件人、标题、提示词、时刻或凭据。未知布局不是空列表。输出是文件盘点，不能证明网关当前在线或近期已成功投递。

## 两周后逐项迁移

1. 在原系统的本地管理界面查看每个仍需保留的任务。在 DeskPet 中单独建立该任务，复核时区、触发时间、错过时的处理方式和允许的工具。对单次 `at`、固定间隔 `every`、webhook 等无对应行为的任务先保留原版，勿机械改写成五段 cron。
2. 先在受控的桌面会话验证一轮。重新确认本人配对、该任务的权限和具体投递目标；OpenClaw 的群策略、旧授权、token、通用 webhook 或收件人不会自动继承。
3. 选定一个交接时点。先暂停对应的 OpenClaw 任务，确认上一次投递已结束，再明确启用这一个 DeskPet 任务及其 Telegram 投递。核对下一个自然触发时刻、手机收到的一份结果和桌面运行记录。
4. 若漏发、重发或结果不符，先暂停 DeskPet 的这一项，核对手机与投递记录，再决定是否恢复 OpenClaw。其余任务保持逐项交接。若两周的真实使用、自然触发或回归尚未达到你的要求，继续并行，不做全量切换。
