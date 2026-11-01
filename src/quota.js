'use strict';
/*
 * 动态额度：本地账本 + 规则刷新 + 实测探测
 *
 * 三件事各管一段，谁也不装万能：
 *   - 账本（data/ledger/*.json）：知道「我们用了多少」，但只知道本机用掉的；
 *   - 规则（quotaSources 页面文本）：知道「官方说上限多少」，但不知道你已经用了多少；
 *   - 探测（极小的 max_tokens=1 请求）：只知道「现在还能不能用」，不告诉你剩多少。
 *
 * 只用公开页面文本，不登录、不带 cookie；抓不到就保留旧值，绝不清空。
 * 探测结果缓存 10 分钟（data/quota-state.json），别拿探测烧额度。
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, appendJsonl, nowIso } = require('./util');

const PROBE_TTL_MS = 10 * 60 * 1000;
const UNIT = { '': 1, '万': 10000, '百万': 1000000, '亿': 100000000 };

function stateFile(dataDir) { return path.join(dataDir, 'quota-state.json'); }
function logFile(dataDir) { return path.join(dataDir, 'quota.log'); }

function loadState(dataDir) {
  const s = readJson(stateFile(dataDir), null);
  return s && typeof s === 'object' ? s : { probes: {}, rules: {}, updated_at: null };
}

function saveState(dataDir, s) {
  s.updated_at = nowIso();
  writeJson(stateFile(dataDir), s);
}

function log(dataDir, entry) {
  try { appendJsonl(logFile(dataDir), Object.assign({ ts: nowIso() }, entry)); } catch (e) {}
}

// 只有 tier=free 或显式 free:true 才算「免费额度」；tier=local 是另一回事（本机模型不烧额度、也不探测）
function isFree(p) {
  return !!(p && (p.tier === 'free' || p.free === true));
}

// 探测：一次极小的真实请求，只判断「还能不能用」
async function probe(provider, opts) {
  opts = opts || {};
  const dataDir = opts.dataDir || path.join(__dirname, '..', 'data');
  const st = loadState(dataDir);
  const key = provider.name;
  const cached = st.probes[key];
  const ttl = Number(opts.ttlMs) || PROBE_TTL_MS;
  if (!opts.force && cached && (Date.now() - Date.parse(cached.at)) < ttl) {
    return { status: cached.status, cached: true, detail: cached.detail || '' };
  }
  let status = 'error';
  let detail = '';
  try {
    const r = await fetch(provider.base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (provider.key || 'local') },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: '1' }],
        max_tokens: 1,
        temperature: 0
      }),
      signal: AbortSignal.timeout(Number(opts.timeoutMs) || 8000)
    });
    const txt = await r.text().catch(() => '');
    if (r.status === 429) { status = 'exhausted'; detail = 'HTTP 429'; }
    else if (/quota|额度|限流|余额|insufficient|exceed/i.test(txt)) { status = 'exhausted'; detail = txt.slice(0, 120); }
    else if (!r.ok) { status = 'error'; detail = 'HTTP ' + r.status + ' ' + txt.slice(0, 80); }
    else status = 'ok';
  } catch (e) {
    status = 'error';
    detail = e.message;
  }
  st.probes[key] = { at: nowIso(), status, detail };
  saveState(dataDir, st);
  log(dataDir, { event: 'probe', provider: key, status, cached: false });
  return { status, cached: false, detail };
}

// 从公开页面文本里宽松地找「每天/每月 X 万/百万 tokens」
function parseRuleText(text) {
  const s = String(text || '').replace(/\s+/g, ' ');
  const re = /(每天|每日|每月|每个月|每月可)[^。；;\n]{0,30}?(\d+(?:\.\d+)?)\s*(百万|万|亿)?\s*(?:tokens?|个?\s*token)?/i;
  const m = s.match(re);
  if (!m) return null;
  const amount = Number(m[2]) * (UNIT[m[3] || ''] || 1);
  const reset = /每(天|日)/.test(m[1]) ? 'day' : 'month';
  return { amount, unit: m[3] === '百万' ? 'M' : (m[3] === '万' ? 'wan' : (m[3] === '亿' ? 'yi' : 'token')), reset };
}

async function refreshRules(opts) {
  opts = opts || {};
  const cfg = opts.cfg || {};
  const dataDir = opts.dataDir || path.join(__dirname, '..', 'data');
  const st = loadState(dataDir);
  const sources = cfg.quotaSources || [];
  const updated = [];
  for (const src of sources) {
    if (!src || !src.url) { updated.push({ provider: src && src.provider, ok: false, reason: '没配 url' }); continue; }
    try {
      // 只抓公开页面文本：不带 cookie、不带账号头
      const r = await fetch(src.url, { headers: { 'user-agent': 'jingqian-quota/1.0' }, signal: AbortSignal.timeout(Number(opts.timeoutMs) || 8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      const rule = parseRuleText(text);
      if (!rule) throw new Error('页面里没找到额度描述');
      st.rules[src.provider] = Object.assign({ at: nowIso(), source: src.url }, rule);
      updated.push({ provider: src.provider, ok: true, rule });
      log(dataDir, { event: 'rules', provider: src.provider, ok: true, rule });
    } catch (e) {
      updated.push({ provider: src.provider, ok: false, reason: e.message });
      log(dataDir, { event: 'rules', provider: src.provider, ok: false, reason: e.message });
      // 抓不到保留旧值，不清空
    }
  }
  saveState(dataDir, st);
  if (opts.cfg) {
    for (const p of cfg.providers || []) {
      const rule = st.rules[p.name];
      // 页面解析出的 amount 已经是 token 数（「200 万」→ 2000000），这里标成 token，
      // 免得 remaining() 再按「万」乘一次；手写配置想写「200 万」可以写 {amount:200,unit:'wan'}
      if (rule) p.freeQuota = { amount: rule.amount, unit: 'token', reset: rule.reset };
    }
  }
  return { updated, rules: st.rules };
}

// 本地账本：今天/本月已用多少 tokens
function usedTokens(dataDir, providerName, reset) {
  const d = new Date();
  const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  let files = [];
  try { files = fs.readdirSync(path.join(dataDir, 'ledger')).filter((f) => f.endsWith('.json')); } catch (e) { return 0; }
  const prefix = reset === 'month' ? dayKey.slice(0, 7) : dayKey;
  let sum = 0;
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const j = readJson(path.join(dataDir, 'ledger', f), null);
    if (!j || !j.providers) continue;
    const row = j.providers[providerName];
    if (row) sum += Number(row.prompt_tokens || 0) + Number(row.completion_tokens || 0);
  }
  return sum;
}

function remaining(cfg, provider, dataDir) {
  const q = provider && provider.freeQuota;
  if (!q || !q.amount) return { left: null, known: false };
  const limit = Number(q.amount) * (q.unit === 'wan' ? 10000 : q.unit === 'M' ? 1000000 : q.unit === 'yi' ? 100000000 : 1);
  const used = usedTokens(dataDir, provider.name, q.reset || 'month');
  return { left: limit - used, known: true, limit, used };
}

async function filterCandidates(cfg, list, dataDir) {
  const dropped = [];
  const kept = [];
  for (const p of list) {
    if (!isFree(p)) { kept.push(p); continue; }
    const r = remaining(cfg, p, dataDir);
    if (r.known && r.left <= 0) { dropped.push({ name: p.name, reason: 'local ledger 到上限', left: r.left }); continue; }
    const pr = await probe(p, { dataDir });
    if (pr.status === 'exhausted') { dropped.push({ name: p.name, reason: 'probe exhausted', detail: pr.detail }); continue; }
    kept.push(p);
  }
  if (kept.length === 0) {
    const paid = (cfg.providers || []).filter((p) => !isFree(p) && p.tier !== 'local' && p.base);
    if (paid.length) {
      log(dataDir, { event: 'fallback', to: paid.map((x) => x.name) });
      return { list: paid, dropped, fallback: true };
    }
    const err = new Error('免费额度都用完了，也没有可用的付费档：请配置一家付费模型，或等额度重置。');
    err.code = 'FREE_EXHAUSTED';
    throw err;
  }
  // 免费档全被跳过、剩下的是付费档：也算回退，方便上层记日志/提示
  const fallback = dropped.length > 0 && !kept.some((p) => isFree(p));
  if (fallback) log(dataDir, { event: 'fallback', to: kept.map((x) => x.name) });
  return { list: kept, dropped, fallback };
}

module.exports = {
  PROBE_TTL_MS, probe, parseRuleText, refreshRules, remaining, usedTokens, filterCandidates, isFree,
  loadState, saveState
};
