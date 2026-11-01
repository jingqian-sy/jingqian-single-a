'use strict';
// 立刻整理一次记忆（合并重复 / 老事件压摘要 / 重建事件层）：node evals/consolidate.js
const path = require('path');
const { Her } = require('../src/core');
const { readJson } = require('../src/util');

const ROOT = path.join(__dirname, '..');
const base = readJson(path.join(ROOT, 'config.example.json'), {});
const user = readJson(path.join(ROOT, 'config.json'), null);
const cfg = Object.assign({}, base, user || {});
cfg.providers = ((user && user.providers) || base.providers || []).map((p) => Object.assign({}, p, {
  key: (p.env && process.env[p.env]) ? process.env[p.env] : p.key
}));

const her = new Her({ root: ROOT, cfg });
const before = her.store.count();
const r = her.consolidate();
console.log(JSON.stringify({ before, after: her.store.count(), merged: r.merged.length, compressed: r.compressed.length, events: r.events }, null, 2));
