'use strict';
/*
 * 3A 模板 · 记忆（自己的实现）
 *
 * 协议字段跟单A 一样（id / text / kind / importance / pinned / created_at /
 * updated_at / status），实现自己写：关键词召回 + 遗忘曲线 + 事件聚类 + 整理。
 * 不 import 单A 的 src/memory/*。
 */
const path = require('path');
const fs = require('fs');
const { uid, nowIso, readJson, writeJson, ensureDir, tokens, daysAgo, normalizeFact, truncate } = require('./util');

const HALF_LIFE = { 1: 14, 2: 45, 3: 120, 4: 365 };

class Memory {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'memories.json');
    this.eventFile = path.join(dir, 'events.json');
    ensureDir(dir);
    this.data = readJson(this.file, { version: 1, items: [] });
    if (!Array.isArray(this.data.items)) this.data.items = [];
    this.events = readJson(this.eventFile, { events: [] }).events || [];
  }

  save() { writeJson(this.file, this.data); writeJson(this.eventFile, { events: this.events }); }

  active() { return this.data.items.filter((x) => x.status !== 'archived'); }
  count() { return this.active().length; }
  get(id) { return this.data.items.find((x) => x.id === id) || null; }
  all() { return this.data.items; }

  add(input) {
    const text = String((input && input.text) || '').trim();
    if (!text) return null;
    const norm = normalizeFact(text);
    const dup = this.data.items.find((x) => x.status !== 'archived' && normalizeFact(x.text) === norm);
    if (dup) {
      dup.updated_at = nowIso();
      if (input.importance) dup.importance = Math.max(dup.importance || 1, Number(input.importance) || 1);
      if (input.pinned) dup.pinned = true;
      this.save();
      return dup;
    }
    const item = {
      id: uid('m'),
      text,
      kind: input.kind || 'fact',
      importance: Math.min(4, Math.max(1, Number(input.importance) || 1)),
      pinned: !!input.pinned,
      status: 'active',
      source: input.source || '3a',
      created_at: nowIso(),
      updated_at: nowIso(),
      event_id: null
    };
    this.data.items.push(item);
    this.save();
    return item;
  }

  update(id, patch) {
    const it = this.get(id);
    if (!it) return null;
    for (const k of ['text', 'kind', 'importance', 'pinned', 'status', 'event_id', 'merged_into']) {
      if (patch[k] !== undefined) it[k] = patch[k];
    }
    it.updated_at = nowIso();
    this.save();
    return it;
  }

  archive(id) { return this.update(id, { status: 'archived' }); }

  recall(query, topK) {
    const items = this.active();
    if (!items.length) return [];
    const q = tokens(query);
    if (!q.length) return items.filter((x) => x.pinned).slice(0, topK || 5).map((x) => ({ id: x.id, text: x.text, pinned: x.pinned, score: 0.2 }));
    const docs = items.map((it) => ({ it, t: tokens(it.text) }));
    const df = Object.create(null);
    for (const d of docs) for (const t of new Set(d.t)) df[t] = (df[t] || 0) + 1;
    const N = docs.length;
    const scored = [];
    for (const d of docs) {
      const tf = Object.create(null);
      for (const t of d.t) tf[t] = (tf[t] || 0) + 1;
      let s = 0;
      for (const t of new Set(q)) {
        if (!tf[t]) continue;
        const idf = Math.log(1 + (N - (df[t] || 0) + 0.5) / ((df[t] || 0) + 0.5));
        s += idf * ((tf[t] * 2.2) / (tf[t] + 1.2 * (1 - 0.75 + 0.75 * d.t.length / Math.max(1, items.length))));
      }
      if (!s) continue;
      const w = d.it.pinned ? 1 : Math.pow(0.5, daysAgo(d.it.updated_at || d.it.created_at) / (HALF_LIFE[d.it.importance] || 45));
      scored.push({ id: d.it.id, text: d.it.text, pinned: !!d.it.pinned, score: s * (0.35 + 0.65 * w) });
    }
    for (const it of items) {
      if (it.pinned && !scored.find((x) => x.id === it.id)) scored.push({ id: it.id, text: it.text, pinned: true, score: 0.22 });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK || 5);
  }

  // 事件层：同实体 + 7 天内的话串成「一件事」
  buildEvents(windowDays) {
    const win = windowDays || 7;
    const items = this.active().slice().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const events = [];
    const ents = (text) => {
      const out = [];
      for (const t of tokens(text)) {
        if (t.length < 2 || /^(今天|现在|然后|可以|就是|还是|这个|那个|我们|一个|自己|已经|没有|什么)$/.test(t)) continue;
        if (!out.includes(t)) out.push(t);
        if (out.length >= 6) break;
      }
      return out;
    };
    for (const it of items) {
      const e = ents(it.text);
      let hit = null;
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        const gap = (Date.parse(it.created_at) - Date.parse(ev.end)) / 86400000;
        if (gap > win) break;
        if (gap >= -0.01 && ev.entities.some((x) => e.includes(x))) { hit = ev; break; }
      }
      if (hit) {
        hit.memory_ids.push(it.id);
        hit.end = it.created_at;
        hit.result = truncate(it.text, 120);
        hit.entities = [...new Set(hit.entities.concat(e))].slice(0, 8);
      } else {
        events.push({
          event_id: uid('e'),
          title: truncate(it.text, 40),
          start: it.created_at,
          end: it.created_at,
          entities: e,
          memory_ids: [it.id],
          cause: truncate(it.text, 120),
          result: truncate(it.text, 120)
        });
      }
    }
    this.events = events;
    for (const ev of events) for (const id of ev.memory_ids) this.update(id, { event_id: ev.event_id });
    this.save();
    return events;
  }

  timeline(limit) {
    return this.events.slice().sort((a, b) => Date.parse(b.end) - Date.parse(a.end)).slice(0, limit || 10);
  }

  // 主动整理：合并重复（不看 kind，只看字面相似）+ 重建事件
  consolidate() {
    const items = this.active().slice();
    const dead = new Set();
    let merged = 0;
    for (let i = 0; i < items.length; i++) {
      if (dead.has(items[i].id)) continue;
      for (let j = i + 1; j < items.length; j++) {
        if (dead.has(items[j].id)) continue;
        const a = items[i], b = items[j];
        if (a.pinned !== b.pinned) continue;
        if (normalizeFact(a.text) === normalizeFact(b.text) || sim(a.text, b.text) > 0.85) {
          b.importance = Math.max(a.importance, b.importance);
          this.update(b.id, b);
          this.archive(a.id);
          dead.add(a.id);
          merged++;
        }
      }
    }
    const events = this.buildEvents();
    return { merged, events: events.length, active: this.count() };
  }
}

function sim(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const fa = Object.create(null), fb = Object.create(null);
  for (const t of ta) fa[t] = (fa[t] || 0) + 1;
  for (const t of tb) fb[t] = (fb[t] || 0) + 1;
  let dot = 0, na = 0, nb = 0;
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    const x = fa[k] || 0, y = fb[k] || 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

module.exports = { Memory };
