'use strict';
/*
 * 召回：关键词（BM25 味道） ＋ 向量（可选）并行跑，合并打分。
 *
 * 两路都跑、谁也别替谁：关键词对专有名词/人名/编号准，向量对「意思相近但没共词」有用。
 * 没有配 embedding 也不影响使用——自动降级成纯关键词，返回里 used_vector=false。
 *
 * 遗忘曲线：按 importance 分档给半衰期，pinned 不掉分。
 *   1 日常流水 14 天 / 2 一般 45 天 / 3 重要 120 天 / 4 钉住 365 天
 */
const { tokens, cosine, truncate, daysAgo } = require('../util');

const HALF_LIFE = { 1: 14, 2: 45, 3: 120, 4: 365 };

// 记忆是按第三人称存的（「用户喜欢…」「老爸喜欢…」），但拿去给模型用的时候
// 不能换成「你」——系统提示里「你」指的是她本人，模型会把记忆当成自己的事。
// 所以统一换成「他」（明确指的是跟她说话的那个人）。
function forPrompt(text) {
  return String(text || '')
    .replace(/用户的/g, '他的')
    .replace(/用户/g, '他')
    .replace(/老爸的/g, '他的')
    .replace(/老爸/g, '他');
}

// 库是混的：有「他的事实」，也有她自己当时的情绪和两人聊天的片段。
// 分开喂，模型才不会把她的回忆当成关于他的事实乱用。
function kindOf(text) {
  const t = String(text || '').trim();
  if (/^用户|^老爸|^他(的|叫|喜欢|讨厌|爱|在|是|有|住)/.test(t)) return 'his';
  if (/^我/.test(t)) return 'self';
  return 'echo';
}

function decayWeight(item) {
  if (item.pinned) return 1;
  const hl = HALF_LIFE[item.importance] || 45;
  return Math.pow(0.5, daysAgo(item.updated_at || item.created_at) / hl);
}

function buildIndex(items) {
  const docs = items.map((it) => ({ it, toks: tokens(it.text + ' ' + (it.kind || '')) }));
  const df = Object.create(null);
  let total = 0;
  for (const d of docs) {
    total += d.toks.length;
    const seen = new Set(d.toks);
    for (const t of seen) df[t] = (df[t] || 0) + 1;
  }
  return { docs, df, avgdl: docs.length ? total / docs.length : 0, N: docs.length };
}

function bm25(idx, qToks) {
  const k1 = 1.2, b = 0.75;
  const scores = new Map();
  const qs = [...new Set(qToks)];
  for (const d of idx.docs) {
    if (!d.toks.length) continue;
    const tf = Object.create(null);
    for (const t of d.toks) tf[t] = (tf[t] || 0) + 1;
    let s = 0;
    for (const q of qs) {
      const f = tf[q];
      if (!f) continue;
      const n = idx.df[q] || 0;
      const idf = Math.log(1 + (idx.N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.toks.length) / (idx.avgdl || 1))));
    }
    if (s > 0) scores.set(d.it.id, s);
  }
  return scores;
}

async function recall(store, query, opts) {
  opts = opts || {};
  const topK = Math.max(1, Number(opts.topK) || 5);
  const items = store.active();
  if (!items.length) return { hits: [], used_vector: false, block: '' };

  const idx = buildIndex(items);
  const kw = bm25(idx, tokens(query));
  const maxKw = Math.max(0.0001, ...kw.values());
  const scored = new Map();
  for (const [id, s] of kw) {
    const it = store.get(id);
    const w = decayWeight(it);
    scored.set(id, { id, base: s / maxKw, score: (s / maxKw) * (0.35 + 0.65 * w) });
  }

  // 钉住的、以及完全没命中的高重要性记忆，给一个小底分，保证「约定了什么」这类问题不至于零召回
  for (const it of items) {
    if (it.pinned && !scored.has(it.id)) scored.set(it.id, { id: it.id, base: 0, score: 0.22 });
  }

  let usedVector = false;
  if (typeof opts.embed === 'function') {
    try {
      const vecs = await opts.embed([query].concat(items.map((it) => truncate(it.text, 300))));
      if (vecs && vecs.length === items.length + 1) {
        usedVector = true;
        const qv = vecs[0];
        for (let i = 0; i < items.length; i++) {
          const v = vecs[i + 1];
          if (!v || !v.length) continue;
          const c = Math.max(0, cosine(qv, v));
          if (c < 0.3) continue;
          const cur = scored.get(items[i].id) || { id: items[i].id, base: 0, score: 0 };
          cur.score = 0.55 * cur.base + 0.45 * c;
          scored.set(items[i].id, cur);
        }
      }
    } catch (e) { usedVector = false; }
  }

  const hits = [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => {
      const it = store.get(x.id);
      return {
        id: it.id, text: it.text, kind: it.kind, importance: it.importance,
        pinned: !!it.pinned, score: Math.round(x.score * 1000) / 1000,
        via: x.base > 0 ? (usedVector ? 'keyword+vector' : 'keyword') : (usedVector ? 'vector' : 'pinned')
      };
    })
    .filter((h) => h.score > 0.05);

  if (hits.length) store.markUsed(hits.map((h) => h.id));

  // 分两类拼：他的事实优先；她自己的回忆/聊天片段单独一段，并说清「不是事实」
  const his = hits.filter((h) => kindOf(h.text) === 'his');
  const own = hits.filter((h) => kindOf(h.text) !== 'his');
  const line = (h) => '- ' + (h.pinned ? '★' : '') + forPrompt(truncate(h.text, 160));
  const parts = [];
  if (his.length) parts.push('【关于他的事实】\n' + his.map(line).join('\n'));
  if (own.length) {
    parts.push('【你俩之间的回忆片段】（她当时的话或情绪，不是关于他的事实，别当成事实照搬）\n'
      + own.slice(0, 3).map(line).join('\n'));
  }
  const block = parts.join('\n\n');
  return { hits, used_vector: usedVector, block };
}

module.exports = { recall, decayWeight, HALF_LIFE, forPrompt, kindOf };
