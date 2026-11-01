'use strict';
/*
 * 免费模型雷达：定期看公开页面，发现「新的免费模型」就提醒一句，问你要不要配置。
 *
 * 它只做三件事：
 *   1) 抓 config.radar.sources 里的公开页面文本（不登录、不带 cookie、不抓鉴权页面）；
 *   2) 宽松地找「模型名 + 免费/每天 X 万 tokens」这种组合，产出条目；
 *   3) 和 data/model-radar.json 的已知清单比，只把新增的挑出来，写 data/radar-pending.json。
 *
 * 红线：只提示，不自动写密钥、不自动启用模型。抓不到/页面改版就保留旧清单，写一条 warn 到
 * data/radar.log，不报错、不崩、不把旧清单清空。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson, appendJsonl, nowIso } = require('./util');
const { parseRuleText } = require('./quota');

const UA = 'jingqian-radar/1.0';
const DEFAULT_DELAY_MS = 60 * 1000;
const DEFAULT_INTERVAL_MS = 7 * 24 * 3600 * 1000;

// 模型名长这样：glm-4-flash / qwen3-8b / deepseek-chat / ernie-4.0-8k
const MODEL_RE = /[a-z][a-z0-9]*(?:[-.][a-z0-9]{1,20}){1,3}/gi;
const NOISE = new Set(['tokens', 'token', 'free', 'http', 'https', 'www', 'com', 'cn', 'html', 'json', 'api', 'openai', 'chat-completions', 'text', 'v1', 'https-www']);

function dbFile(dataDir) { return path.join(dataDir, 'model-radar.json'); }
function pendingFile(dataDir) { return path.join(dataDir, 'radar-pending.json'); }
function logFile(dataDir) { return path.join(dataDir, 'radar.log'); }

function log(dataDir, entry) {
  try { appendJsonl(logFile(dataDir), Object.assign({ ts: nowIso() }, entry)); } catch (e) {}
}

function providerOf(url) {
  try { return new URL(url).host; } catch (e) { return String(url || '').replace(/^https?:\/\//i, '').split('/')[0]; }
}

function frag(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
}

function modelsIn(line) {
  const out = [];
  const ms = String(line).match(MODEL_RE) || [];
  for (const raw of ms) {
    const m = String(raw).replace(/[.,]+$/, '');
    const low = m.toLowerCase();
    if (NOISE.has(low)) continue;
    if (/^\d/.test(m)) continue;
    if (!out.some((x) => x.toLowerCase() === low)) out.push(m);
  }
  return out;
}

// 从一页 HTML 里找「免费」模型条目；找不到就返回空数组（上层据此判「页面没东西」）
function parsePage(text, sourceUrl, provider) {
  const src = String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const plain = src
    .replace(/<\/(p|li|tr|div|h[1-6]|td|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const lines = plain.split(/\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const prov = provider || providerOf(sourceUrl);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/免费|free|赠送|试用|限免/i.test(line)) continue;
    const rule = parseRuleText(line);
    let models = modelsIn(line);
    // 模型名常写在上一行或下一行的表格/卡片里，宽松地再看一眼下一行
    if (!models.length && i + 1 < lines.length) models = modelsIn(lines[i + 1]);
    for (const model of models) {
      const id = frag(prov + '|' + model.toLowerCase() + '|' + sourceUrl);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        provider: prov,
        model,
        quota: rule ? { amount: rule.amount, unit: rule.unit, reset: rule.reset } : null,
        sourceUrl,
        foundAt: nowIso()
      });
    }
  }
  return out;
}

// OpenRouter 的公开模型接口：/api/v1/models 不用登录，返回 [{id, pricing:{prompt,completion}}]。
// 单价是 "0" 的就是免费模型。这条源比抓宣传页可靠：结构稳定、不靠「免费」两个字。
function parseOpenRouterJson(text, sourceUrl, provider) {
  const j = JSON.parse(String(text || ''));
  const arr = Array.isArray(j && j.data) ? j.data : (Array.isArray(j) ? j : []);
  const out = [];
  const seen = new Set();
  for (const m of arr) {
    const id = String((m && (m.id || m.name)) || '').trim();
    if (!id) continue;
    const pricing = (m && m.pricing) || {};
    const prompt = Number(pricing.prompt);
    const completion = Number(pricing.completion);
    if (!(prompt === 0 && (isNaN(completion) || completion === 0))) continue;
    const prov = provider || id.split('/')[0] || providerOf(sourceUrl);
    const key = frag(prov + '|' + id.toLowerCase() + '|' + sourceUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: key,
      provider: prov,
      model: id,
      quota: null,
      sourceUrl,
      foundAt: nowIso()
    });
  }
  return out;
}

function loadDb(dataDir) {
  const j = readJson(dbFile(dataDir), null);
  if (j && Array.isArray(j.entries)) return j;
  return { updated_at: null, entries: [] };
}

function stripEntry(e) {
  return { id: e.id, provider: e.provider, model: e.model, quota: e.quota || null, sourceUrl: e.sourceUrl, foundAt: e.foundAt };
}

function writePending(dataDir, db) {
  const items = db.entries.filter((e) => !e.acked).map(stripEntry);
  writeJson(pendingFile(dataDir), { updated_at: nowIso(), items });
  return items;
}

// 端上只读这个：还没被「以后再说」或「去配置」处理掉的条目
function pending(dataDir, opts) {
  opts = opts || {};
  const rc = (opts.cfg && opts.cfg.radar) || {};
  const file = readJson(pendingFile(dataDir), null);
  const items = (file && Array.isArray(file.items)) ? file.items : [];
  return {
    updated_at: (file && file.updated_at) || null,
    enabled: rc.enabled !== false,
    configured: Array.isArray(rc.sources) && rc.sources.length > 0,
    items
  };
}

function ack(dataDir, ids, all) {
  const db = loadDb(dataDir);
  const want = new Set(Array.isArray(ids) ? ids : (ids ? [ids] : []));
  const acked = [];
  for (const e of db.entries) {
    if (e.acked) continue;
    if (all || want.has(e.id)) { e.acked = true; acked.push(e.id); }
  }
  db.updated_at = nowIso();
  writeJson(dbFile(dataDir), db);
  const items = writePending(dataDir, db);
  log(dataDir, { event: 'ack', acked: acked.length, remaining: items.length });
  return { acked, remaining: items.length };
}

async function scan(opts) {
  opts = opts || {};
  const cfg = opts.cfg || {};
  const dataDir = opts.dataDir || path.join(__dirname, '..', 'data');
  const rc = cfg.radar || {};
  const sources = Array.isArray(rc.sources) ? rc.sources.filter(Boolean) : [];
  const db = loadDb(dataDir);
  const known = new Set(db.entries.map((e) => e.id));
  const novel = [];
  const reports = [];
  for (const raw of sources) {
    const src = typeof raw === 'string' ? { url: raw } : (raw || {});
    const url = String(src.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      reports.push({ url, ok: false, reason: '不是 http(s) 地址' });
      log(dataDir, { event: 'warn', url, reason: '不是 http(s) 地址' });
      continue;
    }
    try {
      // 只抓公开页面文本：不带 cookie、不带账号头
      const doFetch = opts.fetchImpl || fetch;
      const r = await doFetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(Number(opts.timeoutMs) || 8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      const type = String(src.type || '').toLowerCase();
      const looksJson = /^\s*[[{]/.test(text);
      const items = (type === 'openrouter' || (type === 'json' && looksJson) || (type === 'auto' && looksJson && !/^\s*</.test(text)))
        ? parseOpenRouterJson(text, url, src.name || src.provider || '')
        : parsePage(text, url, src.name || src.provider || '');
      if (!items.length) throw new Error('页面里没找到「免费」模型描述（可能改版了）');
      let added = 0;
      for (const it of items) {
        if (known.has(it.id)) continue;
        known.add(it.id);
        db.entries.push(Object.assign({}, it, { acked: false }));
        novel.push(it);
        added++;
      }
      reports.push({ url, ok: true, found: items.length, new: added });
      log(dataDir, { event: 'scan', url, ok: true, found: items.length, new: added });
    } catch (e) {
      reports.push({ url, ok: false, reason: e.message });
      log(dataDir, { event: 'warn', url, reason: e.message });
      // 抓不到保留旧清单，不清空
    }
  }
  db.updated_at = nowIso();
  writeJson(dbFile(dataDir), db);
  const items = writePending(dataDir, db);
  return { new: novel, pending: items, total: db.entries.length, sources: reports };
}

// 服务启动后 60 秒跑一次，之后每 7 天一次；config.radar.enabled=false 关掉；没配 sources 等于不跑
function startSchedule(opts) {
  opts = opts || {};
  const cfg = opts.cfg || {};
  const rc = cfg.radar || {};
  if (rc.enabled === false) return null;
  if (!Array.isArray(rc.sources) || !rc.sources.filter(Boolean).length) return null;
  const dataDir = opts.dataDir;
  const delay = Number(rc.delayMs) || DEFAULT_DELAY_MS;
  const every = Number(rc.intervalMs) || DEFAULT_INTERVAL_MS;
  const run = () => {
    scan({ cfg, dataDir, timeoutMs: rc.timeoutMs })
      .then((r) => { if (r.new.length && opts.onNew) { try { opts.onNew(r); } catch (e) {} } })
      .catch((e) => log(dataDir, { event: 'warn', url: '', reason: '调度出错：' + e.message }));
  };
  const first = setTimeout(run, delay);
  if (first.unref) first.unref();
  const timer = setInterval(run, every);
  if (timer.unref) timer.unref();
  return { stop() { clearTimeout(first); clearInterval(timer); }, delay, every };
}

module.exports = {
  DEFAULT_DELAY_MS, DEFAULT_INTERVAL_MS,
  parsePage, parseOpenRouterJson, modelsIn, scan, pending, ack, loadDb, startSchedule,
  dbFile, pendingFile, logFile
};
