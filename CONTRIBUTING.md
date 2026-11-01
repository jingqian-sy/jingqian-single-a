# 参与贡献

谢谢你看这个项目。它还是雏版，最需要的是「发现它哪里不靠谱」的人。

## 先跑起来

```bash
node --version      # 需要 22+
node src/server.js  # 一条命令起服务（零依赖，不用 npm install）
./demo.cmd          # Windows：30 秒看它怎么记事、怎么跑命令
./demo.sh           # macOS / Linux
```

没有模型也能跑测试：

```bash
node evals/test-judge.js   # 判定器 26 条规则
node evals/test-tools.js   # 工具 / 红线 / 路径 / 沙盒 22 条
node evals/ci.js           # CI 全流程（用 mock 模型，不需要密钥）
```

## 提 PR 之前

1. **先跑 `node evals/ci.js`，必须绿。** 它会检查语法、单元测试、服务冒烟和一个 6 题评测子集。
2. 改到了工具、红线、路径处理 → 顺手在 `evals/test-tools.js` 里加一条用例。
3. 改到了判定规则 → 看下 `docs/评测变更说明.md` 的规矩：**不许改题让失败变通过**，
   要改就写变更说明、旧结果归档到 `data/archive/`。
4. 别提交 `config.json`、`data/` 下的运行数据、任何密钥。`.gitignore` 已经拦了，但请自己看一眼 `git status`。

## 提交信息

不用严格格式，但请说清「为什么」而不只是「改了什么」。比如：

```
fix: 命令输出在 Windows 下中文乱码（cmd 走 GBK，Node 按 UTF-8 解）
eval: 新增路径重复前缀回归题，防止 data/workspace/x 写成两层
docs: 补省钱对比的单价来源与查询时间
```

## 判定的底线

评测的价值在于「数字能信」。所以：

- 能用盘上副作用验证的，一律看文件 / 审计日志，不靠模型自评；
- 失败就是失败，不许回头把题改简单；
- 要改判定规则，另写变更说明，保留上一版结果（`data/archive/` 里能对）。

## 想帮忙的方向

- 更多真实任务进 `evals/tasks.json`（带机器判定，能被 3A 模板复用）；
- 记忆召回的质量（中文分词、事件聚类规则）；
- 省钱：本地小模型分包预处理，云端只出判断；
- 文档里「说到没做到」的地方——这个最欢迎。

## 发布前的小清单

- README 顶部徽章、`package.json` 的 `repository` / `bugs` / `homepage` 里都有 `your-org`，
  换成你自己的 GitHub 路径，CI 徽章才会亮。
- README 里的截图占位换成真图：`docs/assets/screenshot.png`，然后取消那行注释。
- `node evals/ci.js` 绿、`node demo.js` 能跑通。

## 行为准则

参与本项目即表示同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。


## 贡献一次跑批（最有用的一种贡献）

我们最缺的是**在别人机器、别人模型上的数据**。

1. `node evals/run.js --run`，生成 `data/results.json`
2. 改名成 `<系统>-<显存>-<模型>.json`，放到 `data-community/`
3. 提 PR，说明：系统、显存、模型与量化、是否联网、有没有人工抽检

跑得不理想也欢迎——我们更想知道边界在哪。详见 `docs/本地模型边界与社区数据.md`。
