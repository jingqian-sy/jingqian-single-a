'use strict';
/*
 * 通用小工具：时间、id、JSON 读写、中文分词、相似度
 * 不依赖任何第三方包——这是「clone 下来就能跑」的前提。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function nowIso() { return new Date().toISOString(); }

function uid(prefix) {
  return (prefix || 'm') + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function daysAgo(iso) {
  const t = Date.parse(iso);
  if (!t) return 0;
  return (Date.now() - t) / 86400000;
}

// 中文按二元字组切，英文按词切；够召回用，不追求分词精度
function tokens(s) {
  s = String(s || '').toLowerCase();
  const out = [];
  const latin = s.match(/[a-z0-9_]{2,}/g) || [];
  for (const w of latin) out.push(w);
  const cjk = s.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seg of cjk) {
    if (seg.length === 1) out.push(seg);
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
  }
  return out;
}

function tokenCount(s) {
  // 粗略 token 估算：中文 1 字≈1 token，英文 4 字符≈1 token
  s = String(s || '');
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const other = s.length - cjk;
  return cjk + Math.ceil(other / 4);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

// 字面相似度（查重用）：二元组词频余弦
function sim(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const fa = Object.create(null), fb = Object.create(null);
  for (const t of ta) fa[t] = (fa[t] || 0) + 1;
  for (const t of tb) fb[t] = (fb[t] || 0) + 1;
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  let dot = 0, na = 0, nb = 0;
  for (const k of keys) {
    const x = fa[k] || 0, y = fb[k] || 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n) + '…';
}

// 一条记忆的「同一个意思」归一化：去首尾空白、合并空格、去掉句尾标点。
// 判重、去重都按这个键比，不然「记得。」和「记得」会变成两条。
function normalizeFact(s) {
  return String(s == null ? '' : s)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[。．.!！?？,，;；:：…\s]+$/g, '')
    .trim();
}

module.exports = {
  nowIso, uid, readJson, writeJson, appendJsonl, ensureDir,
  daysAgo, tokens, tokenCount, cosine, sim, truncate, normalizeFact
};
