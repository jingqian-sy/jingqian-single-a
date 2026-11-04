'use strict';
/*
 * 观测（2.0 · 没有它没法优化）
 *
 * turns.log 每轮记一行，但一行一行看等于没看。这里把它聚合成几个数：
 * 这段日子调了几次、缓存接了几次、花了多少钱、平均多慢、哪些工具用得最多、
 * 有几条被她自己标了「我拿不准」。
 *
 * 只读本地日志，不发请求。
 */
const fs = require('fs');
const path = require('path');

function readJsonl(file) {
  const out = [];
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return out; }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (e) { /* 坏行跳过 */ }
  }
  return out;
}

function summary(dataDir, opts) {
  opts = opts || {};
  const days = Math.max(1, Math.min(365, Number(opts.days) || 7));
  const since = Date.now() - days * 24 * 3600 * 1000;
  const rows = readJsonl(path.join(dataDir, 'turns.log')).filter((r) => {
    const t = Date.parse(r && r.ts);
    return !isNaN(t) && t >= since;
  });

  let cached = 0, cost = 0, ms = 0, flagged = 0, tokens = 0;
  const byProvider = {}, byTool = {}, bySession = {};

  for (const r of rows) {
    if (r.cached) cached++;
    cost += Number(r.cost) || 0;
    ms += Number(r.ms) || 0;
    tokens += Number(r.total_tokens) || 0;
    if (Array.isArray(r.reference_flags) && r.reference_flags.length) flagged++;
    const p = r.cached ? 'cache' : (r.provider || '未知');
    byProvider[p] = (byProvider[p] || 0) + 1;
    for (const t of (Array.isArray(r.tools) ? r.tools : [])) byTool[t] = (byTool[t] || 0) + 1;
    const s = r.session || 'default';
    bySession[s] = (bySession[s] || 0) + 1;
  }

  const calls = rows.length;
  return {
    days: days,
    calls: calls,
    modelCalls: calls - cached,
    cached: cached,
    cacheRate: calls ? Math.round((cached / calls) * 1000) / 1000 : 0,
    cost: Math.round(cost * 1e6) / 1e6,
    tokens: tokens,
    avgMs: calls ? Math.round(ms / calls) : 0,
    flagged: flagged,
    byProvider: byProvider,
    byTool: byTool,
    bySession: bySession,
    // 一句人话的结论
    verdict: calls
      ? ('这 ' + days + ' 天聊了 ' + calls + ' 轮，其中 ' + cached + ' 轮没花钱（缓存接的），'
        + '花了 ' + (Math.round(cost * 10000) / 10000) + ' 元，平均 ' + Math.round(ms / calls) + ' 毫秒一轮'
        + (flagged ? '，有 ' + flagged + ' 条她自己标了拿不准' : '') + '。')
      : ('这 ' + days + ' 天还没有记录。')
  };
}

module.exports = { summary, readJsonl };
