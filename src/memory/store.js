'use strict';
/*
 * 记忆库（JSON 存储，零依赖）
 *
 * 一条记忆的协议（与 3A 模板共用字段，实现各写各的）：
 *   id / text / kind / importance / pinned / created_at / updated_at / status
 *   kind: fact 事实 | preference 偏好 | relation 关系 | emotional 情绪 | lesson 经验
 *   status: active | archived
 *
 * 另外带几个雏版自用的字段（不影响协议兼容）：
 *   source 来源 / use_count 被用次数 / last_used_at 上次被用 / event_id 归属事件
 *   vec 向量（可选，由 embedding 提供方算出来缓存）
 */
const path = require('path');
const fs = require('fs');
const { uid, nowIso, readJson, writeJson, ensureDir, normalizeFact } = require('../util');

const KINDS = ['fact', 'preference', 'relation', 'emotional', 'lesson'];

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'memories.json');
    ensureDir(dir);
    this.data = readJson(this.file, { version: 1, items: [] });
    if (!Array.isArray(this.data.items)) this.data.items = [];
    // 老库补字段：归属和层级是后来加的（从记忆服务搬来的模式），没有就补上
    let dirty = false;
    for (const it of this.data.items) {
      if (!it.person) { it.person = 'owner'; dirty = true; }
      if (!it.tier) {
        it.tier = (it.pinned || (Number(it.importance) || 1) >= 4) ? 'core'
          : (it.kind === 'relation' ? 'relation' : 'cue');
        dirty = true;
      }
    }
    if (dirty) this.save();
  }

  save() { writeJson(this.file, this.data); }

  all() { return this.data.items; }
  active() { return this.data.items.filter((x) => x.status !== 'archived'); }
  count() { return this.active().length; }

  get(id) { return this.data.items.find((x) => x.id === id) || null; }

  // 同一件事换个说法（「用户喜欢X」/「他喜欢X」）算冲突：只留说话人那条
  subjectlessKey(t) {
    return normalizeFact(String(t || '').replace(/^(用户|老爸|他的?|我的?|她)/, ''));
  }

  add(input) {
    const text = String((input && input.text) || '').trim();
    if (!text) return null;
    // 同一个意思不重复存（句尾标点、空格不算差异），只更新重要性/钉住
    const key = normalizeFact(text);
    const dup = this.data.items.find((x) => x.status !== 'archived' && normalizeFact(x.text) === key);
    if (dup) {
      dup.updated_at = nowIso();
      if (input.importance) dup.importance = Math.max(dup.importance || 1, Number(input.importance) || 1);
      if (input.pinned) dup.pinned = true;
      this.save();
      return dup;
    }
    // 冲突检查：同义但主语不同，只留说「用户/老爸」那条。
    // 只在同一个人名下比：老王家的猫和大人的猫都叫团子，不能互相顶掉。
    const newPerson = (input && input.person) || 'owner';
    const sKey = this.subjectlessKey(text);
    const conflict = this.data.items.find((x) => x.status !== 'archived'
      && (x.person || 'owner') === newPerson
      && this.subjectlessKey(x.text) === sKey);
    const hisNow = /^(用户|老爸)/.test(text);
    if (conflict && hisNow && !/^(用户|老爸)/.test(conflict.text)) {
      conflict.status = 'archived';
      conflict.merged_into = null;
    } else if (conflict && !hisNow) {
      conflict.updated_at = nowIso();
      this.save();
      return conflict;
    }
    const kindNow = KINDS.includes(input.kind) ? input.kind : 'fact';
    // 层级：钉住/极重要 = 恒常注入（core）；关系类 = 恒常但轻一点；其余平时不注入，问到了才想起
    const tier = input.tier || (input.pinned || (Number(input.importance) || 1) >= 4
      ? 'core'
      : (kindNow === 'relation' ? 'relation' : 'cue'));
    const item = {
      id: uid('mem'),
      text,
      kind: KINDS.includes(input.kind) ? input.kind : 'fact',
      importance: Math.min(4, Math.max(1, Number(input.importance) || 1)),
      pinned: !!input.pinned,
      status: 'active',
      source: input.source || 'chat',
      person: input.person || 'owner',
      tier,
      created_at: nowIso(),
      updated_at: nowIso(),
      last_used_at: null,
      use_count: 0,
      event_id: null
    };
    this.data.items.push(item);
    this.save();
    return item;
  }

  update(id, patch) {
    const it = this.get(id);
    if (!it) return null;
    const allow = ['text', 'kind', 'importance', 'pinned', 'status', 'event_id', 'vec', 'vec_model', 'merged_into'];
    for (const k of allow) if (patch[k] !== undefined) it[k] = patch[k];
    it.updated_at = nowIso();
    this.save();
    return it;
  }

  archive(id) {
    const it = this.get(id);
    if (!it) return null;
    it.status = 'archived';
    it.updated_at = nowIso();
    this.save();
    return it;
  }

  markUsed(ids) {
    const set = new Set(ids || []);
    let dirty = false;
    for (const it of this.data.items) {
      if (set.has(it.id)) {
        it.use_count = (it.use_count || 0) + 1;
        it.last_used_at = nowIso();
        dirty = true;
      }
    }
    if (dirty) this.save();
  }

  export() {
    return { version: this.data.version, exported_at: nowIso(), count: this.active().length, items: this.active() };
  }

  import(items) {
    let n = 0;
    for (const raw of items || []) {
      if (!raw || !raw.text) continue;
      const existed = this.data.items.find((x) => x.id === raw.id || x.text === raw.text);
      if (existed) continue;
      this.data.items.push(Object.assign({
        id: raw.id || uid('mem'),
        kind: 'fact',
        importance: 1,
        pinned: false,
        status: 'active',
        source: 'import',
        created_at: nowIso(),
        updated_at: nowIso(),
        use_count: 0
      }, raw));
      n++;
    }
    this.save();
    return n;
  }
}

module.exports = { Store, KINDS };
