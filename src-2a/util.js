'use strict';
/*
 * 2A 模板 · 自己的小工具（不 import 单A 的任何实现）
 *
 * 单A 模板（src/）和 2A 模板（src-multi/）按 docs/设计决定-两个模板.md 的约定：
 * 共用「协议」，不共用「实现」。所以这里该复制就复制，绝不 require('../src/...')，
 * 免得改一边把另一边带崩，也免得两套数据互串。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function nowIso() { return new Date().toISOString(); }
function uid(prefix) { return (prefix || 'id') + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function daysAgo(iso) {
  const t = Date.parse(iso || '');
  return t ? (Date.now() - t) / 86400000 : 0;
}

// 极简分词：中文二元字组 + 英文词。2A 自己实现，够关键词召回用
function tokens(s) {
  s = String(s || '').toLowerCase();
  const out = (s.match(/[a-z0-9_]{2,}/g) || []);
  for (const seg of (s.match(/[\u4e00-\u9fa5]+/g) || [])) {
    if (seg.length === 1) out.push(seg);
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
  }
  return out;
}

function normalizeFact(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ')
    .replace(/[。．.!！?？,，;；:：…\s]+$/g, '').trim();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  nowIso, uid, ensureDir, readJson, writeJson, appendJsonl, readJsonl,
  truncate, daysAgo, tokens, normalizeFact, sleep
};
