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
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, appendJsonl, ensureDir, tokenCount } = require('./util');

const HARD_WORDS = /分析|设计|架构|方案|为什么|推理|排查|代码|重构|对比|评测|写一|规划|部署/;

function dayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

class Router {
  constructor(cfg, dataDir) {
    this.cfg = cfg || {};
    this.providers = (this.cfg.providers || []).slice();
    this.route = this.cfg.route || {};
    this.dir = path.join(dataDir, 'ledger');
    this.logFile = path.join(dataDir, 'route.log');
    ensureDir(this.dir);
    this.last = { provider: '', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0, calls: 0, cache_rate: null };
  }

  // 本地模型不用填 key；云端没填 key 就当作没配好，跳过而不是报错
  ready(p) {
    if (!p || !p.base) return false;
    if (p.tier === 'local' || p.keyless) return true;
    return !!(p.key && String(p.key).trim() && String(p.key).indexOf('YOUR_') !== 0 && String(p.key) !== 'sk-xxx');
  }

  candidates(taskText) {
    let list = this.providers.filter((p) => this.ready(p));
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
    const hard = this.route.escalate !== false && (
      String(taskText || '').length > 220 || HARD_WORDS.test(String(taskText || ''))
    );
    if (hard) {
      const cloud = list.filter((p) => p.tier !== 'local');
      const local = list.filter((p) => p.tier === 'local');
      list = cloud.concat(local);
    }
    return list;
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
    const list = this.candidates(opts.taskText || '');
    if (!list.length) {
      const err = new Error('没有可用的模型：请在 config.json 的 providers 里填一家云端 key，或者本机起一个 Ollama。');
      err.code = 'NO_PROVIDER';
      throw err;
    }
    let lastErr = '';
    const tried = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const body = { model: p.model, messages, temperature: opts.temperature == null ? 0.7 : opts.temperature };
      if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
      if (opts.maxTokens) body.max_tokens = opts.maxTokens;
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
          tried.push({ provider: p.name, ok: false, error: lastErr, ms: Date.now() - t0 });
          this.routeLog('失败切换', { provider: p.name, error: lastErr });
          continue;
        }
        const j = await r.json();
        const stat = this.noteUsage(p, j.usage);
        if (i > 0) this.routeLog('回退成功', { to: p.name, from: tried.map((x) => x.provider) });
        tried.push({ provider: p.name, ok: true, ms: Date.now() - t0 });
        return { json: j, provider: p, stat, tried, elapsed_ms: Date.now() - t0 };
      } catch (e) {
        lastErr = p.name + ' ' + e.message;
        tried.push({ provider: p.name, ok: false, error: lastErr, ms: Date.now() - t0 });
        this.routeLog('异常切换', { provider: p.name, error: e.message });
      }
    }
    const err = new Error('所有模型都失败了：' + lastErr);
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
