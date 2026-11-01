'use strict';
/*
 * 判定器：每一条判定都要能在盘上或日志里找到证据。
 *
 * 允许的 check 类型（跟 tasks.json 里的 schema 一一对应）：
 *   reply_contains / reply_not_contains / reply_max_len / reply_min_len
 *   reply_no_markdown        不许出现 **、##、```、行首 - / 1. 这类 Markdown 标记
 *   reply_min_cjk_ratio      中文字符占比下限（防整句英文）
 *   file_exists / file_not_exists / file_contains / file_count
 *   memory_contains / memory_pinned / memory_count
 *   reminder_contains
 *   audit_level              审计日志里出现过某级别（可再限定工具与放行状态）
 *   tool_used                这一轮真的调用过某个工具
 *   timeline_contains        事件层里出现过某个词
 *   event_count_lte          事件条数上限（验证「同一件事被串起来」）
 *   recall_order             召回排序：first 排在 second 前面
 *   workspace_no_double_prefix  没出现 data/workspace/data/workspace 这种重复前缀
 *
 * 每个 check 返回 {type, ok, detail}；task 的 checks 全过才算这一遍过。
 * 没有任何「模型说它过了就算过」的路径。
 */
const fs = require('fs');
const path = require('path');
const { recall } = require('../../src/memory/retrieve');

const MARKDOWN = [
  { re: /```/, why: '代码块 ```' },
  { re: /^\s{0,3}#{1,6}\s/m, why: '标题 #' },
  { re: /\*\*[^*]+\*\*/, why: '加粗 **' },
  { re: /^\s{0,3}[-*+]\s+\S/m, why: '无序列表 -' },
  { re: /^\s{0,3}\d+[.)]\s+\S/m, why: '有序列表 1.' },
  { re: /^\s{0,3}\|.*\|.*\|/m, why: '表格 |' }
];

function readAudit(her) {
  const file = path.join(her.dataDir, 'audit.log');
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

function cjkRatio(s) {
  const str = String(s || '');
  const cjk = (str.match(/[\u4e00-\u9fa5]/g) || []).length;
  const total = str.replace(/\s/g, '').length;
  return total ? cjk / total : 0;
}

function countFiles(dir, ext) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && (!ext || d.name.endsWith(ext))).length;
  } catch (e) { return 0; }
}

async function runChecks(checks, ctx) {
  const out = [];
  for (const c of checks || []) {
    let ok = false;
    let detail = '';
    const reply = String(ctx.reply || '');
    try {
      switch (c.type) {
        case 'reply_contains': {
          const re = new RegExp(c.value);
          ok = re.test(reply);
          detail = '期望命中 /' + c.value + '/';
          break;
        }
        case 'reply_not_contains': {
          const re = new RegExp(c.value);
          ok = !re.test(reply);
          detail = '不许命中 /' + c.value + '/';
          break;
        }
        case 'reply_max_len': {
          ok = reply.trim().length <= Number(c.value);
          detail = '长度 ' + reply.trim().length + ' ≤ ' + c.value;
          break;
        }
        case 'reply_min_len': {
          ok = reply.trim().length >= Number(c.value);
          detail = '长度 ' + reply.trim().length + ' ≥ ' + c.value;
          break;
        }
        case 'reply_no_markdown': {
          const hit = MARKDOWN.find((m) => m.re.test(reply));
          ok = !hit;
          detail = hit ? '出现 Markdown 标记：' + hit.why : '没有 Markdown 标记';
          break;
        }
        case 'reply_min_cjk_ratio': {
          const r = cjkRatio(reply);
          ok = r >= Number(c.value);
          detail = '中文占比 ' + Math.round(r * 100) + '% ≥ ' + Math.round(Number(c.value) * 100) + '%';
          break;
        }
        case 'file_exists': {
          ok = fs.existsSync(path.join(ctx.workspace, c.path));
          detail = '看盘：' + c.path + ' ' + (ok ? '在' : '不在');
          break;
        }
        case 'file_not_exists': {
          ok = !fs.existsSync(path.join(ctx.workspace, c.path));
          detail = '看盘：' + c.path + ' ' + (ok ? '不存在（对）' : '存在（不该有）');
          break;
        }
        case 'file_contains': {
          const p = path.join(ctx.workspace, c.path);
          if (!fs.existsSync(p)) { ok = false; detail = '看盘：' + c.path + ' 不存在'; break; }
          const txt = fs.readFileSync(p, 'utf8');
          ok = new RegExp(c.value).test(txt);
          detail = '看盘：' + c.path + ' 内容' + (ok ? '命中' : '没命中') + ' /' + c.value + '/';
          break;
        }
        case 'file_count': {
          const n = countFiles(path.join(ctx.workspace, c.path || '.'), c.ext);
          ok = c.compare === 'gte' ? n >= Number(c.value) : n === Number(c.value);
          detail = '看盘：' + (c.path || '.') + ' 有 ' + n + ' 个' + (c.ext || '文件');
          break;
        }
        case 'memory_contains': {
          ok = ctx.her.store.active().some((x) => new RegExp(c.value).test(x.text));
          detail = '记忆库里有 /' + c.value + '/';
          break;
        }
        case 'memory_pinned': {
          const it = ctx.her.store.active().find((x) => new RegExp(c.value).test(x.text));
          ok = !!(it && it.pinned);
          detail = '被钉住的记忆里有 /' + c.value + '/';
          break;
        }
        case 'memory_count': {
          const n = ctx.her.store.count();
          ok = n === Number(c.value);
          detail = '记忆条数 ' + n + '（期望 ' + c.value + '）';
          break;
        }
        case 'reminder_contains': {
          let list = [];
          try { list = JSON.parse(fs.readFileSync(path.join(ctx.her.dataDir, 'reminders.json'), 'utf8')); } catch (e) {}
          ok = list.some((x) => new RegExp(c.value).test(x.text || ''));
          detail = '提醒列表里有 /' + c.value + '/';
          break;
        }
        case 'audit_level': {
          const lines = readAudit(ctx.her);
          const hit = lines.find((o) => o.level === c.level
            && (!c.tool || o.tool === c.tool)
            && (c.allowed === undefined || !!o.allowed === !!c.allowed));
          ok = !!hit;
          detail = '审计里' + (hit ? '有' : '没有') + ' ' + c.level
            + (c.tool ? '/' + c.tool : '') + (c.allowed === undefined ? '' : (c.allowed ? '（放行）' : '（拦下）'));
          break;
        }
        case 'tool_used': {
          const used = ctx.stats.tools || [];
          ok = used.includes(c.value);
          detail = '这轮调用过 ' + (used.join(',') || '（无工具）') + '，期望 ' + c.value;
          break;
        }
        case 'timeline_contains': {
          ok = ctx.her.events.all().some((e) => new RegExp(c.value).test(e.title + ' ' + e.entities.join(' ') + ' ' + e.result));
          detail = '事件层里有 /' + c.value + '/';
          break;
        }
        case 'event_count_lte': {
          const n = ctx.her.events.all().length;
          ok = n <= Number(c.value);
          detail = '事件数 ' + n + ' ≤ ' + c.value;
          break;
        }
        case 'recall_order': {
          const r = await recall(ctx.her.store, c.query, { topK: 8 });
          const texts = r.hits.map((h) => h.text);
          const i1 = texts.findIndex((t) => new RegExp(c.first).test(t));
          const i2 = texts.findIndex((t) => new RegExp(c.second).test(t));
          ok = i1 >= 0 && (i2 < 0 || i1 < i2);
          detail = '召回顺序 ' + texts.map((t) => t.slice(0, 12)).join(' > ');
          break;
        }
        case 'workspace_no_double_prefix': {
          ok = !fs.existsSync(path.join(ctx.workspace, 'data', 'workspace'));
          detail = ok ? '没有 data/workspace/data/workspace' : '出现了重复前缀目录';
          break;
        }
        default:
          ok = false;
          detail = '未知的 check 类型：' + c.type;
      }
    } catch (e) {
      ok = false;
      detail = '判定出错：' + e.message;
    }
    out.push({ type: c.type, ok, detail });
  }
  return out;
}

module.exports = { runChecks, readAudit, MARKDOWN, cjkRatio };
