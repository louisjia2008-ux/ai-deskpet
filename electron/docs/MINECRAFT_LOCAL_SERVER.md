# Minecraft 本地服与测试服

日常使用从控制台「设置 → Minecraft」启动本机专用服。首次启动会提示确认 EULA。应用检查 Java、Minecraft 服务端与 Fabric 依赖的版本和校验值，并在资料根下管理单独的世界及备份。连接到此世界的机器人使用 Core 引擎。

## 开发测试

在 `electron/` 运行以下命令，将测试用 Java 21 和官方 Minecraft Java 版 1.21.8 下载到单独的目录。安装脚本会校验发行文件，不修改系统 Java 和 shell 配置。

```sh
npm run setup:minecraft:local -- --root /absolute/path/to/test-runtime
npm run test:minecraft:setup
npm run test:minecraft-companion
```

法杖回归使用 `minecraft-mod/test-harness/`。为测试服单独建立目录和世界，配置离线测试账号和回环地址。测试脚本读取 `DESKPET_TEST_SERVER_DIR` 指定的服务器，需要专用测试标记、回环地址和独立 RCON 配置。

如需在隔离的应用中验证本地专用服，使用 `--deskpet-isolated-profile` 以及对应的测试资料标记。旧引擎的钻石、岩浆和家具住宅专项测试留在 [历史验证记录](MINECRAFT_REAL_VALIDATION.md)。
