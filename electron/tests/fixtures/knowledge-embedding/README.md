这 40 篇 Markdown 和 30 条检索问题均为合成材料。每条问题指定一篇相关笔记，其他同主题笔记作为候选干扰项。部分笔记中英混写，问题尽量使用与标题不同的表达。

在 Electron 项目目录，用 Ollama 安装列表中的三个模型，然后确认 `ollama ps` 无常驻模型。使用 Homebrew Node 执行：

```sh
DESKPET_KNOWLEDGE_BENCHMARK=1 npm test -- tests/unit/knowledge-embedding-benchmark.test.ts
```

测量脚本使用随应用发布的加密索引写入流程，保存其文档向量副本计算全排名 MRR。索引耗时包含模型加载、向量计算、加密和写盘。索引期间每 100 毫秒采样 Ollama 服务和各 runner 的合计进程 RSS。再用一条合成笔记把同一模型多保留两秒，读取 Ollama 报告的 runner 总内存和 GPU 分配。进程 RSS 和 GPU 驱动的内存记账方式不同。脚本不会加载第二个模型，发现 Ollama 有其他活动模型时会停止。
