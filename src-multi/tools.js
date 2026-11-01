'use strict';
/*
 * 3A 模板 · 工具层（自己实现，契约与单A 一致）
 *
 * 工具名/入参/返回形状是「共用协议」，代码不共用。
 * 每次调用先过 3A 的四级红线，再执行；路径锁在 workspace 里；
 * 模型传来的 data/workspace/x 会被剥掉重复前缀（t08 那道回归题盯着这里）。
 */
const fs = require('fs');
const path = require('path');
const safety = require('./safety');
const sandbox = require('./sandbox');
const { readJson, writeJson, ensureDir, truncate, nowIso } = require('./util');

function stripWorkspacePrefix(root, p) {
  let s = String(p == null ? '' : p).replace(/\\/g, '/').trim();
  if (!s) return '.';
  const wsRel = path.relative(root, path.resolve(root, 'data/workspace')).replace(/\\/g, '/');
  for (const r of [wsRel, 'data/workspace']) {
    if (!r || r === '.') continue;
    if (s === r) return '.';
    if (s.startsWith(r + '/')) return s.slice(r.length + 1);
    if (s.startsWith('./' + r + '/')) return s.slice(r.length + 3);
  }
  return s;
}

const DEFS = [
  { type: 'function', function: { name: 'read_file', description: '读一个文本文件的内容', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: '写一个文本文件', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'list_dir', description: '列目录内容', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'run_command', description: '在工作目录跑一条白名单命令', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'remember', description: '把值得长期记住的事写进记忆库', parameters: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string' }, importance: { type: 'integer' }, pinned: { type: 'boolean' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'recall', description: '在记忆库里搜相关的事', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'event_timeline', description: '看事件时间轴', parameters: { type: 'object', properties: { limit: { type: 'integer' } } } } },
  { type: 'function', function: { name: 'remind', description: '定一个提醒', parameters: { type: 'object', properties: { text: { type: 'string' }, in_minutes: { type: 'number' }, when: { type: 'string' } }, required: ['text'] } } }
];

class Tools {
  constructor(ctx) {
    this.ctx = ctx; // { cfg, root, workspace, memory, audit, dataDir }
    this.pending = null;
    this.remindFile = path.join(ctx.dataDir, 'reminders.json');
  }

  defs() { return DEFS; }

  async run(name, args, opts) {
    opts = opts || {};
    const v = safety.check(name, args, { workspace: this.ctx.workspace, confirmed: opts.confirmed === true });
    this.ctx.audit({ tool: name, args, level: v.level, allowed: v.allowed, reason: v.reason });
    if (!v.allowed) {
      if (v.level !== 'P0') this.pending = { tool: name, args, at: Date.now() };
      return v.note;
    }
    this.pending = null;
    try {
      switch (name) {
        case 'read_file': return this.readFile(args);
        case 'write_file': return this.writeFile(args);
        case 'list_dir': return this.listDir(args);
        case 'run_command': return this.runCommand(args);
        case 'remember': {
          const it = this.ctx.memory.add({ text: args.text, kind: args.kind, importance: args.importance, pinned: args.pinned, source: 'tool-3a' });
          return it ? ('记住了：' + truncate(it.text, 80)) : '这句是空的，没记。';
        }
        case 'recall': {
          const hits = this.ctx.memory.recall(args.query, 5);
          return hits.length ? hits.map((h) => '- ' + (h.pinned ? '★' : '') + h.text).join('\n') : '记忆库里没搜到相关的事。';
        }
        case 'event_timeline': {
          const list = this.ctx.memory.timeline(Math.min(Number(args.limit) || 6, 20));
          return list.length ? list.map((e) => '- [' + e.start.slice(0, 10) + '] ' + e.title + '（' + e.memory_ids.length + ' 条）').join('\n') : '还没有事件。';
        }
        case 'remind': return this.remind(args);
        default: return '没有这个工具：' + name;
      }
    } catch (e) {
      return '工具出错：' + e.message;
    }
  }

  resolve(p) {
    const root = this.ctx.root;
    return path.resolve(this.ctx.workspace, stripWorkspacePrefix(root, p));
  }

  readFile(args) {
    const abs = this.resolve(args.path);
    if (!fs.existsSync(abs)) return '文件不存在：' + args.path + '（工作目录里没有这个文件，别猜内容）';
    if (fs.statSync(abs).isDirectory()) return '这是个目录，用 list_dir 看。';
    return fs.readFileSync(abs, 'utf8');
  }

  writeFile(args) {
    const abs = this.resolve(args.path);
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, String(args.content == null ? '' : args.content), 'utf8');
    return '写了 ' + args.path + '（' + fs.statSync(abs).size + ' 字节）';
  }

  listDir(args) {
    const abs = this.resolve(args.path || '.');
    if (!fs.existsSync(abs)) return '目录不存在：' + (args.path || '.');
    const items = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 100).map((d) => (d.isDirectory() ? d.name + '/' : d.name));
    return items.length ? items.join('\n') : '（空目录）';
  }

  runCommand(args) {
    const cfg = this.ctx.cfg || {};
    const t = cfg.tools || {};
    if (t.allowCommand === false) return '命令执行被配置关掉了。';
    const wl = t.commandWhitelist || ['echo', 'dir', 'type', 'node', 'git', 'where', 'ls', 'cat'];
    const first = String(args.command || '').trim().split(/\s+/)[0].toLowerCase().replace(/^.*[\\/]/, '');
    const ok = wl.some((w) => { const x = String(w).toLowerCase(); return first === x || first === x + '.exe' || first === x + '.cmd'; });
    if (!ok) return '这条命令不在白名单里（只允许：' + wl.join('、') + '）。';
    const res = sandbox.run(args.command, {
      workspace: this.ctx.workspace,
      mode: (cfg.sandbox && cfg.sandbox.mode) || 'none',
      timeoutMs: t.commandTimeoutMs || 30000,
      maxOutput: t.maxOutput || 12000,
      image: cfg.sandbox && cfg.sandbox.image
    });
    return '[sandbox=' + res.mode + '] ' + (res.note ? '(' + res.note + ') ' : '') + (res.ok ? '' : '（退出码 ' + res.code + '）') + '\n' + (res.output || '（无输出）');
  }

  remind(args) {
    const list = readJson(this.remindFile, []);
    let due;
    if (args.in_minutes) due = new Date(Date.now() + Number(args.in_minutes) * 60000);
    else if (args.when && /^\d{1,2}:\d{2}$/.test(args.when)) {
      const [h, m] = args.when.split(':').map(Number);
      const d = new Date(); d.setHours(h, m, 0, 0);
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
      due = d;
    } else due = new Date(Date.now() + 30 * 60000);
    const item = { id: 'r_' + Date.now().toString(36), text: String(args.text || '').slice(0, 200), due_at: due.toISOString(), done: false, created_at: nowIso() };
    list.push(item);
    writeJson(this.remindFile, list);
    return '定了：' + item.text;
  }
}

module.exports = { Tools, DEFS, stripWorkspacePrefix };
