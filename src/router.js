'use strict';
/*
 * 多模型路由 + 额度账本 + 失败回退
 *
 * 所有提供方都走 OpenAI 兼容的 /chat/completions 形状（云端 DeepSeek/智谱/火山、
 * 本地 Ollama 的 /v1 都是这个），所以换家只改配置，不改代码。
 *
 * 选路（route.mode）：
 *   cheap-first  先免费/本地，再按单价从低到高（默认）
 *   cloud-first  先云端，云端挂了才回落本地
 *   fixed        完全按 route.order 的顺序
 * 加一层难度判断（route.escalate）：话长、带「分析/设计/架构/为什么/代码」这类词，
 * 即使 cheap-first 也先上云端——粗活给本地，值钱的判断给云端。
 *
 * 每次调用都记账（data/ledger/按天.json），失败切换写 data/route.log。
 *
 * 额度闸门（见 ./quota）：免费档先把「本地账本算出来的剩余」和「一次极小探测」过一遍，
 * 用完的先跳过；免费全跳过就退付费档，连付费都没有就明确报错，不静默失败。
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, appendJsonl, ensureDir, tokenCount } = require('./util');
const quota = require('./quota');

const HARD_WORDS = /分析|设计|架构|方案|为什么|推理|排查|代码|重构|对比|评测|写一|规划|部署/;

function dayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 全挂的时候说人话：别把一串 HTTP 400 甩给用户
// 一条错误先归个类，再说人话：不要因为清单里有一家 401，就把「连不上」也说成 key 不对。
function failureReason(errorText) {
  const e = String(errorText || '');
  if (/\b401\b|\b403\b|unauthor|invalid.*key|鉴权|no permission|api.?key/i.test(e)) return 'key 不对或没权限';
  if (/\b402\b|\b429\b|quota|rate.?limit|insufficient|balance|额度|频率|余额/i.test(e)) return '额度或频率用完了';
  if (/timeout|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|socket|网络|abort/i.test(e)) return '连不上';
  if (/\b5\d\d\b|internal server|bad gateway|service unavailable|服务器/i.test(e)) return '服务器出错';
  if (/空回复|empty/i.test(e)) return '回了空的';
  return '失败';
}

function explainFailures(tried) {
  const list = Array.isArray(tried) ? tried : [];
  const any = list.length === 1 ? '这家' : '几家';
  const quant = list.length === 1 ? '' : '都';
  const rows = list.map((t) => ({ name: String(t.provider || ''), reason: failureReason(t.error) }));
  const names = rows.map((r) => r.name).filter(Boolean).join('、') || '所有模型';
  if (!rows.length) return '没有哪家能接上。先看看网络，再去设置里确认模型接好了。';
  const kinds = rows.map((r) => r.reason);
  const uniq = Array.from(new Set(kinds));
  if (uniq.length === 1) {
    const kind = uniq[0];
    if (kind === 'key 不对或没权限') return any + quant + '说 key 不对或没权限（' + names + '）。去设置里核对密钥，或者先换一家能用的。';
    if (kind === '额度或频率用完了') return any + quant + '说额度或频率用完了（' + names + '）。等一会儿再试，或者在设置里换一家。';
    if (kind === '连不上') return any + quant + '连不上（' + names + '）。看一下网络，或者本机 Ollama 起来没有。';
    if (kind === '服务器出错') return any + quant + '的服务器出错了（' + names + '）。多半是对方临时抽风，过几分钟再试。';
    if (kind === '回了空的') return any + quant + '回了空话（' + names + '）。换个说法再问一次试试。';
    return any + quant + '失败了（' + names + '）。' + (list[0].error ? '第一家的说法：' + String(list[0].error).slice(0, 80) : '');
  }
  // 原因不一样：谁哪样说清楚，别一句「都失败了」糊过去
  const detail = rows.map((r) => (r.name ? r.name + '：' : '') + r.reason).join('；');
  return any + quant + '失败了（' + detail + '）。连不上的查网络，key 不对的核对密钥。';
}

class Router {
  constructor(cfg, dataDir) {
    this.cfg = cfg || {};
    this.providers = (this.cfg.providers || []).slice();
    this.route = this.cfg.route || {};
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, 'ledger');
    this.logFile = path.join(dataDir, 'route.log');
    ensureDir(this.dir);
    this.last = { provider: '', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0, calls: 0, cache_rate: null };
    this.lastQuota = null; // 最近一次额度闸门的结果，方便控制台/排查看
    // 失败冷却：刚挂过的家 60 秒内排到最后，别每句话都先等它超时
    this.failUntil = {};
    this.cooldownMs = 60000;
  }

  // 选路前的额度闸门：free 档先按本地账本算剩余，再做一次探测（10 分钟内复用缓存）；
  // 免费全跳过就退付费档，一个都没有就抛 FREE_EXHAUSTED，绝不满载地失败。
  async quotaGate(list) {
    if (!list.length) return list;
    const q = await quota.filterCandidates(this.cfg, list, this.dataDir);
    const kept = q.list.filter((p) => this.ready(p));
    this.lastQuota = { at: new Date().toISOString(), fallback: !!q.fallback, dropped: q.dropped || [], kept: kept.map((p) => p.name) };
    if ((q.dropped || []).length) this.routeLog('额度跳过', { dropped: q.dropped });
    if (q.fallback) this.routeLog('免费额度用尽，退付费档', { to: kept.map((p) => p.name) });
    if (!kept.length) {
      const err = new Error('免费额度都用完了，也没有可用的付费档：请配置一家付费模型，或等额度重置。');
      err.code = 'FREE_EXHAUSTED';
      err.dropped = q.dropped || [];
      throw err;
    }
    return kept;
  }

  // 运行时改路由：只改内存 + cfg，落盘由调用方（server 的 /api/route）负责。
  // 支持 mode / order / escalate；fixes 传 provider 名 = 切成 fixed 并把它排最前（失败仍会回退到后面的）。
  setRoute(patch) {
    const p = patch || {};
    const next = Object.assign({}, this.route);
    if (typeof p.mode === 'string' && ['cheap-first', 'cloud-first', 'fixed'].indexOf(p.mode) >= 0) next.mode = p.mode;
    if (Array.isArray(p.order)) next.order = p.order.map(String);
    if (typeof p.escalate === 'boolean') next.escalate = p.escalate;
    if (typeof p.pin === 'string' && p.pin) {
      const rest = (this.route.order || []).filter((n) => n !== p.pin);
      next.mode = 'fixed';
      next.order = [p.pin].concat(rest);
    }
    this.route = next;
    if (!this.cfg) this.cfg = {};
    this.cfg.route = next;
    return next;
  }

  // 给界面看的提供方清单：不回 key 明文，只回「填没填」
  providerInfo() {
    return this.providers.map((p) => ({
      name: p.name,
      model: p.model,
      tier: p.tier || 'cloud',
      ready: this.ready(p),
      keyed: !!(p.key && String(p.key).trim()),
      free: (Number(p.price_in) || 0) === 0 && (Number(p.price_out) || 0) === 0,
      vision: !!p.vision,
      tools: p.tools !== false,
      enabled: p.enabled !== false
    }));
  }

  routeState() {
    const quotaInfo = this.lastQuota;
    return {
      mode: (this.cfg && this.cfg.modes && (this.cfg.modes.desktop === 'chat' || this.cfg.modes.desktop === 'work'))
        ? this.cfg.modes.desktop
        : (this.cfg && this.cfg.mode === 'chat' ? 'chat' : 'work'),
      route: { mode: this.route.mode || 'cheap-first', order: this.route.order || [], escalate: this.route.escalate !== false },
      providers: this.providerInfo(),
      last: this.last,
      quota: quotaInfo
    };
  }

  // 本地模型不用填 key；云端没填 key 就当作没配好，跳过而不是报错
  ready(p) {
    if (!p || !p.base) return false;
    if (p.enabled === false) return false;
    if (p.tier === 'local' || p.keyless) return true;
    return !!(p.key && String(p.key).trim() && String(p.key).indexOf('YOUR_') !== 0 && String(p.key) !== 'sk-xxx');
  }

  candidates(taskText, opts) {
    opts = opts || {};
    const now = Date.now();
    let list = this.providers.filter((p) => this.ready(p));
    // 这一轮要用工具：声明了 tools:false 的家不硬塞（塞了它会答非所问或直接 400）
    if (opts.needTools) list = list.filter((p) => p.tools !== false);
    if (opts.skipLocal) list = list.filter((p) => p.tier !== 'local');
    if (!list.length) return [];
    const mode = this.route.mode || 'cheap-first';
    const price = (p) => (Number(p.price_in) || 0) * 1 + (Number(p.price_out) || 0);
    if (mode === 'fixed') {
      const order = this.route.order || [];
      const rank = (p) => { const i = order.indexOf(p.name); return i < 0 ? 999 : i; };
      list.sort((a, b) => rank(a) - rank(b));
    } else if (mode === 'cloud-first') {
      list.sort((a, b) => (a.tier === 'local' ? 1 : 0) - (b.tier === 'local' ? 1 : 0) || price(a) - price(b));
    } else {
      list.sort((a, b) => (a.tier === 'local' ? 0 : 1) - (b.tier === 'local' ? 0 : 1) || price(a) - price(b));
    }
    // 升级只在「自动先免费/本地」时做。fix 是用户亲手点的那一家，别自作主张改；
    // 「先云端」本来就在云端，也不需要再升。
    const hard = mode === 'cheap-first' && this.route.escalate !== false && (
      String(taskText || '').length > 220 ||
      Number(opts.contextChars || 0) > 12000 ||
      HARD_WORDS.test(String(taskText || ''))
    );
    if (hard) {
      const cloud = list.filter((p) => p.tier !== 'local');
      const local = list.filter((p) => p.tier === 'local');
      list = cloud.concat(local);
    }
    // 这个会话上一轮是谁答的：这轮还轮得到它就排回最前，别聊着聊着换了个人
    if (opts.prefer) {
      const i = list.findIndex((p) => p.name === opts.prefer);
      if (i > 0) list = [list[i]].concat(list.slice(0, i), list.slice(i + 1));
    }
    // 刚失败的家排到最后（不是删掉：万一只剩它，还得靠它）
    const alive = [], cooling = [];
    for (const p of list) {
      if ((this.failUntil[p.name] || 0) > now) cooling.push(p); else alive.push(p);
    }
    return alive.concat(cooling);
  }

  markFail(p) {
    if (!p || !p.name) return;
    this.failUntil[p.name] = Date.now() + this.cooldownMs;
  }

  markOk(p) {
    if (!p || !p.name) return;
    delete this.failUntil[p.name];
  }

  noteUsage(p, usage) {
    const u = usage || {};
    const pt = Number(u.prompt_tokens || 0);
    const ct = Number(u.completion_tokens || 0);
    const cost = (pt / 1e6) * (Number(p.price_in) || 0) + (ct / 1e6) * (Number(p.price_out) || 0);
    const file = path.join(this.dir, dayKey() + '.json');
    const led = readJson(file, { date: dayKey(), providers: {}, total: { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost: 0 } });
    const key = p.name || 'default';
    const row = led.providers[key] || { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost: 0, model: p.model };
    row.calls += 1; row.prompt_tokens += pt; row.completion_tokens += ct; row.cost += cost;
    led.providers[key] = row;
    led.total.calls += 1; led.total.prompt_tokens += pt; led.total.completion_tokens += ct; led.total.cost += cost;
    writeJson(file, led);
    const hit = Number(u.prompt_cache_hit_tokens || 0);
    const miss = Number(u.prompt_cache_miss_tokens || 0);
    this.last = {
      provider: key,
      model: p.model,
      prompt_tokens: pt,
      completion_tokens: ct,
      total_tokens: Number(u.total_tokens || pt + ct),
      cost: Math.round(cost * 1e6) / 1e6,
      calls: 1,
      cache_rate: hit + miss > 0 ? Math.round((hit / (hit + miss)) * 1000) / 10 : null
    };
    return this.last;
  }

  routeLog(event, detail) {
    try { appendJsonl(this.logFile, { ts: new Date().toISOString(), event, detail }); } catch (e) {}
  }

  async call(messages, tools, opts) {
    opts = opts || {};
    const needTools = !!(tools && tools.length);
    // 干活模式里固定了一家不带工具的：直接说清楚，别偷偷换别家答
    if (needTools) {
      const pinName = (this.route.mode === 'fixed' && (this.route.order || [])[0]) || '';
      const pin = pinName ? this.providers.filter((p) => p.name === pinName)[0] : null;
      if (pin && this.ready(pin) && pin.tools === false) {
        const err = new Error('你选的「' + pinName + '」不支持工具，干活模式用不了它。换一家带工具的（DeepSeek 或本机工具版 Ollama），或者切回对话模式。');
        err.code = 'NO_PROVIDER';
        throw err;
      }
    }
    let list = this.candidates(opts.taskText || '', {
      needTools: needTools,
      contextChars: opts.contextChars,
      prefer: opts.prefer
    });
    // 带图片的这轮只找声明了 vision 的提供方，别的家不硬塞（塞了也是 400）
    if (opts.requireVision) list = list.filter((p) => p.vision);
    if (!list.length) {
      let msg;
      if (opts.requireVision) {
        msg = '带图片的这轮需要支持视觉的提供方（provider 上写 "vision": true），现在没有可用的。';
      } else if (needTools) {
        msg = '没有能动手的模型：现在能用的家里没有支持工具调用的。接一家 DeepSeek 或本机工具版 Ollama，或者切回对话模式。';
      } else {
        msg = '还没有能用的模型：去设置里点「一键配模型」接一家（智谱有免费额度），或者本机开 Ollama。';
      }
      const err = new Error(msg);
      err.code = opts.requireVision ? 'NO_VISION' : 'NO_PROVIDER';
      throw err;
    }
    if (!opts.skipQuota) {
      try {
        list = await this.quotaGate(list);
      } catch (e) {
        // 额度用尽是结论，必须原样抛；额度层自己崩了（写文件失败之类）不跟着打死请求，按候选继续但留痕
        if (e.code === 'FREE_EXHAUSTED') throw e;
        this.routeLog('额度闸门异常，按候选继续', { error: e.message });
      }
    }
    let lastErr = '';
    const tried = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const body = { model: p.model, messages, temperature: opts.temperature == null ? 0.7 : opts.temperature };
      if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
      if (opts.maxTokens) body.max_tokens = opts.maxTokens;
      // 同一家先试两次：限流/超时/5xx 这类说不定一次就好，别急着换家
      for (let attempt = 0; attempt < 2; attempt++) {
        const t0 = Date.now();
        try {
          const r = await fetch(p.base, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (p.key || 'local') },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(Number(opts.timeoutMs) || 120000)
          });
          if (!r.ok) {
            const txt = (await r.text()).slice(0, 200);
            lastErr = p.name + ' HTTP ' + r.status + ' ' + txt;
            const retriable = r.status === 429 || r.status >= 500;
            if (retriable && attempt === 0) {
              this.routeLog('同家重试', { provider: p.name, status: r.status });
              await new Promise((res) => setTimeout(res, 800));
              continue;
            }
            tried.push({ provider: p.name, ok: false, error: lastErr, ms: Date.now() - t0 });
            this.markFail(p);
            this.routeLog('失败切换', { provider: p.name, error: lastErr });
            break;
          }
          const j = await r.json();
          const stat = this.noteUsage(p, j.usage);
          this.markOk(p);
          if (i > 0) this.routeLog('回退成功', { to: p.name, from: tried.map((x) => x.provider) });
          tried.push({ provider: p.name, ok: true, ms: Date.now() - t0 });
          return { json: j, provider: p, stat, tried, elapsed_ms: Date.now() - t0 };
        } catch (e) {
          lastErr = p.name + ' ' + e.message;
          const retriable = /timeout|aborted|ECONN|fetch failed|socket/i.test(String(e.message || ''));
          if (retriable && attempt === 0) {
            this.routeLog('同家重试', { provider: p.name, error: e.message });
            await new Promise((res) => setTimeout(res, 500));
            continue;
          }
          tried.push({ provider: p.name, ok: false, error: lastErr, ms: Date.now() - t0 });
          this.markFail(p);
          this.routeLog('异常切换', { provider: p.name, error: e.message });
          break;
        }
      }
    }
    const err = new Error(explainFailures(tried));
    err.code = 'ALL_FAILED';
    err.tried = tried;
    throw err;
  }

  async embed(texts, opts) {
    opts = opts || {};
    const e = this.cfg.embedding || {};
    if (!e.enabled || !e.base || !e.key) return null;
    const r = await fetch(e.base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + e.key },
      body: JSON.stringify({ model: e.model || 'embedding-3', input: texts }),
      signal: AbortSignal.timeout(30000)
    });
    if (!r.ok) throw new Error('embedding HTTP ' + r.status);
    const j = await r.json();
    const arr = (j.data || []).map((d) => d.embedding);
    if (!arr.length) return null;
    return arr;
  }

  today() {
    return readJson(path.join(this.dir, dayKey() + '.json'), { date: dayKey(), providers: {}, total: { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost: 0 } });
  }

  // ---------- 账单：今日 / 近 N 天 / 重置水位 ----------
  // 重置不是删账：记一条「从那以后的消费从零算」的水位。原始按天账本一直留着，
  // 所以随时能反悔（删掉 cost-reset.json 就恢复全天累计）。
  resetFile() { return path.join(this.dataDir, 'cost-reset.json'); }

  resetInfo() {
    const r = readJson(this.resetFile(), null);
    if (!r || !r.day) return null;
    return r.day === dayKey() ? r : null; // 跨天自动失效
  }

  resetCost() {
    const t = this.today();
    const provs = {};
    for (const k of Object.keys(t.providers || {})) {
      const v = t.providers[k] || {};
      provs[k] = { calls: Number(v.calls) || 0, cost: Number(v.cost) || 0 };
    }
    const snap = {
      at: new Date().toISOString(),
      day: t.date,
      baseline: Object.assign({ calls: 0, prompt_tokens: 0, completion_tokens: 0, cost: 0 }, t.total),
      providers: provs
    };
    writeJson(this.resetFile(), snap);
    return snap;
  }

  costSummary(days) {
    const n = Math.max(1, Math.min(Number(days) || 7, 60));
    const round = (x) => Math.round((Number(x) || 0) * 1e6) / 1e6;
    const raw = this.ledgerAll(n).map((d) => ({
      date: d.date,
      calls: Number((d.total || {}).calls) || 0,
      prompt_tokens: Number((d.total || {}).prompt_tokens) || 0,
      completion_tokens: Number((d.total || {}).completion_tokens) || 0,
      cost: round((d.total || {}).cost),
      providers: Object.keys(d.providers || {}).map((k) => ({
        name: k,
        model: d.providers[k].model || '',
        calls: Number(d.providers[k].calls) || 0,
        tokens: (Number(d.providers[k].prompt_tokens) || 0) + (Number(d.providers[k].completion_tokens) || 0),
        cost: round(d.providers[k].cost)
      }))
    }));
    const reset = this.resetInfo();
    const out = raw.map((d) => {
      if (!reset || d.date !== reset.day) return d;
      const b = reset.baseline || {};
      const provs = d.providers.map((p) => {
        const bp = (reset.providers || {})[p.name] || {};
        return Object.assign({}, p, {
          calls: Math.max(0, p.calls - (Number(bp.calls) || 0)),
          cost: round(Math.max(0, p.cost - (Number(bp.cost) || 0)))
        });
      }).filter((p) => p.calls > 0 || p.cost > 0);
      return {
        date: d.date,
        calls: Math.max(0, d.calls - (Number(b.calls) || 0)),
        prompt_tokens: Math.max(0, d.prompt_tokens - (Number(b.prompt_tokens) || 0)),
        completion_tokens: Math.max(0, d.completion_tokens - (Number(b.completion_tokens) || 0)),
        cost: round(Math.max(0, d.cost - (Number(b.cost) || 0))),
        providers: provs
      };
    });
    const todayEntry = out.filter((d) => d.date === dayKey())[0]
      || { date: dayKey(), calls: 0, prompt_tokens: 0, completion_tokens: 0, cost: 0, providers: [] };
    return {
      currency: 'CNY',
      today: todayEntry,
      days: out,
      total: round(out.reduce((s, d) => s + d.cost, 0)),
      reset: reset ? { at: reset.at, day: reset.day } : null,
      note: '金额按 provider 的 price_in/price_out 估算，本地与免费模型记 0；多机共用同一个 key 时账本只算本机。'
    };
  }

  ledgerAll(days) {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort(); } catch (e) { return out; }
    const keep = days ? files.slice(-days) : files;
    for (const f of keep) {
      const j = readJson(path.join(this.dir, f), null);
      if (j) out.push(j);
    }
    return out;
  }
}

module.exports = { Router, dayKey, HARD_WORDS, tokenCount };
