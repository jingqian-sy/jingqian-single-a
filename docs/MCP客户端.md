# 内置 MCP 客户端：把外部 MCP 服务的工具接进来

一句话：在 `config.json` 里列几个 MCP 服务，启动时拉起它们，它们的工具就出现在她的工具表里，
名字统一 `mcp__<服务名>__<工具名>`。默认关，你不写就不启动任何东西。

## 一、配置长这样

```json
{
  "mcp": {
    "enabled": true,
    "servers": [
      {
        "name": "memory",
        "command": "C:\\Users\\你\\AppData\\Local\\Jingqian\\runtime\\node-v22.14.0-win-x64\\node.exe",
        "args": ["C:\\Users\\你\\Documents\\deepseek-harness\\default-workspace\\memory-service\\mcp-server.mjs"],
        "env": {},
        "tools": "all",
        "timeoutMs": 20000
      }
    ]
  }
}
```

- `enabled`：总开关，默认 `false`；
- `name`：只用小写字母/数字/`-`/`_`，会变成工具名前缀；
- `command`：**必须是绝对路径**（不许写 `node` 让它去 PATH 里找）；
- `args`：参数数组，原样传给命令；
- `env`：额外环境变量（会叠加在系统环境上）；
- `tools`：`"all"` 或 `["工具名1","工具名2"]`，只挂这几个；
- `timeoutMs`：单次请求超时，默认 20 秒。

## 二、规矩（写死，不放开）

1. 默认关；`enabled=false` 或 `servers` 为空 → 一个进程都不起。
2. 只做 stdio（`stdin/stdout` 上的 JSON-RPC），不连网络。
3. `command` 不是绝对路径 → 直接拒绝启动，日志写原因。
4. 一个服务起不来只影响它自己的工具，聊天照常（这一轮少几个工具而已）。
5. 工具名统一 `mcp__<服务>__<工具>`，避免和内建工具撞名；重名会跳过。
6. 每次连接/失败都写 `data/mcp.log`。

## 三、能接什么

任何说 MCP 的 stdio 服务都能接，比如本机已有的：

- `memory-service/mcp-server.mjs`（记忆的 remember / search / recent / stats）
- `qq-bridge-app/src/mcp-*.js`（SnowLuma、联网搜索、token-saver）
- 社区里现成的 MCP 服务（文件系统、数据库、搜索等）

**风险**：MCP 服务就是你本机的一个进程，它有什么权限你就有。只接你自己看过、信得过的。

## 四、怎么验

```cmd
node evals\mcp-client-test.js
```

八条：默认关、能起、前缀、真调用、参数传递、tools 过滤、拒绝裸命令、写日志。

CI 里是第 25 步（CI 共 31 步）（不联网、用假 MCP 服务）。
