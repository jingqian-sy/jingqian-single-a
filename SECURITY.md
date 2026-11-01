# 安全说明

这个项目会**在你的电脑上读写文件、跑命令**。请先读完这一页再跑，尤其是别把它暴露到公网。

## 一、密钥怎么配（别进仓库）

支持两种方式，推荐第二种：

1. 写进 `config.json` 的 `providers[].key`。
   注意：`config.json` 在 `.gitignore` 里，**不要提交，也不要贴到 issue 里**。
2. 用环境变量，配置文件里只写字段名：

   ```json
   { "name": "deepseek", "env": "DEEPSEEK_API_KEY", "key": "" }
   ```

   ```bash
   # Windows PowerShell
   $env:DEEPSEEK_API_KEY = "你的 key"
   # macOS / Linux
   export DEEPSEEK_API_KEY="你的 key"
   ```

- 代码里没有任何硬编码密钥；日志只记 provider 名和错误码，不打印请求头。
- 本地 Ollama 不需要 key（`tier: "local"` 的提供方不走鉴权）。
- 仓库里的 `config.example.json` / `config.multi-provider.example.json` 全是空占位符。

## 二、红线是什么

工具调用前先过四级判定（`src/safety.js`），每条判定都写进 `data/audit.log`：

| 级别 | 处理 | 例子 |
|---|---|---|
| **P0** | 直接拒，不执行 | `format`、`diskpart`、`bcdedit`、删系统目录、`rm -rf /`、关机重启 |
| **P1** | 需要你明确回「确认」 | 删/移动文件、覆盖已有文件、`git reset --hard` |
| **P2** | 需要你明确回「确认」 | 碰 `.env` / `id_rsa` / `token` 这类凭据，访问工作目录之外的路径 |
| **P3** | 放行，但留审计 | 读文件、写新文件、白名单内命令 |

- 文件工具锁在 `config.tools.workspace`（默认 `data/workspace`）里，越界要确认。
- 命令只走白名单（`tools.commandWhitelist`），白名单外一律拒。
- 服务默认只听 `127.0.0.1`，**没有登录鉴权**——不要改成 `0.0.0.0` 挂公网。

## 三、沙盒（默认关，开了也不是铜墙铁壁）

```json
{ "sandbox": { "mode": "none" } }
```

- `none`（默认）：直接执行。红线是**正则形式的刹车**，拦得住手滑，拦不住精心构造的坏命令。
- `process`：子进程 + 临时工作目录 + 超时 + 输出上限，并清掉常见密钥环境变量。
- `docker`：容器内执行（`--network=none`）。机器上没有 docker 时会**明确警告并回退 `process`**。

要跑不可信代码，别指望这几档开关，请自己套虚拟机/容器。

## 四、报告漏洞

- 普通问题：开一个 issue，带上复现命令和预期/实际结果，**不要带你的密钥和聊天记录**。
- 可能导致数据丢失或命令执行的问题（红线绕过、路径穿越、沙盒逃逸）：
  请走 GitHub 的 Private vulnerability reporting（仓库 Security 页 → Report a vulnerability），
  或在 issue 里只写「有安全问题，请给联系方式」，别公开细节。
- 我们会在 7 天内回第一封；修好后会在 issue/公告里写清影响范围与版本。

## 五、支持范围

| 版本 | 安全修复 |
|---|---|
| 1.0.x | 是 |
| < 1.0 | 否（雏版早期，不建议部署）|

## 六、数据与隐私

- 记忆、会话、账本、审计都在本地 `data/`，不上传；删掉这个文件夹就等于清空。
- 仓库里只有评测数据（题目回复与判定），没有任何真实聊天记录或用户记忆。
- 接云端模型时，你发的内容会按对方的隐私政策经过对方服务器——这一点无法在本项目里替你保证。
