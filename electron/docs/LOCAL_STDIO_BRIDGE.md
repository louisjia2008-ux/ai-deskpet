# 连接已审阅的本机 Node MCP 工具

在 macOS 的 `electron/` 目录运行：

```sh
npm run mcp:stdio -- /absolute/path/to/reviewed-package dist/server.js
```

第一个参数必须是专用于此服务的目录，第二个参数是其中的 JavaScript 入口。服务必须已安装并审阅，包含 `package.json` 和自包含的纯 JavaScript 依赖。桥不会从网上下载包、运行安装脚本或执行服务在清单中声明的命令。

启动后，终端只显示临时清单的磁盘路径。在桌面的「技能与 MCP 服务」中选择「导入本机受限 stdio 桥」，选择其中的 `bridge.json`，核对服务名后导入，再启用。每次工具调用仍在桌面审阅。保持终端运行；结束时按 Ctrl-C。重新启动会生成新端口和新清单，旧连接不再有效。

桥先将服务的可用源码与 JSON 复制到私有临时目录，跳过隐藏项和可识别的凭据文件；源码树内的符号链接和硬链接不会作为模块载入。包目录不可选取家目录、应用目录、OS 目录或当前 DeskPet 项目。不要把私人资料放在服务源码目录。支持读取服务自己的快照，不能写入项目、访问家目录、调用系统命令、联网或获取宿主的环境变量密钥。需要第三方原生扩展、网络、真实凭据、写磁盘或另起进程的工具不适用。

需要已安装的 macOS `sandbox-exec` 和 Node 22+，支持 Homebrew 的常规安装及 `/usr/local/bin/node`。每次启动先用固定探针检查内核是否确实拒绝访问快照外文件、写入、启动其他程序和 TCP 连接。检查失败会退出。实际服务另启用 Node 文件权限、禁加载原生 addon 和 V8 堆上限。该上限不是整个进程的硬性内存配额。

传输使用 [MCP 标准 stdio 和 Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。一个本机客户端会话对应一个新子进程，支持初始化、工具列表与调用、ping 和关闭。仅启用 tools；不支持服务器发起的采样、用户输入请求、SSE 订阅或请求重放。每次请求、回复大小、会话空闲时间与总寿命均有限制。未知结果不会自动重试。
