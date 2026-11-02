#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把私有版（D:\\鲸倩核心）的记忆迁到开源版的 data/memory/memories.json。

来源两份，按「文字归一化后」去重，db 优先（字段更全）：
  - D:\\鲸倩核心\\memory-service\\memory.db   （统一记忆服务，819 条，有 kind/status）
  - D:\\鲸倩核心\\state\\memories-export.json （导出快照，782 条，没有 kind）

映射：
  kind: emotional/relation/fact/lesson 原样；ephemeral -> fact（importance 压到 1，source 标 migrated:ephemeral）
  importance: 私有是 0~1 小数 -> 开源 1~4：pinned=4，>=0.9 给 3，其余 2（ephemeral 给 1）
  时间：毫秒 -> ISO
  额外字段（tier/salience/level/keywords/reviews/legacy_id）原样留着，便于以后对照。

用法：
  python migrate-private-memory.py --target <memories.json> [--target ...]
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import time

PRIVATE_DB = r'D:\鲸倩核心\memory-service\memory.db'
PRIVATE_EXPORT = r'D:\鲸倩核心\state\memories-export.json'
KINDS = {'emotional', 'relation', 'fact', 'lesson', 'preference'}


def norm(s):
    s = (s or '').strip().lower()
    s = re.sub(r'\s+', ' ', s)
    s = re.sub(r'[。．.!！?？,，;；:：…\s]+$', '', s)
    return s


def iso(ms):
    if not ms:
        return None
    try:
        return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(int(ms) / 1000)) + '.000Z'
    except Exception:
        return None


def imp_of(v, pinned, ephemeral):
    if ephemeral:
        return 1
    if pinned:
        return 4
    try:
        f = float(v)
    except Exception:
        f = 0.3
    return 3 if f >= 0.9 else 2


def from_db():
    out = []
    if not os.path.exists(PRIVATE_DB):
        return out
    con = sqlite3.connect(PRIVATE_DB)
    con.row_factory = sqlite3.Row
    for r in con.execute('select * from memories'):
        kind = r['kind'] or 'emotional'
        status = r['status'] or 'active'
        ephemeral = kind == 'ephemeral'
        if ephemeral:
            kind = 'fact'
        out.append({
            'text': r['text'],
            'kind': kind,
            'importance': imp_of(r['importance'], r['pinned'], ephemeral),
            'pinned': bool(r['pinned']),
            'status': 'archived' if status == 'archived' else 'active',
            'source': ('migrated:ephemeral' if ephemeral else ('migrated:' + (r['source'] or 'private'))),
            'created_at': iso(r['created_at']),
            'updated_at': iso(r['updated_at']),
            'last_used_at': iso(r['last_seen_at']),
            'use_count': int(r['reviews'] or 0),
            'keywords': r['keywords'] or '',
            'legacy_id': r['id'],
            'tier': r['tier'],
            'salience': r['salience'],
            'level': r['level'],
        })
    return out


def from_export(db_texts):
    out = []
    if not os.path.exists(PRIVATE_EXPORT):
        return out
    items = json.load(open(PRIVATE_EXPORT, encoding='utf-8'))
    if isinstance(items, dict):
        items = list(items.values())[0] if items else []
    for it in items:
        text = it.get('text') or ''
        if not text or norm(text) in db_texts:
            continue
        pinned = bool(it.get('pinned'))
        out.append({
            'text': text,
            'kind': 'fact',
            'importance': imp_of(it.get('importance'), pinned, False),
            'pinned': pinned,
            'status': 'active',
            'source': 'migrated:export',
            'created_at': iso(it.get('updated_at')),
            'updated_at': iso(it.get('updated_at')),
            'last_used_at': None,
            'use_count': 0,
            'keywords': it.get('keywords') or '',
            'legacy_id': it.get('id'),
            'level': it.get('level'),
        })
    return out


def merge_target(target, incoming):
    data = {'version': 1, 'items': []}
    if os.path.exists(target):
        try:
            data = json.load(open(target, encoding='utf-8'))
        except Exception:
            pass
    items = data.get('items') or []
    have = {norm(x.get('text')) for x in items if x.get('text')}
    added = 0
    for it in incoming:
        k = norm(it['text'])
        if not k or k in have:
            continue
        have.add(k)
        # 生成和开源版一致的 id 形状（不撞车就行）
        it['id'] = 'mem_migrated_' + re.sub(r'[^a-z0-9]', '', str(it.get('legacy_id') or added).lower())[:12] + str(added)
        items.append(it)
        added += 1
    data['items'] = items
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = target + '.tmp'
    json.dump(data, open(tmp, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    os.replace(tmp, target)
    return len(items), added


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', action='append', required=True)
    args = ap.parse_args()
    db = from_db()
    db_texts = {norm(x['text']) for x in db}
    exp = from_export(db_texts)
    incoming = db + exp
    print(f'private: db={len(db)} export_extra={len(exp)} total={len(incoming)}')
    print('kinds:', {k: sum(1 for x in incoming if x['kind'] == k) for k in sorted({x['kind'] for x in incoming})})
    print('pinned:', sum(1 for x in incoming if x['pinned']))
    for t in args.target:
        total, added = merge_target(t, incoming)
        print(f'{t}: items={total} added={added}')


if __name__ == '__main__':
    sys.exit(main())
