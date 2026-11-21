# Minecraft 陪玩

在控制台打开「工具 → 陪玩」，为 Core 机器人填写 Java 版服务器的地址、端口和用户名。离线认证需要服务器允许离线账号。微软认证需要单独的 Java 版账号，应用会在连接期间显示登录地址和设备码。界面显示「已就绪」时，机器人已进入服务器。

游戏内只有配置的主人玩家可以通过以机器人名字开头的聊天发出指令。陪玩页可发出支持的任务并查看位置、生命、背包和任务状态。桌面聊天也可用现有的 Minecraft 权限执行支持的任务。取消任务后，机器人仍可执行保命动作。断开连接可退出服务器。

「设置 → Minecraft」可启动应用管理的本地专用服。首次需要确认 Minecraft EULA。应用会准备 Java 21、Minecraft 1.21.8、Fabric 和 DeskPet Mod，并让机器人连接本机专用服。使用勘测法杖创建和确认施工计划。操作细节见 [法杖与 Mod](../../docs/minecraft/SURVEY_WAND_AND_MOD_BODY.md)。

## 构建和测试

从 `electron/` 执行：

```sh
npm run test:minecraft-companion
npm run package
npm run smoke:minecraft-package
npm run audit:package
```

Forge 打包 `minecraft-companion-runtime` 和它的共享 Node 依赖。构建机有 Java 21 时还会构建专用服 Mod。机器人子进程运行在 Electron 自带的 Node，通信使用有界的 JSONL 消息。应用负责模型调用与权限，机器人进程无需访问模型密钥。

旧陪玩运行时的连接配置只随原进程存活，诊断、学习和账号缓存位于独立的旧资料子目录。Core 使用自己的目录和资料格式。旧运行时的 [历史验收记录](MINECRAFT_REAL_VALIDATION.md) 仍可查阅。

## Minecraft Companion

Open **Tools → Minecraft** to connect the Core bot to a Java Edition server. Enter the configured owner's player name to allow that player to address the bot in game chat. The Minecraft page shows the observed game state and available tasks. Use **Settings → Minecraft** to start a managed local world and use the DeskPet survey-wand Mod.

The Core process and server Mod ship under **AGPL-3.0-only**. See the [third-party notices](../../THIRD_PARTY_NOTICES.md) for source and dependency details.
