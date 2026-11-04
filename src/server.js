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
 *
 * 默认只听 127.0.0.1，别自己暴露到公网——这版没有登录鉴权。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { Her, toUserFact } = require('./core');
const qq = require('./qq/adapter');
const qqConnect = require('./qq/connect');
const attach = require('./attach');
const { NAME_RE } = require('./plugins');
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
// 用户希望她怎么称呼自己：记忆的人称识别按这个认，默认「主人」
try {
  const { setOwnerAliases } = require('./util');
  setOwnerAliases(cfg.ownerAliases);
} catch (e) {}
const CONFIG_FILE = process.env.JQ_CONFIG ? path.resolve(ROOT, process.env.JQ_CONFIG) : path.join(ROOT, 'config.json');
const her = new Her({ root: ROOT, cfg });
// 上次没提炼成的，服务起来后补一次（失败不丢、可追溯）
try { her.retryDistillQueue().catch(() => {}); } catch (e) {}
// 记忆每日自动快照（每天第一次启动时做，留最近 7 份）
try { her.snapshotMemory(); } catch (e) {}
// MCP 客户端：配置了才启动，起不来只影响它自己的工具
try { her.initMcp().catch(() => {}); } catch (e) {}
// OneBot WS 直连（SnowLuma / NapCat / LLOneBot 都讲这个）：配置 qq.kind=onebot-ws 才启动；默认 dryRun 只记不回
let snowluma = null;
try {
  const q = cfg.qq || {};
  if (q.enabled && (q.kind === 'onebot-ws' || q.kind === 'snowluma')) {
    const { OneBotWsBridge } = require('./qq/onebot-ws');
    if (q.httpUrl && !q.gateway) q.gateway = q.httpUrl;
    snowluma = new OneBotWsBridge({
      wsUrl: q.wsUrl || 'ws://127.0.0.1:3001',
      token: q.accessToken || q.token || '',
      dryRun: !!q.dryRun,
      logFile: path.join(her.dataDir, 'qq-onebot-ws.log'),
      onEvent: async (ev) => {
        try {
          const d = await qq.incoming({ cfg, her, dataDir: her.dataDir, ev });
          if (d && d.ok && d.reply) {
            await qq.send({ cfg, dataDir: her.dataDir, to: d.peer, text: d.reply, group: d.kind === 'group', bridge: snowluma });
          }
        } catch (e) { /* 单条失败不影响连接 */ }
      }
    });
    snowluma.start();
  }
} catch (e) { console.log('  ! SnowLuma 桥接没起来：' + e.message); }
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

function isLocal(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// 中控台/切换/重置都只给本机：这版没有登录鉴权，暴露出去等于把配置白送
function denyRemote(res) {
  return json(res, 403, { ok: false, error: '这个接口只给本机用' });
}

function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return null; }
}

// 从 chat/completions 地址推出这一家的模型列表地址
function modelsUrl(base) {
  const s = String(base || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(s)) return s.replace(/\/chat\/completions$/i, '/models');
  if (/\/v1$/i.test(s)) return s + '/models';
  return s + '/models';
}

// 拿不到列表时给的常见模型（只当建议，用户可以自己填）
function presetModels(base) {
  const b = String(base || '').toLowerCase();
  if (b.indexOf('bigmodel') >= 0) return ['glm-4-flash', 'glm-4-air', 'glm-4-plus', 'glm-4v-flash'];
  if (b.indexOf('deepseek') >= 0) return ['deepseek-chat', 'deepseek-reasoner'];
  if (b.indexOf('siliconflow') >= 0) return ['Qwen/Qwen3-8B', 'deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-7B-Instruct'];
  if (b.indexOf('11434') >= 0 || b.indexOf('ollama') >= 0) return ['qwen3-8b', 'qwen2.5:7b'];
  return [];
}

// 问模型列表失败时也给人话：401 就说 key，别让人对着「HTTP 401」猜
function explainModelListError(status, raw) {
  const st = Number(status) || 0;
  if (st === 401 || st === 403) return 'key 不对或没权限（这家回 ' + st + '）。粘 key 时别带空格，也别用别人的 key。';
  if (st === 402) return '这家账户余额不足（402）。去这家后台充点，或者先换一家。';
  if (st === 404) return '这家没有「列模型」的接口（404）。可以直接手填模型名，不影响用。';
  if (st === 429) return '这家在限流（429）。等一分钟再试。';
  if (st >= 500) return '这家服务器出错了（' + st + '）。过几分钟再试。';
  const msg = String(raw || '');
  if (/timeout|fetch failed|ENOTFOUND|ECONN|EAI_AGAIN|网络|abort/i.test(msg)) return '连不上这家的服务器。看一下网络，或核对接口地址。';
  return '这家没给模型列表（HTTP ' + st + '）。';
}

// 用这把 key 问服务商：你能用哪些模型（只说能问到的，问不到就给预设，绝不编）
async function listModels(base, key) {
  const url = modelsUrl(base);
  const preset = presetModels(base);
  try {
    const headers = {};
    if (key) headers.authorization = 'Bearer ' + key;
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      return { ok: false, error: explainModelListError(r.status, ''), models: preset, source: 'preset', url };
    }
    const j = await r.json();
    let list = [];
    if (Array.isArray(j.data)) list = j.data.map((x) => x.id || x.name).filter(Boolean);
    else if (Array.isArray(j.models)) list = j.models.map((x) => x.id || x.name || x.model).filter(Boolean);
    list = Array.from(new Set(list.map(String))).sort();
    if (!list.length) return { ok: false, error: '接口通了，但这家没返回模型名。可以直接手填一个。', models: preset, source: 'preset', url };
    return { ok: true, models: list, source: 'list', url };
  } catch (e) {
    return { ok: false, error: explainModelListError(0, e.message), models: preset, source: 'preset', url };
  }
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
        images: at ? at.images : [],
        mode: body.mode === 'chat' || body.mode === 'work' ? body.mode : undefined,
        entry: ['desktop', 'qq', 'mcp'].indexOf(String(body.entry || '')) >= 0 ? String(body.entry) : 'desktop',
        speaker: (body.speaker && typeof body.speaker === 'object')
          ? { id: String(body.speaker.id || ''), name: String(body.speaker.name || '').slice(0, 40), owner: !!body.speaker.owner }
          : undefined
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

  // ---------- 用这把 key 能用的模型（接上密钥先问用哪个模型） ----------
  if (p === '/api/models' && req.method === 'POST') {
    if (!isLocal(req)) return denyRemote(res);
    const body = await readBody(req);
    let pr = body.provider || null;
    const cfgNow = readConfigFile();
    if (!pr && body.name && cfgNow) {
      pr = (cfgNow.providers || []).filter((x) => x.name === String(body.name))[0] || null;
    }
    if (!pr && body.base) pr = { name: body.name || '', base: body.base, key: body.key || '' };
    if (!pr || !pr.base) return json(res, 400, { ok: false, error: '缺 base（这一家的接口地址）' });
    let key = String(pr.key || '');
    if ((!key || key.indexOf('****') >= 0) && cfgNow) {
      const hit = (cfgNow.providers || []).filter((x) => x.name === pr.name)[0];
      if (hit) key = hit.key || '';
    }
    const out = await listModels(pr.base, key);
    return json(res, 200, Object.assign({ provider: pr.name || '' }, out));
  }

  // ---------- 模型切换：改完立刻生效，不用重启 ----------
  if (p === '/api/route' && req.method === 'GET') {
    const cost = her.router.costSummary(1);
    return json(res, 200, Object.assign({ ok: true }, her.router.routeState(), { cost: cost.today, currency: cost.currency }));
  }
  if (p === '/api/route' && req.method === 'POST') {
    if (!isLocal(req)) return denyRemote(res);
    const body = await readBody(req);
    const cur = readConfigFile();
    if (!cur) return json(res, 500, { ok: false, error: 'config.json 读不出来' });
    const nextRoute = Object.assign({ mode: 'cheap-first', order: [], escalate: true }, her.router.route, {});
    if (body.mode !== undefined) nextRoute.mode = String(body.mode);
    if (Array.isArray(body.order)) nextRoute.order = body.order.map(String);
    if (typeof body.escalate === 'boolean') nextRoute.escalate = body.escalate;
    if (typeof body.pin === 'string' && body.pin) {
      nextRoute.mode = 'fixed';
      nextRoute.order = [body.pin].concat((nextRoute.order || []).filter((n) => n !== body.pin));
    }
    if (['cheap-first', 'cloud-first', 'fixed'].indexOf(nextRoute.mode) < 0) {
      return json(res, 400, { ok: false, error: 'mode 只能是 cheap-first / cloud-first / fixed' });
    }
    const names = her.router.providers.map((x) => x.name);
    const bad = (nextRoute.order || []).filter((n) => names.indexOf(n) < 0);
    if (bad.length) return json(res, 400, { ok: false, error: '不认识的提供方：' + bad.join('、') });
    cur.route = Object.assign({}, cur.route, { mode: nextRoute.mode, order: nextRoute.order, escalate: nextRoute.escalate !== false });
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cur, null, 2), 'utf8'); }
    catch (e) { return json(res, 500, { ok: false, error: '写 config.json 失败：' + e.message }); }
    her.router.setRoute(cur.route);
    her.router.routeLog('切换模型', { mode: cur.route.mode, order: cur.route.order });
    return json(res, 200, Object.assign({ ok: true, applied: true, restartNeeded: false }, her.router.routeState()));
  }

  // ---------- 对话 / 工作 模式：三个入口各管各的，热切换不用重启 ----------
  const modeEntry = (v) => (['desktop', 'qq', 'mcp'].indexOf(String(v || '')) >= 0 ? String(v) : 'desktop');
  if (p === '/api/mode' && req.method === 'GET') {
    const entry = modeEntry(url.searchParams.get('entry'));
    return json(res, 200, { ok: true, entry, mode: her.modeFor(entry), modes: her.cfg.modes || {} });
  }
  if (p === '/api/mode' && req.method === 'POST') {
    if (!isLocal(req)) return denyRemote(res);
    const body = await readBody(req);
    const entry = modeEntry(body.entry);
    const mode = String(body.mode || '');
    if (mode !== 'chat' && mode !== 'work') {
      return json(res, 400, { ok: false, error: '模式只能是 chat（对话）或 work（工作）' });
    }
    let cur;
    try { cur = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch (e) { return json(res, 500, { ok: false, error: 'config.json 读不出来' }); }
    cur.modes = Object.assign({}, cur.modes, { [entry]: mode });
    if (entry === 'desktop') cur.mode = mode;   // 老字段留着，旧版本也读得懂
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cur, null, 2), 'utf8'); }
    catch (e) { return json(res, 500, { ok: false, error: '存模式失败：' + e.message }); }
    her.cfg.modes = cur.modes;
    if (entry === 'desktop') her.cfg.mode = mode;
    try { her.resetSessionProviders(); } catch (e) {}
    her.router.routeLog('切换模式', { entry, mode });
    return json(res, 200, {
      ok: true, applied: true, restartNeeded: false, entry, mode, modes: cur.modes,
      label: (entry === 'desktop' ? '' : entry + ' ') + (mode === 'chat' ? '对话模式' : '工作模式')
    });
  }

  // ---------- 账单：今日/近 N 天 + 重置（只打水位，不删原账） ----------
  if (p === '/api/cost' && req.method === 'GET') {
    const days = Number(url.searchParams.get('days')) || 7;
    return json(res, 200, Object.assign({ ok: true }, her.router.costSummary(days)));
  }
  if (p === '/api/cost/reset' && req.method === 'POST') {
    if (!isLocal(req)) return denyRemote(res);
    const r = her.router.resetCost();
    return json(res, 200, { ok: true, reset: { at: r.at, day: r.day }, cost: her.router.costSummary(1).today });
  }

  // ---------- 插件模组（只给本机；插件同进程运行，只装信得过的） ----------
  if (p === '/api/plugins' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      dir: her.plugins.dir,
      enabled: her.plugins.enabledList(),
      tools: her.tools.pluginToolNames(),
      items: her.plugins.list()
    });
  }
  if (p.indexOf('/api/plugins/') === 0 && req.method === 'POST') {
    if (!isLocal(req)) return denyRemote(res);
    const body = await readBody(req);
    const act = p.slice('/api/plugins/'.length);
    if (act === 'enable' || act === 'disable') {
      const name = String(body.name || '');
      if (!NAME_RE.test(name)) return json(res, 400, { ok: false, error: '插件名不合法' });
      her.plugins.setEnabled(name, act === 'enable');
      her.plugins.load();
      return json(res, 200, {
        ok: true, name, enabled: act === 'enable', applied: true, restartNeeded: false,
        tools: her.tools.pluginToolNames(), items: her.plugins.list()
      });
    }
    if (act === 'reload') {
      her.plugins.load();
      return json(res, 200, { ok: true, tools: her.tools.pluginToolNames(), items: her.plugins.list() });
    }
    if (act === 'install') {
      const r = her.plugins.install(body.path);
      if (!r.ok) return json(res, 200, r);
      return json(res, 200, Object.assign({ ok: true, installed: true, hint: '装好了，还要在列表里点「启用」才会加载' }, r));
    }
    if (act === 'uninstall') {
      const r = her.plugins.uninstall(body.name);
      if (!r.ok) return json(res, 200, r);
      her.plugins.load();
      return json(res, 200, { ok: true, removed: r.name, tools: her.tools.pluginToolNames() });
    }
    if (act === 'ui') {
      try {
        const out = await her.plugins.callUi(String(body.name || ''), body.args || {});
        return json(res, 200, { ok: true, result: out });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message });
      }
    }
    return json(res, 404, { ok: false, error: '没有这个插件操作：' + act });
  }
  // 插件自己注册的接口：/api/plugin/<插件名>/<路径>
  if (p.indexOf('/api/plugin/') === 0) {
    if (!isLocal(req)) return denyRemote(res);
    const rest = p.slice('/api/plugin/'.length);
    const cut = rest.indexOf('/');
    const name = cut < 0 ? rest : rest.slice(0, cut);
    const sub = cut < 0 ? '' : rest.slice(cut + 1);
    const fn = her.plugins.route(name, req.method, sub);
    if (!fn) return json(res, 404, { ok: false, error: '插件里没有这个接口：' + p });
    try {
      const q = {};
      url.searchParams.forEach((v, k) => { q[k] = v; });
      const out = await fn({
        method: req.method,
        path: sub,
        query: q,
        body: req.method === 'POST' ? await readBody(req) : {}
      });
      return json(res, 200, { ok: true, result: out });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }

  if (p === '/api/sessions' && req.method === 'DELETE') {
    if (!isLocal(req)) return denyRemote(res);
    const id = String(url.searchParams.get('id') || '').trim();
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(id)) return json(res, 400, { ok: false, error: '会话 id 不合法' });
    const dir = path.join(her.dataDir, 'sessions');
    const file = path.join(dir, id + '.json');
    if (path.dirname(file) !== dir) return json(res, 400, { ok: false, error: '会话 id 不合法' });
    let existed = false;
    try { fs.unlinkSync(file); existed = true; }
    catch (e) { return json(res, 200, { ok: false, error: '这个会话已经不在了，刷新一下列表看看' }); }
    try { fs.unlinkSync(path.join(dir, id + '.summary.md')); } catch (e) {}
    return json(res, 200, { ok: true, deleted: id, existed });
  }

  // ---------- 人物表（认人用；默认 owner=主人） ----------
  if (p === '/api/people' && req.method === 'GET') {
    return json(res, 200, { ok: true, people: her.people.list() });
  }
  if (p === '/api/people' && req.method === 'POST') {
    if (!isLocal(req)) return denyRemote(res);
    const body = await readBody(req);
    if (body.remove) return json(res, 200, her.people.remove(String(body.remove)));
    return json(res, 200, her.people.upsert(body));
  }

  if (p === '/api/memory' && req.method === 'GET') {
    const q = String(url.searchParams.get('query') || '').slice(0, 500);
    const person = url.searchParams.get('person');
    if (q) {
      const r = await her.recallBlock(q);
      return json(res, 200, { ok: true, query: q, used_vector: r.used_vector, hits: r.hits });
    }
    let items = her.store.active();
    if (person) items = items.filter((x) => (x.person || 'owner') === person);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const all = items.slice().reverse();
    return json(res, 200, {
      ok: true,
      count: all.length,
      total: all.length,
      offset,
      limit,
      people: her.people.list(),
      items: all.slice(offset, offset + limit)
    });
  }

  if (p === '/api/memory' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.text) return json(res, 400, { ok: false, error: '缺少 text' });
    // 走和自动记忆同一套人称：接口塞进来的「我的…」也要落成「用户的…」，
    // 否则会被当成鲸倩自己的事，问起来反而说「没记着」。
    const text = toUserFact(String(body.text));
    const it = her.store.add({ text, kind: body.kind, importance: body.importance, pinned: body.pinned, source: 'api' });
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
      const r = await qq.send({ cfg, dataDir: her.dataDir, to: body.to, text: body.text, group: !!body.group, bridge: snowluma });
      return json(res, 200, r);
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }

  // ---------- 会话列表：能翻以前的对话、按关键词搜 ----------
  if (p === '/api/sessions') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
    const query = String(url.searchParams.get('query') || '').trim().toLowerCase().slice(0, 200);
    const dir = path.join(her.dataDir, 'sessions');
    let items = [];
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { files = []; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      // 测试/自检跑出来的会话别混进「以前的对话」（要看得传 includeTests=1）
      if (!url.searchParams.get('includeTests')
        && /^(quality|test|guard|cap|flow|dbg|multi|fix|people|clean|say-then|renchen|web[0-9]|speed|final|p[0-9]|f[0-9]|bm|q[0-9])/i.test(id)) continue;
      let j = null;
      let stat = null;
      try {
        stat = fs.statSync(path.join(dir, f));
        j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch (e) { continue; }
      const raw = Array.isArray(j) ? j : ((j && j.messages) || []);
      const msgs = raw.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim());
      if (!msgs.length) continue;
      const firstUser = msgs.find((m) => m.role === 'user');
      const head = String((firstUser || msgs[0]).content).replace(/\s+/g, ' ').trim();
      const hit = query ? msgs.some((m) => String(m.content || '').toLowerCase().indexOf(query) >= 0) : true;
      if (!hit) continue;
      const last = msgs[msgs.length - 1];
      let summary = '';
      try { summary = String(her.loadSummary(id) || '').replace(/\s+/g, ' ').trim(); } catch (e) { summary = ''; }
      items.push({
        id,
        title: truncate(head, 48) || '(没写字的对话)',
        count: msgs.length,
        last_role: last.role,
        preview: truncate(String(last.content || '').replace(/\s+/g, ' ').trim(), 80),
        summary: truncate(summary, 120),
        updated_at: (j && j.updated_at) || (stat ? stat.mtime.toISOString() : '')
      });
    }
    items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return json(res, 200, { ok: true, query, count: items.length, items: items.slice(0, limit) });
  }

  if (p === '/api/history') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 40, 200);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    let msgs = [];
    try {
      const f = path.join(her.dataDir, 'sessions', (url.searchParams.get('session') || 'web') + '.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      msgs = Array.isArray(j) ? j : (j.messages || []);
    } catch (e) { msgs = []; }
    const all = msgs.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim());
    const end = Math.max(0, all.length - offset);
    const start = Math.max(0, end - limit);
    const items = all.slice(start, end).map((m) => ({ role: m.role, content: String(m.content) }));
    return json(res, 200, { ok: true, count: items.length, total: all.length, offset, has_more: start > 0, items });
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

    const cfgFile = CONFIG_FILE;
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
      // 人格：一段自由文本；空字符串 = 回到内置默认人格
      if (typeof body.persona === 'string') {
        if (body.persona.length > 8000) {
          return json(res, 400, { ok: false, error: '人格太长了（最多 8000 字）。写短点就够：她是谁、怎么说话。' });
        }
        if (body.persona.trim()) next.persona = body.persona;
        else delete next.persona;
        // 人格热生效，不用重启：改完下一句就是新的人格
        if (next.persona) her.cfg.persona = next.persona; else delete her.cfg.persona;
      }
      // 语音：朗读开关/声音/语速（软件版用，网页版不读）
      if (body.voice && typeof body.voice === 'object') {
        next.voice = Object.assign({ enabled: false, voice: '', rate: 0 }, next.voice || {}, {
          enabled: !!body.voice.enabled,
          voice: String(body.voice.voice || ''),
          rate: Number(body.voice.rate) || 0
        });
      }
      if (body.sandbox) next.sandbox = Object.assign({}, next.sandbox, { mode: String(body.sandbox.mode || 'none') });
      // 功能开关（从私有版迁来的：触手/子智能体/说话/看图/事件）
      if (body.features && typeof body.features === 'object') {
        const f = {};
        for (const k of ['tentacle', 'subagent', 'speak', 'vision', 'events']) {
          if (body.features[k] !== undefined) f[k] = !!body.features[k];
        }
        next.features = Object.assign({}, next.features, f);
      }
      if (body.qq) {
        // QQ 适配层配置（默认关）：网关地址/令牌/白名单/群白名单
        next.qq = Object.assign({}, next.qq, {
          enabled: !!body.qq.enabled,
          kind: body.qq.kind ? String(body.qq.kind) : String((next.qq && next.qq.kind) || 'onebot-http'),
          gateway: String(body.qq.gateway || ''),
          wsUrl: body.qq.wsUrl !== undefined ? String(body.qq.wsUrl || '') : String((next.qq && next.qq.wsUrl) || ''),
          httpUrl: body.qq.httpUrl !== undefined ? String(body.qq.httpUrl || '') : String((next.qq && next.qq.httpUrl) || ''),
          accessToken: body.qq.accessToken !== undefined ? String(body.qq.accessToken || '') : String((next.qq && next.qq.accessToken) || ''),
          dryRun: body.qq.dryRun !== undefined ? !!body.qq.dryRun : !!(next.qq && next.qq.dryRun),
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
          // 掩码（含 ****）就沿用原来的 key，别把真 key 覆盖掉；按名字找，删过一家也不会错位
          if (!raw || raw.includes('****')) {
            const prev = old.find((x) => x && x.name === pr.name) || old[i];
            merged.key = (prev && prev.key) || '';
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

  // 自更新：先只做「检查」（读 config.update.manifestUrl 的公开清单），下载/覆盖交给安装器
  if (p === '/api/update/check') {
    try {
      const pk = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      const conf = cfg.update || {};
      if (!conf.manifestUrl) return json(res, 200, { ok: false, error: '没配置更新源（config.json 的 update.manifestUrl）' });
      let man;
      if (/^[a-zA-Z]:[\\/]/.test(conf.manifestUrl) || conf.manifestUrl.startsWith('file:')) {
        man = JSON.parse(fs.readFileSync(conf.manifestUrl.replace(/^file:\/\//, ''), 'utf8'));
      } else {
        const r = await fetch(conf.manifestUrl, { signal: AbortSignal.timeout(15000), headers: { 'cache-control': 'no-cache' } });
        if (!r.ok) throw new Error('更新源 HTTP ' + r.status);
        man = await r.json();
      }
      return json(res, 200, {
        ok: true,
        current: pk.version,
        latest: String(man.version || ''),
        notes: String(man.notes || ''),
        url: String(man.url || conf.url || ''),
        newer: String(man.version || '') !== String(pk.version || '')
      });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
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

// 默认 16KB 的头装不下超长搜索词（中文编码后更占地方），抬高一点，超长了再在下面截断
const server = http.createServer({ maxHeaderSize: 64 * 1024 }, async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
});

// 端口被占时别甩一屏 Node 调用栈：告诉他下一步该干什么
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('');
    console.error('  端口 ' + PORT + ' 已经被占用了。多半是鲸倩已经开着一份（看看任务栏），或者别的程序占了这个端口。');
    console.error('  怎么办：先关掉旧的那份再双击；要换端口就改 config.json 里的 port，或者设环境变量 PORT。');
    console.error('');
    process.exit(1);
  }
  console.error('');
  console.error('  服务起不来：' + (e && e.message ? e.message : e));
  console.error('');
  process.exit(1);
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
  her.startIdleConsolidate((cfg.memory && cfg.memory.idleConsolidateMinutes) || 60);
});

process.on('SIGINT', () => { console.log('\n 收到 Ctrl+C，收工。'); server.close(() => process.exit(0)); });
