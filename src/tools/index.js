'use strict';
/*
 * 工具层：文件、命令、提醒、记忆读写、事件时间轴
 *
 * 每个工具都要过 safety.check（四级红线），判定结果写审计；路径一律锁在
 * config.tools.workspace 里面，越界要确认。
 * 命令额外过白名单，并且可以走 sandbox.run 的三档沙盒（默认 none）。
 */
const fs = require('fs');
const path = require('path');
const safety = require('../safety');
const sandbox = require('../sandbox');
const extras = require('./extras');
const { readJson, writeJson, ensureDir, truncate, nowIso } = require('../util');

function safeResolve(root, p) {
  const abs = path.resolve(root, String(p || '.'));
  const inside = abs === root || abs.startsWith(root + path.sep);
  return { abs, inside };
}

// 模型有时会把「相对仓库根」的路径（如 data/workspace/x.txt）原样传来，
// 直接拼就会变成 data/workspace/data/workspace/x.txt。这里先把它剥掉。
// 用户的事按第三人称存，别让她当成自己的
function userFact(text) {
  let t = String(text || '').trim();
  t = t.replace(/^记住[：:，,]?/, '').replace(/^记一下[：:，,]?/, '');
  t = t.replace(/^我叫/, '用户叫').replace(/^我的名字是?/, '用户名字是');
  t = t.replace(/^我(很|最|特别|也)?喜欢/, '用户喜欢').replace(/^我(很|最|特别|也)?讨厌/, '用户讨厌');
  t = t.replace(/^我(很|最|特别|也)?爱/, '用户爱');
  t = t.replace(/我的/g, '用户的');
  t = t.replace(/我/g, '用户');
  return t;
}

function stripWorkspacePrefix(root, p) {
  let s = String(p == null ? '' : p).replace(/\\/g, '/').trim();
  if (!s) return '.';
  const wsRel = path.relative(root, path.resolve(root, 'data/workspace')).replace(/\\/g, '/');
  const roots = [wsRel, 'data/workspace'];
  for (const r of roots) {
    if (!r || r === '.') continue;
    if (s === r) return '.';
    if (s.startsWith(r + '/')) return s.slice(r.length + 1);
    if (s.startsWith('./' + r + '/')) return s.slice(r.length + 3);
  }
  return s;
}

function commandAllowed(cmd, whitelist) {
  const first = String(cmd || '').trim().split(/\s+/)[0].toLowerCase().replace(/^.*[\\/]/, '');
  for (const w of whitelist || []) {
    const wl = String(w).toLowerCase();
    if (first === wl || first === wl + '.exe' || first === wl + '.cmd') return true;
  }
  return false;
}

const DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读一个文本文件的内容（只能读工作目录里面）',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '相对工作目录的路径' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写一个文本文件（新文件直接写，覆盖已有文件要先确认）',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列一个目录里有什么文件',
      parameters: { type: 'object', properties: { path: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在工作目录里跑一条命令（只允许白名单里的命令，可以用沙盒）',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: '把一件值得长期记住的事写进记忆库。只记偏好、约定、重要日子、关系、经验，不记流水账',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '一句话，尽量短' },
          kind: { type: 'string', enum: ['fact', 'preference', 'relation', 'emotional', 'lesson'] },
          importance: { type: 'integer', description: '1~4，4 最重要' },
          pinned: { type: 'boolean', description: '钉住就永不遗忘' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description: '在记忆库里搜相关的事（关键词 + 向量）',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'event_timeline',
      description: '看记忆事件的时间轴：零散的话被串成了哪几件事',
      parameters: { type: 'object', properties: { limit: { type: 'integer' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remind',
      description: '定一个提醒，到点会记下来（服务重启也还在）',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' }, in_minutes: { type: 'number' }, when: { type: 'string', description: 'HH:MM' } },
        required: ['text']
      }
    }
  }
];

const ALL_DEFS = DEFS.concat(extras.DEFS);

class Tools {
  constructor(ctx) {
    this.ctx = ctx; // { cfg, workspace, store, events, audit, dataDir, configPath, subAgent }
    this.remindFile = path.join(ctx.dataDir, 'reminders.json');
    this.pending = null;
    // 插件注册上来的工具：插件只加这两张表，核心代码不动
    this.pluginDefs = [];
    this.pluginFns = {};
  }

  // 插件用：注册一个工具（名字不能和内建的重）
  registerPluginTool(def, pluginName, fn) {
    const name = String((def && def.name) || '');
    const builtin = ALL_DEFS.some((d) => d.function.name === name) || extras.NAMES.has(name);
    if (builtin || this.pluginFns[name]) throw new Error('工具名已经被占用：' + name);
    this.pluginDefs.push({ type: 'function', function: { name, description: String(def.description || ''), parameters: def.parameters || { type: 'object', properties: {} } } });
    this.pluginFns[name] = { plugin: pluginName, fn };
    return name;
  }

  pluginToolNames() {
    return Object.keys(this.pluginFns);
  }

  // 插件热重载前先清干净，免得同一个工具名注册两遍
  clearPluginTools() {
    this.pluginDefs = [];
    this.pluginFns = {};
  }

  defs() {
    const cfg = this.ctx.cfg || {};
    const allowed = (cfg.tools && cfg.tools.names) || null;
    const all = ALL_DEFS.concat(this.pluginDefs);
    const base = allowed ? all.filter((d) => allowed.includes(d.function.name)) : all;
    return base.filter((d) => {
      const feat = extras.FEATURE_OF[d.function.name];
      const f = cfg.features || {};
      return !feat || f[feat] !== false;
    });
  }

  async run(name, args, opts) {
    opts = opts || {};
    const ctx = this.ctx;
    const workspace = ctx.workspace;
    const confirmed = opts.confirmed === true;

    const verdict = safety.check(name, args, { workspace, confirmed });
    const auditLine = ctx.audit({
      tool: name,
      args,
      level: verdict.level,
      allowed: verdict.allowed,
      reason: verdict.reason
    });
    if (!verdict.allowed) {
      if (verdict.level !== 'P0') this.pending = { tool: name, args, at: Date.now() };
      return verdict.note;
    }
    this.pending = null;

    try {
      if (this.pluginFns[name]) {
        return await this.pluginFns[name].fn(args || {}, { confirmed, plugin: this.pluginFns[name].plugin });
      }
      if (extras.NAMES.has(name)) {
        return await extras.run(name, args, Object.assign({}, ctx, { confirmed, configPath: ctx.configPath }));
      }
      switch (name) {
        case 'read_file': return this.readFile(args);
        case 'write_file': return this.writeFile(args);
        case 'list_dir': return this.listDir(args);
        case 'run_command': return await this.runCommand(args, opts);
        case 'remember': return this.remember(args);
        case 'recall': return await this.recall(args);
        case 'event_timeline': return this.timeline(args);
        case 'remind': return this.remind(args);
        default: return '没有这个工具：' + name;
      }
    } catch (e) {
      auditLine.error = e.message;
      return '工具出错：' + e.message;
    }
  }

  readFile(args) {
    const r = safeResolve(this.ctx.workspace, stripWorkspacePrefix(this.ctx.root || path.join(this.ctx.workspace, '..', '..'), args.path));
    if (!fs.existsSync(r.abs)) return '文件不存在：' + args.path + '（工作目录里没有这个文件，别猜内容）';
    const st = fs.statSync(r.abs);
    if (st.isDirectory()) return '这是个目录，用 list_dir 看。';
    if (st.size > 512 * 1024) return '文件太大（' + Math.round(st.size / 1024) + 'KB），先只看一部分。';
    return fs.readFileSync(r.abs, 'utf8');
  }

  writeFile(args) {
    const r = safeResolve(this.ctx.workspace, stripWorkspacePrefix(this.ctx.root || path.join(this.ctx.workspace, '..', '..'), args.path));
    ensureDir(path.dirname(r.abs));
    fs.writeFileSync(r.abs, String(args.content == null ? '' : args.content), 'utf8');
    return '写了 ' + args.path + '（' + fs.statSync(r.abs).size + ' 字节）';
  }

  listDir(args) {
    const r = safeResolve(this.ctx.workspace, stripWorkspacePrefix(this.ctx.root || path.join(this.ctx.workspace, '..', '..'), args.path || '.'));
    if (!fs.existsSync(r.abs)) return '目录不存在：' + (args.path || '.');
    const items = fs.readdirSync(r.abs, { withFileTypes: true }).slice(0, 100).map((d) => (d.isDirectory() ? d.name + '/' : d.name));
    return items.length ? items.join('\n') : '（空目录）';
  }

  async runCommand(args, opts) {
    const cfg = this.ctx.cfg || {};
    const t = cfg.tools || {};
    if (t.allowCommand === false) return '命令执行被配置关掉了（config.tools.allowCommand=false）。';
    const wl = t.commandWhitelist || ['echo', 'dir', 'type', 'node', 'python', 'git', 'where', 'ls', 'cat'];
    if (!commandAllowed(args.command, wl)) {
      return '这条命令不在白名单里（只允许：' + wl.join('、') + '）。'
        + '想加就在 config.json 的 tools.commandWhitelist 里加，别让我硬跑。';
    }
    const res = sandbox.run(args.command, {
      workspace: this.ctx.workspace,
      sandboxMode: (cfg.sandbox && cfg.sandbox.mode) || 'none',
      timeoutMs: (t.commandTimeoutMs) || 30000,
      maxOutput: (t.maxOutput) || 12000,
      dockerImage: cfg.sandbox && cfg.sandbox.image
    });
    return '[sandbox=' + res.mode + '] ' + (res.note ? '(' + res.note + ') ' : '')
      + (res.ok ? '' : '（退出码 ' + res.code + '）') + '\n' + (res.output || '（无输出）');
  }

  remember(args) {
    const it = this.ctx.store.add({
      text: userFact(args.text),
      kind: args.kind,
      importance: args.importance,
      pinned: args.pinned,
      source: 'tool'
    });
    if (!it) return '这句话是空的，没记。';
    if (it.pinned) {
      return '记住了（★钉住）：' + truncate(it.text, 80);
    }
    return '记住了：' + truncate(it.text, 80) + '（重要性 ' + it.importance + '/4）';
  }

  async recall(args) {
    const r = await this.ctx.recall(args.query, { topK: 5 });
    if (!r.hits.length) return '记忆库里没搜到相关的事。';
    return r.hits.map((h) => '- ' + (h.pinned ? '★' : '') + h.text).join('\n');
  }

  timeline(args) {
    const list = this.ctx.events.timeline(Math.min(Number(args.limit) || 6, 20));
    if (!list.length) return '还没有事件（记忆攒起来之后会自己串成事件）。';
    return list.map((e) => '- [' + e.start.slice(0, 10) + ' → ' + e.end.slice(0, 10) + '] ' + e.title + '（' + e.memories + ' 条）').join('\n');
  }

  remind(args) {
    const list = readJson(this.remindFile, []);
    let due;
    if (args.in_minutes) due = new Date(Date.now() + Number(args.in_minutes) * 60000);
    else if (args.when && /^\d{1,2}:\d{2}$/.test(args.when)) {
      const [h, m] = args.when.split(':').map(Number);
      const d = new Date();
      d.setHours(h, m, 0, 0);
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
      due = d;
    } else due = new Date(Date.now() + 30 * 60000);
    const item = { id: 'rem_' + Date.now().toString(36), text: String(args.text || '').slice(0, 200), due_at: due.toISOString(), done: false, created_at: nowIso() };
    list.push(item);
    writeJson(this.remindFile, list);
    return '定了：' + item.text + '（' + item.due_at.slice(0, 16).replace('T', ' ') + '）';
  }

  dueReminders() {
    const list = readJson(this.remindFile, []);
    const due = list.filter((x) => !x.done && Date.parse(x.due_at) <= Date.now());
    if (due.length) {
      for (const x of due) x.done = true;
      writeJson(this.remindFile, list);
    }
    return due;
  }
}

module.exports = { Tools, DEFS, commandAllowed, safeResolve };
