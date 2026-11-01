'use strict';
/*
 * 事件层：把零散的一句话串成「一件事」。
 *
 * 规则（雏版权重，够用、可解释）：
 *   - 按时间排序，同一实体（人名/项目名/物品）且在 N 天窗口内的记忆，归成同一个事件；
 *   - 事件带：起因（第一条）、经过（中间几条）、结果（最后一条）、时间点；
 *   - 检索时先看事件、再落到具体句子，而不是把所有句子平铺。
 *
 * 这一层不追求「理解」，只追求「同一件事不散在十个地方」。
 */
const path = require('path');
const { readJson, writeJson, ensureDir, uid, nowIso, tokens, truncate, daysAgo } = require('../util');

const STOP = new Set(['今天', '现在', '然后', '可以', '就是', '还是', '这个', '那个', '时候', '一下', '觉得', '知道', '我们', '他们', '因为', '所以', '但是', '如果', '没有', '什么', '怎么', '这么', '那么', '已经', '不是', '一个', '自己', '这样', '之后', '之前', '记得']);

function entitiesOf(text) {
  const out = [];
  const seen = new Set();
  for (const t of tokens(text)) {
    if (t.length < 2 || STOP.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 6) break;
  }
  return out;
}

function overlap(a, b) {
  const s = new Set(a);
  return b.some((x) => s.has(x));
}

class EventLayer {
  constructor(dir, opts) {
    this.dir = dir;
    this.file = path.join(dir, 'events.json');
    this.windowDays = (opts && opts.windowDays) || 7;
    ensureDir(dir);
    this.data = readJson(this.file, { version: 1, events: [] });
    if (!Array.isArray(this.data.events)) this.data.events = [];
  }

  save() { writeJson(this.file, this.data); }
  all() { return this.data.events; }

  build(store) {
    const items = store.active()
      .slice()
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const events = [];
    for (const it of items) {
      const ents = entitiesOf(it.text);
      let target = null;
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        const gap = (Date.parse(it.created_at) - Date.parse(ev.end)) / 86400000;
        if (gap > this.windowDays) break;
        if (gap >= -0.01 && overlap(ev.entities, ents)) { target = ev; break; }
      }
      if (target) {
        target.memory_ids.push(it.id);
        target.end = it.created_at;
        target.result = truncate(it.text, 120);
        target.entities = [...new Set(target.entities.concat(ents))].slice(0, 8);
        target.updated_at = nowIso();
      } else {
        events.push({
          event_id: uid('evt'),
          title: truncate(it.text, 40),
          start: it.created_at,
          end: it.created_at,
          entities: ents,
          memory_ids: [it.id],
          cause: truncate(it.text, 120),
          result: truncate(it.text, 120),
          created_at: nowIso(),
          updated_at: nowIso()
        });
      }
    }
    // 事件 id 尽量稳定：同一批记忆重新 build 时沿用旧 id
    const old = this.data.events || [];
    for (const ev of events) {
      const prev = old.find((o) => o.memory_ids && o.memory_ids[0] === ev.memory_ids[0]);
      if (prev) ev.event_id = prev.event_id;
    }
    this.data.events = events;
    this.save();
    for (const ev of events) {
      for (const mid of ev.memory_ids) store.update(mid, { event_id: ev.event_id });
    }
    return { events: events.length, memories: items.length };
  }

  timeline(limit) {
    return this.all()
      .slice()
      .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))
      .slice(0, limit || 20)
      .map((e) => ({
        event_id: e.event_id,
        title: e.title,
        start: e.start,
        end: e.end,
        days: Math.round(daysAgo(e.end)),
        entities: e.entities,
        memories: e.memory_ids.length,
        result: e.result
      }));
  }

  block(limit) {
    const list = this.timeline(limit || 6);
    if (!list.length) return '';
    return list.map((e) => '- [' + e.start.slice(0, 10) + '] ' + e.title + (e.memories > 1 ? '（' + e.memories + ' 条）' : '')).join('\n');
  }
}

module.exports = { EventLayer, entitiesOf };
