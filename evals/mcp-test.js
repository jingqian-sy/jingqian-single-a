'use strict';
/*
 * 插件版（MCP）测试：真按 MCP 的 stdio 协议聊一遍，验八件：
 *   1) initialize 回协议版本和 serverInfo；
 *   2) notifications/initialized 不返回东西、也不影响后续；
 *   3) tools/list 正好四个工具（ask / memory_search / memory_remember / stats）；
 *   4) memory_remember 真写进本机记忆；
 *   5) memory_search 能搜回来；
 *   6) stats 回模型/调用数/记忆条数；
 *   7) ask 真的走 /api/chat（用本地假模型，不联网）；
 *   8) 不认识的方法返回 -32601、不认识的工具返回 isError，进程不崩。
 *
 * 全程本机：临时服务 + 假模型，不碰真实记忆。
 *
 *   node evals/mcp-test.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.run', 'mcp-test');
const APP_PORT = 7912;
const MOCK_PORT = 18112;

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')); }
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitServer(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch('http://127.0.0.1:' + APP_PORT + '/api/selfcheck'); if (r.ok) return true; } catch (e) {}
    await sleep(150);
  }
  return false;
}

// 一个能读一行的 MCP 子进程客户端
function mcpClient(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, env || {}),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buf = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  let errOut = '';
  child.stderr.on('data', (d) => { errOut += d.toString(); });
  return {
    call(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('MCP 超时：' + method + ' ' + errOut)); } }, 30000);
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
    },
    close() { try { child.stdin.end(); } catch (e) {} try { child.kill(); } catch (e) {} },
    get stderr() { return errOut; }
  };
}

function toolText(res) {
  const c = res && res.result && res.result.content;
  return Array.isArray(c) && c[0] ? String(c[0].text || '') : '';
}

(async () => {
  rmrf(TMP);
  fs.mkdirSync(path.join(TMP, 'data', 'workspace'), { recursive: true });

  const mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '插件测试回复：在的。' } }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
      }));
    });
  });
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  const cfgFile = path.join(TMP, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    port: APP_PORT,
    providers: [{ name: 'mock', tier: 'local', base: 'http://127.0.0.1:' + MOCK_PORT + '/v1/chat/completions', model: 'mock-1', key: 'local' }],
    route: { mode: 'fixed', order: ['mock'], maxSteps: 1 },
    tools: { workspace: 'data/workspace' },
    memory: { autoCapture: false, writeEvents: false },
    qq: { enabled: false, allow: [], groups: [] },
    budget: { perCallSeconds: 10, perTaskSeconds: 20 }
  }, null, 2), 'utf8');

  const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(APP_PORT), JQ_CONFIG: cfgFile, JQ_DATA_DIR: path.join(TMP, 'data')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvOut = '';
  server.stdout.on('data', (d) => { srvOut += d.toString(); });
  server.stderr.on('data', (d) => { srvOut += d.toString(); });

  const mcp = mcpClient({ JINGQIAN_URL: 'http://127.0.0.1:' + APP_PORT, JINGQIAN_NODE: process.execPath });
  try {
    ok(await waitServer(8000), '临时服务起得来');

    // 1) initialize
    const init = await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    ok(init && init.result && init.result.protocolVersion, 'initialize 回了协议版本', JSON.stringify(init).slice(0, 120));
    ok(init && init.result && init.result.serverInfo && init.result.serverInfo.name === 'jingqian-single-a', 'serverInfo 名字对');

    // 2) notifications/initialized（没有响应、但后面的请求照常）
    mcp.notify('notifications/initialized');
    const ping = await mcp.call('ping');
    ok(ping && ping.result, 'notifications/initialized 之后还能正常请求');

    // 3) tools/list
    const list = await mcp.call('tools/list');
    const names = ((list.result && list.result.tools) || []).map((t) => t.name).sort();
    ok(names.length === 4, 'tools/list 正好四个工具', names.join(','));
    ok(['ask', 'memory_remember', 'memory_search', 'stats'].every((x) => names.indexOf(x) >= 0), '四个工具一个不少', names.join(','));

    // 4) memory_remember
    const rem = await mcp.call('tools/call', { name: 'memory_remember', arguments: { text: '插件测试：下周三要交房租', kind: 'fact', importance: 3 } });
    ok(/记住/.test(toolText(rem)), 'memory_remember 写进去了', toolText(rem));

    // 5) memory_search
    const sea = await mcp.call('tools/call', { name: 'memory_search', arguments: { query: '房租' } });
    ok(/房租/.test(toolText(sea)), 'memory_search 能搜回来', toolText(sea));

    // 6) stats
    const sta = await mcp.call('tools/call', { name: 'stats', arguments: {} });
    let st = null;
    try { st = JSON.parse(toolText(sta)); } catch (e) {}
    ok(st && st.memory >= 1, 'stats 回了记忆条数', toolText(sta).slice(0, 120));
    ok(st && Array.isArray(st.providers), 'stats 回了模型列表');

    // 7) ask（走真 /api/chat，模型是本地假模型）
    const ask = await mcp.call('tools/call', { name: 'ask', arguments: { text: '在吗' } });
    ok(/插件测试回复/.test(toolText(ask)), 'ask 真的走到 /api/chat 并拿到回复', toolText(ask));

    // 8) 不认识的方法 / 工具
    const bad = await mcp.call('no/such/method');
    ok(bad.error && bad.error.code === -32601, '不认识的方法回 -32601', JSON.stringify(bad).slice(0, 100));
    const badTool = await mcp.call('tools/call', { name: 'no_such_tool', arguments: {} });
    ok(badTool.result && badTool.result.isError === true, '不认识的工具回 isError，不崩', JSON.stringify(badTool).slice(0, 120));
    const still = await mcp.call('ping');
    ok(still && still.result, '出错之后进程还活着');
  } finally {
    mcp.close();
    server.kill();
    mock.close();
  }

  console.log('\n插件版（MCP）用例：' + pass + '/' + (pass + fail) + ' 通过');
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
