'use strict';
/*
 * 人物表：认人用的（从 DSH 记忆服务的 people 表搬来的模式）
 *
 * data/memory/people.json 里存一个人一条：
 *   { id, name, kind, relation, weight, aliases: ['主人','管理员'], created_at }
 *
 * 用途：
 *   1) 记忆条目上的 person 指向这里的 id（默认 owner）
 *   2) 记东西时如果句子里出现某个人的别名，就挂到那个人名下
 *   3) 以后按人检索、按人给权重（weight）都有地方挂
 */
const path = require('path');
const { readJson, writeJson, ensureDir, nowIso, ownerAliases } = require('../util');

class People {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'people.json');
    ensureDir(dir);
    this.data = readJson(this.file, { version: 1, items: [] });
    if (!Array.isArray(this.data.items)) this.data.items = [];
    this.seedOwner();
  }

  save() { writeJson(this.file, this.data); }

  // 老板娘先占个位：owner 永远在，别名里带上常见叫法（称呼跟着用户的设置走）
  seedOwner() {
    if (this.data.items.some((x) => x.id === 'owner')) return;
    const aliases = ownerAliases();
    this.data.items.push({
      id: 'owner',
      name: aliases[0] || '主人',
      kind: 'owner',
      relation: aliases[0] || '主人',
      weight: 1,
      aliases: aliases,
      created_at: nowIso()
    });
    this.save();
  }

  list() { return this.data.items.slice(); }

  get(id) { return this.data.items.find((x) => x.id === id) || null; }

  aliasesOf(p) {
    const out = [p.name].concat(p.aliases || []);
    return out.map((x) => String(x || '').trim()).filter(Boolean);
  }

  // 句子里出现了谁的名字/别名？返回第一个人
  whoSaid(text) {
    const t = String(text || '');
    for (const p of this.data.items) {
      for (const a of this.aliasesOf(p)) {
        if (a.length >= 2 && t.indexOf(a) >= 0) return p;
      }
    }
    return null;
  }

  upsert(input) {
    const src = input || {};
    const name = String(src.name || '').trim();
    if (!name) return { ok: false, error: '名字不能空' };
    const id = String(src.id || ('p_' + name.replace(/[^\w\u4e00-\u9fa5]/g, ''))).slice(0, 40);
    const aliases = Array.isArray(src.aliases)
      ? src.aliases.map((x) => String(x).trim()).filter(Boolean)
      : String(src.aliases || '').split(/[,，、\s]+/).filter(Boolean);
    const hit = this.get(id);
    const row = Object.assign({
      id,
      name,
      kind: String(src.kind || 'person'),
      relation: String(src.relation || ''),
      weight: Number(src.weight) || 0.5,
      aliases,
      created_at: nowIso()
    }, hit || {});
    row.name = name;
    row.kind = String(src.kind || row.kind || 'person');
    row.relation = src.relation === undefined ? row.relation : String(src.relation);
    row.weight = src.weight === undefined ? row.weight : (Number(src.weight) || 0.5);
    row.aliases = aliases.length ? aliases : (row.aliases || []);
    if (hit) {
      const i = this.data.items.indexOf(hit);
      this.data.items[i] = row;
    } else {
      this.data.items.push(row);
    }
    this.save();
    return { ok: true, person: row };
  }

  remove(id) {
    if (id === 'owner') return { ok: false, error: 'owner 不能删' };
    const i = this.data.items.findIndex((x) => x.id === id);
    if (i < 0) return { ok: false, error: '没这个人' };
    this.data.items.splice(i, 1);
    this.save();
    return { ok: true, id };
  }
}

module.exports = { People };
