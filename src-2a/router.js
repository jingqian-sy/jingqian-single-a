'use strict';
/*
 * 2A 模板 · 模型调用 + 账本（自己的实现）
 *
 * 跟单A 一样走 OpenAI 兼容接口，但代码路径独立：账本写 data-2a/ledger/，
 * 失败日志写 data-2a/logs/route.log，不共用单A 的 route.log。
 */
const path = require('path');
const { readJson, writeJson, appendJsonl, ensureDir } = require('./util');

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
    this.logFile = path.join(dataDir, 'logs', 'route.log');
    ensureDir(this.dir);
    ensureDir(path.dirname(this.logFile));
  }

  ready(p) {
    if (!p || !p.base) return false;
    if (p.tier === 'local' || p.keyless) return true;
    return !!(p.key && String(p.key).trim() && String(p.key).indexOf('YOUR_') !== 0);
  }

  candidates(taskText) {
    let list = this.providers.filter((p) => this.ready(p));
    if (!list.length) return [];
    const mode = this.route.mode || 'cheap-first';
    const price = (p) => (Number(p.price_in) || 0) + (Number(p.price_out) || 0);
    if (mode === 'fixed') {
      const order = this.route.order || [];
      list.sort((a, b) => (order.indexOf(a.name) < 0 ? 999 : order.indexOf(a.name)) - (order.indexOf(b.name) < 0 ? 999 : order.indexOf(b.name)));
    } else if (mode === 'cloud-first') {
      list.sort((a, b) => (a.tier === 'local' ? 1 : 0) - (b.tier === 'local' ? 1 : 0) || price(a) - price(b));
    } else {
      list.sort((a, b) => (a.tier === 'local' ? 0 : 1) - (b.tier === 'local' ? 0 : 1) || price(a) - price(b));
    }
    const hard = this.route.escalate !== false && (String(taskText || '').length > 220 || HARD_WORDS.test(String(taskText || '')));
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
    row.calls++; row.prompt_tokens += pt; row.completion_tokens += ct; row.cost += cost;
    led.providers[key] = row;
    led.total.calls++; led.total.prompt_tokens += pt; led.total.completion_tokens += ct; led.total.cost += cost;
    writeJson(file, led);
    return { provider: key, model: p.model, prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct, cost };
  }

  routeLog(event, detail) {
    try { appendJsonl(this.logFile, { ts: new Date().toISOString(), event, detail }); } catch (e) {}
  }

  async call(messages, tools, opts) {
    opts = opts || {};
    const list = this.candidates(opts.taskText || '');
    if (!list.length) throw new Error('2A 没有可用模型：填一家云端 key，或本机起 Ollama');
    let lastErr = '';
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const body = { model: p.model, messages, temperature: opts.temperature == null ? 0.3 : opts.temperature };
      if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
      if (opts.maxTokens) body.max_tokens = opts.maxTokens;
      try {
        const r = await fetch(p.base, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (p.key || 'local') },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Number(opts.timeoutMs) || 120000)
        });
        if (!r.ok) {
          lastErr = p.name + ' HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160);
          this.routeLog('失败切换', { provider: p.name, error: lastErr });
          continue;
        }
        const j = await r.json();
        const stat = this.noteUsage(p, j.usage);
        if (i > 0) this.routeLog('回退成功', { to: p.name });
        return { json: j, provider: p, stat, elapsed_ms: 0 };
      } catch (e) {
        lastErr = p.name + ' ' + e.message;
        this.routeLog('异常切换', { provider: p.name, error: e.message });
      }
    }
    throw new Error('2A 全部模型失败：' + lastErr);
  }
}

module.exports = { Router, dayKey, HARD_WORDS };
