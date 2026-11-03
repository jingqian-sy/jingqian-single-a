'use strict';
/*
 * 内置 MCP 客户端（stdio）：把外部 MCP 服务的工具接进来用
 *
 * 配置在 config.json 的 mcp 段：
 *   "mcp": {
 *     "enabled": false,
 *     "servers": [
 *       { "name": "memory", "command": "C:\\...\\node.exe",
 *         "args": ["C:\\...\\mcp-server.mjs"], "env": {}, "tools": "all" }
 *     ]
 *   }
 *
 * 规矩（写死，不放开）：
 *   - 默认关；只有 enabled=true 且 servers 列表非空才启动任何进程；
 *   - command 必须是绝对路径（不许用 PATH 里随便找一个来跑）；
 *   - 只做 stdio，不连网络；
 *   - 一个服务起不来只影响它自己的工具，聊天照常；
 *   - 工具名统一 mcp__<服务名>__<工具名>，避免和内建撞名；
 *   - 每次启动/失败写 data/mcp.log。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { appendJsonl, nowIso, ensureDir } = require('./util');

const PROTOCOL_VERSION = '2025-06-18';
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

class McpServer {
  constructor(cfg, opts) {
    this.cfg = cfg;
    this.name = String(cfg.name || '');
    this.command = String(cfg.command || '');
    this.args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
    this.env = cfg.env && typeof cfg.env === 'object' ? cfg.env : {};
    this.toolsFilter = cfg.tools || 'all';
    this.timeoutMs = Number(cfg.timeoutMs) || 20000;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = '';
    this.tools = [];
    this.logFile = opts.logFile;
    this.log = opts.log;
  }

  write(obj) {
    if (!this.child || !this.child.stdin.writable) throw new Error('MCP 服务没起来');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' 超时（' + this.timeoutMs + 'ms）'));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      try { this.write({ jsonrpc: '2.0', id, method, params: params || {} }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  notify(method, params) {
    try { this.write({ jsonrpc: '2.0', method, params: params || {} }); } catch (e) {}
  }

  handleLine(line) {
    line = String(line || '').trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  }

  async start() {
    if (!/^[a-zA-Z]:[\\/]/.test(this.command) && !this.command.startsWith('/')) {
      throw new Error('command 必须是绝对路径（安全考虑，不从 PATH 里找）');
    }
    if (!fs.existsSync(this.command)) throw new Error('找不到命令：' + this.command);
    this.child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, this.env),
      windowsHide: true
    });
    this.child.stdout.on('data', (d) => {
      this.buffer += d.toString('utf8');
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.handleLine(line);
      }
    });
    this.child.stderr.on('data', (d) => this.log({ event: 'stderr', server: this.name, text: String(d).slice(0, 300) }));
    this.child.on('exit', (code) => {
      this.log({ event: '退出', server: this.name, code });
      for (const [, p] of this.pending) p.reject(new Error('MCP 服务退出了'));
      this.pending.clear();
      this.child = null;
    });

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'jingqian', version: '1.0' }
    });
    this.notify('notifications/initialized', {});
    const res = await this.request('tools/list', {});
    const list = (res && res.tools) || [];
    const allowed = this.toolsFilter === 'all' ? null : (Array.isArray(this.toolsFilter) ? this.toolsFilter : null);
    this.tools = list.filter((t) => !allowed || allowed.indexOf(t.name) >= 0).map((t) => ({
      name: String(t.name),
      description: String(t.description || ''),
      parameters: t.inputSchema || { type: 'object', properties: {} }
    }));
    this.log({ event: '已连接', server: this.name, tools: this.tools.length });
    return this.tools;
  }

  async call(tool, args) {
    const res = await this.request('tools/call', { name: tool, arguments: args || {} });
    const parts = (res && res.content) || [];
    const texts = parts.filter((c) => c && c.type === 'text').map((c) => String(c.text || ''));
    if (res && res.isError) throw new Error(texts.join('\n') || '工具报错');
    return texts.join('\n') || '（工具没有返回文本）';
  }

  close() {
    try { if (this.child) this.child.kill(); } catch (e) {}
    this.child = null;
  }
}

class McpClient {
  constructor(opts) {
    opts = opts || {};
    this.dataDir = opts.dataDir;
    this.cfg = (opts.cfg && opts.cfg.mcp) || {};
    this.directory = this.cfg.directory || '';
    this.servers = [];
    const logFile = path.join(this.dataDir, 'mcp.log');
    ensureDir(this.dataDir);
    this.log = (entry) => { try { appendJsonl(logFile, Object.assign({ ts: nowIso() }, entry)); } catch (e) {} };
  }

  enabled() {
    return !!this.cfg.enabled && Array.isArray(this.cfg.servers) && this.cfg.servers.length > 0;
  }

  // 启动所有服务，返回 [{ server, tool, def, fn }]，失败的服务跳过
  async startAll() {
    if (!this.enabled()) return [];
    const out = [];
    for (const raw of this.cfg.servers) {
      const name = String((raw && raw.name) || '');
      if (!NAME_RE.test(name)) { this.log({ event: '名字不合法', name }); continue; }
      const s = new McpServer(Object.assign({}, raw, { name }), { logFile: null, log: this.log });
      try {
        const tools = await s.start();
        this.servers.push(s);
        for (const t of tools) {
          const full = 'mcp__' + name + '__' + t.name.replace(/[^\w]/g, '_').slice(0, 40);
          out.push({
            server: name,
            tool: t.name,
            def: { name: full, description: '[' + name + '] ' + t.description, parameters: t.parameters },
            fn: (args) => s.call(t.name, args)
          });
        }
      } catch (e) {
        this.log({ event: '启动失败', server: name, error: e.message });
        try { s.close(); } catch (e2) {}
      }
    }
    return out;
  }

  closeAll() {
    for (const s of this.servers) s.close();
    this.servers = [];
  }
}

module.exports = { McpClient, McpServer };
