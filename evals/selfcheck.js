'use strict';
// 启动自检（不启服务也能查）：node evals/selfcheck.js
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
const sc = her.selfcheck();
console.log(JSON.stringify(sc, null, 2));
process.exit(sc.ok ? 0 : 1);
