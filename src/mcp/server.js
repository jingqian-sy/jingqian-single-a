#!/usr/bin/env node
'use strict';
/*
 * 鲸倩 · 插件版（MCP）stdin/stdout 服务
 *
 * 一行配置挂到 DSH / Cherry Studio 这类 MCP 客户端：
 *   { "mcpServers": { "jingqian": { "command": "node", "args": ["<仓库绝对路径>/src/mcp/server.js"] } } }
 *
 * 它不重复实现任何业务：所有调用都转发给本机 Node 服务（默认 http://127.0.0.1:7889），
 * 服务没起来就自己拉一次（和软件版同一套逻辑）。聊天/记忆/工具/红线全在服务里。
 *
 * 暴露的 tools： ask / memory_search / memory_remember / stats
 * 环境变量：JINGQIAN_URL（服务地址，默认 http://127.0.0.1:7889）
 */
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const BASE = (process.env.JINGQIAN_URL || 'http://127.0.0.1:7889').replace(/\/$/, '');

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function http(method, p, body, timeoutMs) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs || 180000)
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}

async function ensureService() {
  try { await http('GET', '/api/selfcheck', null, 1500); return; } catch (e) { /* 服务没起 */ }
  // 默认用「正在跑这个脚本的那个 node」：客户端配置里写的是 node 绝对路径时，
  // PATH 里不一定有 node，写死的 'node' 会 ENOENT，服务永远拉不起来。
  const node = process.env.JINGQIAN_NODE || process.execPath;
  const child = spawn(node, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { await http('GET', '/api/selfcheck', null, 1500); return; } catch (e) { /* 继续等 */ }
  }
  throw new Error('本机服务没起来：' + BASE);
}

const TOOLS = [
  {
    name: 'ask',
    description: '跟本机鲸倩说一句话（带人格、记忆、工具、红线），返回她的原话',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要对她说的话' }, session: { type: 'string', description: '会话名，默认 mcp' } },
      required: ['text']
    }
  },
  {
    name: 'memory_search',
    description: '在本机记忆库里搜相关的事',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  },
  {
    name: 'memory_remember',
    description: '把一件值得长期记住的事写进本机记忆库',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        kind: { type: 'string', description: 'fact / preference / relation / emotional / lesson' },
        importance: { type: 'number', description: '1~4' },
        pinned: { type: 'boolean' }
      },
      required: ['text']
    }
  },
  {
    name: 'stats',
    description: '看本机服务状态：模型、今天调用次数、tokens、记忆条数',
    inputSchema: { type: 'object', properties: {} }
  }
];

async function callTool(name, args) {
  args = args || {};
  if (name === 'ask') {
    const r = await http('POST', '/api/chat', { message: String(args.text || ''), session: args.session || 'mcp', entry: 'mcp' });
    if (!r.ok) throw new Error(r.error || '服务返回失败');
    return '她说：' + r.reply;
  }
  if (name === 'memory_search') {
    const r = await http('GET', '/api/memory?query=' + encodeURIComponent(String(args.query || '')), null, 10000);
    const hits = r.hits || [];
    if (!hits.length) return '记忆库里没搜到相关的事。';
    return hits.map((h) => '- ' + h.text).join('\n');
  }
  if (name === 'memory_remember') {
    const r = await http('POST', '/api/memory', {
      text: String(args.text || ''),
      kind: args.kind || 'fact',
      importance: Number(args.importance) || 2,
      pinned: !!args.pinned
    }, 10000);
    if (!r.ok) throw new Error(r.error || '写入失败');
    return '记住了：' + r.item.text;
  }
  if (name === 'stats') {
    const r = await http('GET', '/api/stats', null, 8000);
    const memCount = (r.memory && r.memory.count !== undefined) ? r.memory.count : (r.memory || 0);
    return JSON.stringify({
      service_up: true,
      service_url: BASE,
      uptime_s: (r.server && r.server.uptime_s) || null,
      providers: (r.providers || []).map((p) => p.name + '/' + (p.model || '') + (p.ready ? ' 就绪' : ' 未就绪')),
      today_calls: Number(r.today_calls || 0),
      today_tokens: Number(r.today_tokens || 0),
      memory_count: Number(memCount) || 0,
      memory: Number(memCount) || 0,   // 老客户端认这个字段，留着兼容
      memory_note: '这是本机服务自己的记忆库。干净版/新装的库是 0 条，属于正常；0 不代表记忆服务坏了。'
    }, null, 2);
  }
  throw new Error('没有这个工具：' + name);
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'jingqian-single-a', version: '1.0.0' }
    } };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = params && params.name;
    try {
      await ensureService();
      const text = await callTool(name, params && params.arguments);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '出错：' + e.message }], isError: true } };
    }
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  return { jsonrpc: '2.0', id, error: { code: -32601, message: '不支持的方法：' + method } };
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    handle(msg).then((res) => { if (res) send(res); }).catch((e) => {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } });
    });
  }
});
process.stdin.on('end', () => { /* 等未完成的请求跑完再自然退出，别在半路 exit */ });
