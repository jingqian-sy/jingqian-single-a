'use strict';
/*
 * 会话原文检索：把 data/sessions/*.json 里的对话翻出来按关键词找。
 *
 * 为什么要有：历史超过阈值会压成两百字摘要，细节就没了；
 * 摘要用来"想起大概"，要找原话就得回原文里翻。
 *
 * 做法很土但够用：启动后第一次检索时把 json 读进内存建倒排（按字切 token），
 * 文件改了（mtime 变了）就重建那一个；不常驻、不写盘、不联网。
 */
const fs = require('fs');
const path = require('path');

const cache = new Map(); // file -> { mtime, msgs }

function tokenize(s) {
  const t = String(s || '').toLowerCase();
  const out = [];
  for (const w of t.split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    if (/[\u4e00-\u9fa5]/.test(w)) {
      if (w.length === 1) out.push(w);
      for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
    } else if (w.length >= 2) out.push(w);
  }
  return out;
}

function loadFile(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return []; }
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.msgs;
  let msgs = [];
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(j) ? j : (j.messages || []);
    msgs = arr
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
      .map((m) => ({ role: m.role, text: String(m.content), ts: m.ts || m.at || '' }));
  } catch (e) { msgs = []; }
  cache.set(file, { mtime: st.mtimeMs, msgs });
  return msgs;
}

// 关键词检索：query 里的 token 命中越多分越高；days 只收最近 N 天（有 ts 的才判断）
function search(dataDir, query, opts) {
  opts = opts || {};
  const dir = path.join(dataDir, 'sessions');
  const max = Math.max(1, Math.min(Number(opts.limit) || 8, 30));
  const days = Number(opts.days) || 0;
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.summary')); }
  catch (e) { return []; }

  const qSet = new Set(qTokens);
  const hits = [];
  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
  for (const f of files) {
    const session = f.replace(/\.json$/, '');
    for (const m of loadFile(path.join(dir, f))) {
      if (cutoff && m.ts && Date.parse(m.ts) < cutoff) continue;
      const toks = tokenize(m.text);
      if (!toks.length) continue;
      let hit = 0;
      const seen = new Set();
      for (const t of toks) {
        if (qSet.has(t) && !seen.has(t)) { seen.add(t); hit++; }
      }
      if (!hit) continue;
      const score = hit / qSet.size;
      hits.push({
        session, role: m.role, ts: m.ts,
        score: Math.round(score * 1000) / 1000,
        text: m.text.length > 300 ? m.text.slice(0, 300) + '…' : m.text
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || String(b.ts).localeCompare(String(a.ts)));
  return hits.slice(0, max);
}

module.exports = { search, tokenize };
