'use strict';
/*
 * 答案缓存（2.0 · 节省第一层）
 *
 * 同一个问法问第二遍，不该再花一次钱。
 *
 * 保守到什么程度：
 *   - 只认「问法几乎一样」的（去掉标点空格、大小写之后完全相同）
 *   - 只缓存干净的回答：没用工具、没被引用闸标记、不太长
 *   - 带附件、干活模式、要工具的，一律不进缓存
 *
 * 宁可少命中，也不要给出一个错的旧答案。
 */
const fs = require('fs');
const path = require('path');
const { writeJson, readJson, nowIso } = require('./util');

const MAX_ITEMS = 500;

function norm(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：,.!?;:"'「」『』（）()【】\[\]…~·\-—_]+/g, '')
    .trim();
}

class AnswerCache {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'answer-cache.json');
    this.data = readJson(this.file, { items: [] });
    if (!Array.isArray(this.data.items)) this.data.items = [];
  }

  save() {
    try { writeJson(this.file, this.data); } catch (e) {}
  }

  get(query) {
    const k = norm(query);
    if (!k) return null;
    const hit = this.data.items.find((x) => x.k === k);
    if (!hit) return null;
    hit.hits = (hit.hits || 0) + 1;
    this.save();
    return { reply: hit.reply, at: hit.at, hits: hit.hits };
  }

  set(query, reply, meta) {
    const k = norm(query);
    if (!k || !reply) return false;
    if (String(reply).length > 500) return false;      // 太长的答案不缓存：上下文相关性强
    const m = meta || {};
    if (m.usedTools && m.usedTools.length) return false; // 工具有副作用，结果不该复用
    if (m.flagged && m.flagged.length) return false;    // 她自己都说拿不准，别存
    const i = this.data.items.findIndex((x) => x.k === k);
    const item = { k, q: String(query).slice(0, 200), reply: String(reply), at: nowIso(), hits: 0, provider: m.provider || '' };
    if (i >= 0) this.data.items[i] = item;
    else this.data.items.push(item);
    while (this.data.items.length > MAX_ITEMS) this.data.items.shift();
    this.save();
    return true;
  }

  // 用户说「不对/答错了」：把这条删掉，免得一直发旧答案
  drop(query) {
    const k = norm(query);
    const before = this.data.items.length;
    this.data.items = this.data.items.filter((x) => x.k !== k);
    this.save();
    return before !== this.data.items.length;
  }

  stats() {
    const n = this.data.items.length;
    const hits = this.data.items.reduce((s, x) => s + (x.hits || 0), 0);
    return { items: n, hits, capacity: MAX_ITEMS };
  }
}

module.exports = { AnswerCache, norm };
