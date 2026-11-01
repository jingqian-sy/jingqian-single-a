'use strict';
/*
 * 本地 HTTP 服务：一个页面 + 几个 API，够用就好。
 *
 *   GET  /                 极简聊天页
 *   POST /api/chat         { message, session }  → { reply, stats }
 *   GET  /api/selfcheck    启动自检
 *   GET  /api/memory       记忆列表 / ?query= 检索
 *   POST /api/memory       手动写一条记忆
 *   GET  /api/timeline     事件时间轴
 *   POST /api/consolidate  立刻整理一次记忆
 *   GET  /api/stats        账本 + 审计计数 + 记忆数
 *   GET  /api/audit?limit= 最近审计
 *   GET  /api/radar        免费模型雷达：{ new: [...] }（只读缓存，不联网）
 *   POST /api/radar/ack    { ids:[...] } 或 { all:true } → 记为已读
 *
 * 默认只听 127.0.0.1，别自己暴露到公网——这版没有登录鉴权。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { Her } = require('./core');
const qq = require('./qq/adapter');
const qqConnect = require('./qq/connect');
const radar = require('./radar');
const attach = require('./attach');
const { readJson, ensureDir, truncate } = require('./util');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function loadConfig() {
  const example = path.join(ROOT, 'config.example.json');
  // CI / 演示可以用 JQ_CONFIG 指定另一份配置，免得覆盖你自己的 config.json
  const real = process.env.JQ_CONFIG ? path.resolve(ROOT, process.env.JQ_CONFIG) : path.join(ROOT, 'config.json');
  const base = readJson(example, {});
  const user = readJson(real, null);
  if (!user) {
    // 没配置也要能起来：用样例的壳，聊天时会明确提示先填 key
    return Object.assign({}, base, { _missing_config: true });
  }
  const cfg = Object.assign({}, base, user);
  cfg.providers = (user.providers || base.providers || []).map((p) => Object.assign({}, p, {
    key: (p.env && process.env[p.env]) ? process.env[p.env] : p.key
  }));
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  return cfg;
}

const cfg = loadConfig();
const CONFIG_FILE = process.env.JQ_CONFIG ? path.resolve(ROOT, process.env.JQ_CONFIG) : path.join(ROOT, 'config.json');
const her = new Her({ root: ROOT, cfg });
let lastChat = null;
const PORT = Number(process.env.PORT || cfg.port || 7889);
const HOST = cfg.host || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2 * 1024 * 1024) { reject(new Error('请求太大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (p === '/api/chat' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.message && !(Array.isArray(body.attachments) && body.attachments.length)) {
      return json(res, 400, { ok: false, error: '缺少 message' });
    }
    // 拖进输入栏的文件：只读本地文件，不联网；文本接进这轮对话，图片走多模态
    let at = null;
    if (Array.isArray(body.attachments) && body.attachments.length) {
      at = attach.describe(body.attachments);
      if (!at.files.length && !at.images.length) {
        return json(res, 200, {
          ok: false,
          error: '这些附件都没读成：' + at.skipped.map((s) => s.reason).join('；'),
          code: 'ATTACH_FAILED'
        });
      }
    }
    try {
      const r = await her.chat(String(body.message || ''), {
        sessionId: body.session || 'web',
        attachBlock: at ? at.block : '',
        images: at ? at.images : []
      });
      // 给软件版底部数据栏用的「真实」最后一次调用数据（没有的字段不硬造）
      lastChat = {
        at: new Date().toISOString(),
        tokens: Number(r.stats.total_tokens || 0),
        prompt_tokens: Number(r.stats.prompt_tokens || 0),
        completion_tokens: Number(r.stats.completion_tokens || 0),
        ms: Number(r.stats.ms || 0),
        provider: r.stats.provider || '',
        steps: Number(r.stats.steps || 0),
        cache_rate: (r.stats.cache_rate === null || r.stats.cache_rate === undefined) ? null : r.stats.cache_rate
      };
      return json(res, 200, {
        ok: true, reply: r.reply, stats: r.stats, memory: r.memory, trace: r.trace || [],
        attachments: at ? at.files.map((f) => ({ name: f.name, kind: f.kind, size: f.size })) : [],
        attachSkipped: at ? at.skipped : []
      });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, code: e.code || 'CHAT_FAILED' });
    }
  }

  if (p === '/api/selfcheck') return json(res, 200, her.selfcheck());

  // ---------- 免费模型雷达（只读缓存；扫描在后台定时跑，不在请求里联网） ----------
  if (p === '/api/radar' && req.method === 'GET') {
    const pd = radar.pending(her.dataDir, { cfg });
    return json(res, 200, {
      ok: true,
      enabled: pd.enabled,
      configured: pd.configured,
      at: pd.updated_at,
      new: pd.items
    });
  }

  if (p === '/api/radar/ack' && req.method === 'POST') {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (body.all !== true && !ids.length) return json(res, 400, { ok: false, error: '要么给 ids 数组，要么 all:true' });
    const r = radar.ack(her.dataDir, ids, body.all === true);
    return json(res, 200, { ok: true, ack: r.acked, remaining: r.remaining });
  }

  if (p === '/api/memory' && req.method === 'GET') {
    const q = url.searchParams.get('query');
    if (q) {
      const r = await her.recallBlock(q);
      return json(res, 200, { ok: true, query: q, used_vector: r.used_vector, hits: r.hits });
    }
    return json(res, 200, { ok: true, count: her.store.count(), items: her.store.active().slice(-50).reverse() });
  }

  if (p === '/api/memory' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.text) return json(res, 400, { ok: false, error: '缺少 text' });
    const it = her.store.add({ text: body.text, kind: body.kind, importance: body.importance, pinned: body.pinned, source: 'api' });
    try { her.events.build(her.store); } catch (e) {}
    return json(res, 200, { ok: true, item: it });
  }

  if (p === '/api/memory/archive' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.id) return json(res, 400, { ok: false, error: '缺少 id' });
    return json(res, 200, { ok: true, item: her.store.archive(body.id) });
  }

  // ---------- QQ 适配层（可选，默认关） ----------
  if (p === '/api/qq/discover' && req.method === 'GET') {
    try {
      const r = await qqConnect.discover(cfg, her.dataDir);
      return json(res, 200, r);
    } catch (e) {
      return json(res, 200, { found: false, error: e.message, hints: ['检测失败：' + e.message] });
    }
  }
  if (p === '/api/qq/connect' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const r = await qqConnect.connect({
        cfg, dataDir: her.dataDir, cfgFile: CONFIG_FILE,
        gateway: body.gateway, token: body.token
      });
      return json(res, 200, r);
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/qq/disconnect' && req.method === 'POST') {
    try {
      return json(res, 200, qqConnect.disconnect({ cfg, dataDir: her.dataDir, cfgFile: CONFIG_FILE }));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/qq/incoming' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const r = await qq.incoming({ cfg, her, dataDir: her.dataDir, ev: body });
      return json(res, 200, Object.assign({ source: 'qq' }, r));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/qq/send' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.text || !body.to) return json(res, 400, { ok: false, error: '缺 to / text' });
    try {
      const r = await qq.send({ cfg, dataDir: her.dataDir, to: body.to, text: body.text, group: !!body.group });
      return json(res, 200, r);
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }

  if (p === '/api/history') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 40, 200);
    let msgs = [];
    try {
      const f = path.join(her.dataDir, 'sessions', (url.searchParams.get('session') || 'web') + '.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      msgs = Array.isArray(j) ? j : (j.messages || []);
    } catch (e) { msgs = []; }
    const items = msgs.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
      .slice(-limit)
      .map((m) => ({ role: m.role, content: String(m.content) }));
    return json(res, 200, { ok: true, count: items.length, items });
  }

  if (p === '/api/timeline') {
    return json(res, 200, { ok: true, events: her.events.timeline(Number(url.searchParams.get('limit')) || 20) });
  }

  if (p === '/api/consolidate' && req.method === 'POST') {
    return json(res, 200, { ok: true, report: her.consolidate() });
  }

  if (p === '/api/audit') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
    let lines = [];
    try {
      const raw = fs.readFileSync(path.join(her.dataDir, 'audit.log'), 'utf8').trim();
      lines = raw ? raw.split('\n').slice(-limit).map((l) => { try { return JSON.parse(l); } catch (e) { return { raw: truncate(l, 200) }; } }) : [];
    } catch (e) { lines = []; }
    return json(res, 200, { ok: true, count: lines.length, items: lines.reverse() });
  }

  // ---------- 中控台：本机可读写配置（只认 127.0.0.1） ----------
  if (p.startsWith('/api/config')) {
    const ip = (req.socket && req.socket.remoteAddress) || '';
    const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!local) return json(res, 403, { ok: false, error: '中控台只给本机用' });

    const cfgFile = path.join(ROOT, 'config.json');
    const mask = (k) => {
      const v = String(k || '');
      if (!v) return '';
      if (v.length <= 8) return '********';
      return v.slice(0, 4) + '****' + v.slice(-4);
    };

    if (p === '/api/config' && req.method === 'GET') {
      let c = {};
      try { c = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { return json(res, 500, { ok: false, error: 'config.json 读不出来' }); }
      const safe = JSON.parse(JSON.stringify(c));
      for (const pr of (safe.providers || [])) pr.key = mask(pr.key);
      return json(res, 200, { ok: true, config: safe });
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { return json(res, 500, { ok: false, error: 'config.json 读不出来' }); }
      const next = JSON.parse(JSON.stringify(cur));
      if (body.port) next.port = Number(body.port);
      if (body.route) next.route = Object.assign({}, next.route, body.route);
      if (body.memory) next.memory = Object.assign({}, next.memory, body.memory);
      if (body.sandbox) next.sandbox = Object.assign({}, next.sandbox, { mode: String(body.sandbox.mode || 'none') });
      if (body.qq) {
        // QQ 适配层配置（默认关）：网关地址/令牌/白名单/群白名单
        next.qq = Object.assign({}, next.qq, {
          enabled: !!body.qq.enabled,
          gateway: String(body.qq.gateway || ''),
          token: String(body.qq.token || ''),
          allow: Array.isArray(body.qq.allow) ? body.qq.allow.map(String) : ((next.qq && next.qq.allow) || []),
          groups: Array.isArray(body.qq.groups) ? body.qq.groups.map(String) : ((next.qq && next.qq.groups) || []),
          self_id: String(body.qq.self_id || (next.qq && next.qq.self_id) || '')
        });
      }
      if (body.qqBridge) {
        // 兼容旧字段：QQ 桥接（可选，默认关）
        next.qqBridge = Object.assign({}, next.qqBridge, {
          enabled: !!body.qqBridge.enabled,
          url: String(body.qqBridge.url || ''),
          token: String(body.qqBridge.token || '')
        });
      }
      if (body.tools) {
        const t = Object.assign({}, next.tools, body.tools);
        if (Array.isArray(t.commandWhitelist)) t.commandWhitelist = t.commandWhitelist.map((x) => String(x).trim()).filter(Boolean);
        next.tools = t;
      }
      if (Array.isArray(body.providers)) {
        const old = cur.providers || [];
        next.providers = body.providers.map((pr, i) => {
          const merged = Object.assign({}, pr);
          const raw = String(pr.key || '');
          // 掩码（含 ****）就沿用原来的 key，别把真 key 覆盖掉
          if (!raw || raw.includes('****')) {
            merged.key = (old[i] && old[i].key) || '';
          }
          merged.enabled = pr.enabled !== false;
          return merged;
        }).filter((pr) => pr.name && pr.base);
      }
      fs.writeFileSync(cfgFile, JSON.stringify(next, null, 2), 'utf8');
      return json(res, 200, { ok: true, restartNeeded: true, message: '存好了，重启服务才生效（关掉窗口重开，或者 node src/server.js）' });
    }

    if (p === '/api/config/test' && req.method === 'POST') {
      const body = await readBody(req);
      const pr = body.provider || {};
      if (!pr.base) return json(res, 400, { ok: false, error: '缺 base' });
      let key = String(pr.key || '');
      if (!key || key.includes('****')) {
        const cur2 = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
        const hit = (cur2.providers || []).find((x) => x.name === pr.name);
        key = hit ? hit.key : '';
      }
      try {
        const t0 = Date.now();
        const r = await fetch(pr.base, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
          body: JSON.stringify({ model: pr.model, messages: [{ role: 'user', content: '只回两个字：通了' }], max_tokens: 16 })
        });
        const txt = await r.text();
        return json(res, 200, { ok: r.ok, status: r.status, ms: Date.now() - t0, sample: txt.slice(0, 200) });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message });
      }
    }
  }

  if (p === '/api/stats') {
    const today = her.router.today();
    const ledger = her.router.ledgerAll(30);
    const byLevel = {};
    try {
      const raw = fs.readFileSync(path.join(her.dataDir, 'audit.log'), 'utf8').trim();
      for (const line of raw ? raw.split('\n') : []) {
        try {
          const o = JSON.parse(line);
          const k = o.level + (o.allowed ? '·放行' : '·拦下');
          byLevel[k] = (byLevel[k] || 0) + 1;
        } catch (e) {}
      }
    } catch (e) {}
    return json(res, 200, {
      ok: true,
      server: { port: PORT, uptime_s: Math.round(process.uptime()) },
      providers: her.router.providers.map((x) => ({ name: x.name, model: x.model, tier: x.tier || 'cloud', ready: her.router.ready(x) })),
      ledger_today: today.total,
      ledger_providers_today: today.providers,
      ledger_days: ledger.slice(-14).map((d) => ({ date: d.date, calls: d.total.calls, tokens: d.total.prompt_tokens + d.total.completion_tokens, cost: Math.round(d.total.cost * 1e6) / 1e6 })),
      memory: { count: her.store.count(), events: her.events.all().length },
      audit: { by_level: byLevel },
      last: lastChat,
      sandbox: her.selfcheck().sandbox
    });
  }

  return json(res, 404, { ok: false, error: '没有这个接口：' + p });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const abs = path.resolve(PUBLIC, '.' + rel);
  if (!abs.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('找不到页面'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
});

ensureDir(her.dataDir);
server.listen(PORT, HOST, () => {
  const sc = her.selfcheck();
  console.log('');
  console.log('  鲸倩 · 单A 雏版');
  console.log('  ------------------------------');
  console.log('  地址      http://' + HOST + ':' + PORT);
  console.log('  模型      ' + (sc.providers.filter((p) => p.ready).map((p) => p.name + '/' + p.model).join('、') || '（还没配）'));
  console.log('  沙盒      ' + sc.sandbox.effective + '（配置 ' + sc.sandbox.configured + '）');
  console.log('  记忆      ' + sc.memory.count + ' 条 / 事件 ' + sc.memory.events + ' 件');
  console.log('  工作目录  ' + sc.workspace);
  if (sc.warnings.length) sc.warnings.forEach((w) => console.log('  ! ' + w));
  if (cfg._missing_config) console.log('  ! 没有 config.json，正在用 config.example.json 的默认值（run.cmd 会自动复制一份）');
  console.log('');
  // 免费模型雷达：启动后 60 秒跑一次，之后每 7 天一次；没配 sources 就等于不跑
  const radarJob = radar.startSchedule({
    cfg,
    dataDir: her.dataDir,
    onNew: (r) => console.log('  · 雷达：发现 ' + r.new.length + ' 个新的免费模型（在设置里看）')
  });
  if (radarJob) {
    console.log('  · 雷达：已排期（' + Math.round(radarJob.delay / 1000) + ' 秒后首次扫描，之后每 '
      + Math.round(radarJob.every / 86400000) + ' 天）');
  }
  her.startIdleConsolidate((cfg.memory && cfg.memory.idleConsolidateMinutes) || 60);
});

process.on('SIGINT', () => { console.log('\n 收到 Ctrl+C，收工。'); server.close(() => process.exit(0)); });
