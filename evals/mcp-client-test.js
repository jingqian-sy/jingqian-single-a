'use strict';
/*
 * 内置 MCP 客户端测试（CI 用，不联网）
 *
 *   node evals/mcp-client-test.js
 *
 * 验五件事：
 *   1) 默认关：没 enabled 一个进程都不起；
 *   2) 开了以后能拉起 stdio 服务，拿到工具列表；
 *   3) 工具名带前缀 mcp__<服务>__<工具>，不能和内建撞名；
 *   4) 真能调：tools/call 拿回文本；
 *   5) command 不是绝对路径时拒绝启动（安全规矩）。
 */
const fs = require('fs');
const path = require('path');
const { McpClient } = require('../src/mcp-client');

const TMP = path.join(__dirname, '.run', 'mcp-client');
const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');
let fails = 0;
function ok(name, cond, extra) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(extra === undefined ? '' : extra)));
  if (!cond) fails++;
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  // 1) 默认关
  const off = new McpClient({ dataDir: TMP, cfg: { mcp: { enabled: false, servers: [{ name: 'x', command: process.execPath }] } } });
  ok('默认关：一个都不启动', (await off.startAll()).length === 0, 'started');

  // 2) 开了能起
  const cfgOn = {
    mcp: {
      enabled: true,
      servers: [{ name: 'fake', command: process.execPath, args: [FAKE], tools: 'all' }]
    }
  };
  const on = new McpClient({ dataDir: TMP, cfg: cfgOn });
  const regs = await on.startAll();
  ok('开起来拿到工具', regs.length === 2, regs.map((r) => r.def.name));
  ok('工具名带前缀', regs.every((r) => /^mcp__fake__/.test(r.def.name)), regs.map((r) => r.def.name));

  const hello = regs.find((r) => r.tool === 'hello');
  const out = await hello.fn({ who: '小倩' });
  ok('真能调用并拿回文本', /你好/.test(out), out);

  const echo = regs.find((r) => r.tool === 'echo');
  ok('参数能带过去', /ECHO:abc/.test(await echo.fn({ text: 'abc' })), 'echo');

  // 工具过滤
  const only = new McpClient({ dataDir: TMP, cfg: { mcp: { enabled: true, servers: [{ name: 'fake2', command: process.execPath, args: [FAKE], tools: ['echo'] }] } } });
  const regs2 = await only.startAll();
  ok('tools 过滤生效', regs2.length === 1 && regs2[0].tool === 'echo', regs2.map((r) => r.tool));
  only.closeAll();

  // 3) 非绝对路径拒绝
  const bad = new McpClient({ dataDir: TMP, cfg: { mcp: { enabled: true, servers: [{ name: 'bad', command: 'node', args: [FAKE] }] } } });
  const regs3 = await bad.startAll();
  ok('相对/裸命令拒绝启动', regs3.length === 0, regs3.length);

  on.closeAll();
  const log = fs.existsSync(path.join(TMP, 'mcp.log')) ? fs.readFileSync(path.join(TMP, 'mcp.log'), 'utf8') : '';
  ok('写 mcp.log', /已连接/.test(log), log.slice(0, 80));

  console.log(fails ? ('失败 ' + fails + ' 条') : '全部通过（8 条）');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FAIL ' + e.message); process.exit(1); });
