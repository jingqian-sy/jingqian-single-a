'use strict';
/*
 * 主动整理：闲下来的时候自己复盘，别让库无限膨胀。
 *
 * 三件事（都由规则驱动，不额外烧 token）：
 *   1) 合并重复：字面相似度 > 0.85 且 kind 相同的两条，留新的、归档旧的，重要性取高、pinned 继承；
 *   2) 压摘要：一件老事件（结束于 N 天前）里攒了 4 条以上、且没有 pinned 的，压成一条摘要，原文归档；
 *   3) 重建事件层：整理完把事件重新串一遍。
 *
 * 每次整理都写 data/consolidate.log 一行，能追溯「谁被谁吃掉了」。
 */
const path = require('path');
const { appendJsonl, nowIso, sim, truncate, daysAgo } = require('../util');

function consolidate(store, events, opts) {
  opts = opts || {};
  const dupThreshold = Number(opts.dupThreshold) || 0.85;
  const oldDays = Number(opts.oldEventDays) || 60;
  const minGroup = Number(opts.minGroup) || 4;
  const report = { at: nowIso(), merged: [], compressed: [], events: 0, active_before: store.count(), active_after: 0 };

  // 1) 合并重复
  const items = store.active().slice().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const dead = new Set();
  for (let i = 0; i < items.length; i++) {
    if (dead.has(items[i].id)) continue;
    for (let j = i + 1; j < items.length; j++) {
      if (dead.has(items[j].id)) continue;
      const a = items[i], b = items[j];
      // 不要求 kind 相同：同一条事实从「用户说」和「自动捕获」进来，kind 经常一个 preference 一个 fact，
      // 卡着 kind 就会永远合不掉。pinned 状态不同仍然不合并，免得把钉住的钉没了。
      if (a.pinned !== b.pinned) continue;
      if (sim(a.text, b.text) < dupThreshold) continue;
      // 留新的
      b.importance = Math.max(a.importance, b.importance);
      b.use_count = (a.use_count || 0) + (b.use_count || 0);
      b.pinned = a.pinned || b.pinned;
      b.updated_at = nowIso();
      store.update(b.id, b);
      store.archive(a.id);
      store.update(a.id, { merged_into: b.id });
      dead.add(a.id);
      report.merged.push({ keep: b.id, drop: a.id, text: truncate(a.text, 40) });
    }
  }

  // 2) 压摘要
  const groups = new Map();
  for (const it of store.active()) {
    if (!it.event_id || it.pinned) continue;
    const arr = groups.get(it.event_id) || [];
    arr.push(it);
    groups.set(it.event_id, arr);
  }
  for (const [eventId, arr] of groups) {
    if (arr.length < minGroup) continue;
    const last = Math.max(...arr.map((x) => Date.parse(x.created_at)));
    if ((Date.now() - last) / 86400000 < oldDays) continue;
    const first = arr.slice().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
    const summary = store.add({
      text: '（旧事摘要）' + truncate(first.text, 60) + ' …… 后来：' + truncate(arr[arr.length - 1].text, 60),
      kind: first.kind,
      importance: Math.max(2, first.importance),
      pinned: false,
      source: 'consolidate'
    });
    if (!summary) continue;
    store.update(summary.id, { event_id: eventId });
    for (const it of arr) {
      store.archive(it.id);
      store.update(it.id, { merged_into: summary.id });
    }
    report.compressed.push({ event: eventId, into: summary.id, count: arr.length });
  }

  // 3) 重建事件层（归档条目不参与）
  if (events) {
    const r = events.build(store);
    report.events = r.events;
  }

  report.active_after = store.count();
  try {
    appendJsonl(path.join(store.dir, '..', 'consolidate.log'), report);
  } catch (e) { /* ignore */ }
  return report;
}

module.exports = { consolidate };
