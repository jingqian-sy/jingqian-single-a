'use strict';
/*
 * 重判（judge v2.1）：只把「回复正则」这一类判定按新规则重算一遍，
 * 盘上副作用类判定沿用当次跑出来的结果（工作目录每遍都清，事后无法追溯，不假装重验）。
 * 不重跑模型——回复原文都在存档里。
 *
 *   node evals/rejudge.js data/archive/v2-judge2.0/results-judge2.0.json
 *
 * 输出：data/results.json（judge_version 2.1，带 rejudge 元信息），
 * 旧版本仍然留在 data/archive/ 里，随时能对。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runChecks } = require('./lib/judge');
const { readJson, writeJson } = require('../src/util');

const ROOT = path.join(__dirname, '..');
const TASKS = path.join(__dirname, 'tasks.json');
const OUT = path.join(ROOT, 'data', 'results.json');
const REPLY_TYPES = new Set([
  'reply_contains', 'reply_not_contains', 'reply_max_len', 'reply_min_len',
  'reply_no_markdown', 'reply_min_cjk_ratio'
]);

function sameCheck(a, b) {
  if (a.type !== b.type) return false;
  for (const k of ['value', 'level', 'allowed', 'tool', 'path']) {
    if ((a[k] === undefined) !== (b[k] === undefined)) return false;
    if (a[k] !== undefined && String(a[k]) !== String(b[k])) return false;
  }
  return true;
}

async function main() {
  const src = process.argv[2];
  if (!src) { console.error('用法：node evals/rejudge.js <旧 results.json 路径>'); process.exit(2); }
  const old = readJson(path.resolve(ROOT, src), null);
  if (!old || !old.tasks) { console.error('读不到旧结果：' + src); process.exit(2); }
  const rawTasks = fs.readFileSync(TASKS, 'utf8');
  const taskDefs = JSON.parse(rawTasks).tasks;
  const byId = new Map(taskDefs.map((t) => [t.id, t]));

  const stats = { tasks: 0, reply_rejudged: 0, reused: 0, missing: 0, changed: 0 };
  for (const entry of old.tasks) {
    const def = byId.get(entry.id);
    if (!def) continue;
    entry.checks = def.checks || [];
    for (const att of entry.attempts) {
      const before = !!att.pass;
      const checks = [];
      const oldChecks = att.checks || [];
      for (let i = 0; i < (def.checks || []).length; i++) {
        const c = def.checks[i];
        if (REPLY_TYPES.has(c.type)) {
          const r = (await runChecks([c], { reply: att.reply || '' }))[0];
          checks.push(Object.assign({ rejudged: true }, r));
          stats.reply_rejudged++;
        } else {
          // 盘上判定没法回溯，按「同一条题、同一个位置、同一个类型」沿用当时的结果
          const oldc = (oldChecks[i] && oldChecks[i].type === c.type ? oldChecks[i] : null)
            || oldChecks.find((o) => o.type === c.type);
          if (oldc) {
            checks.push(Object.assign({}, oldc, { reused: true }));
            stats.reused++;
          } else {
            checks.push({ type: c.type, ok: false, detail: '旧结果里没有这条盘上判定，无法复核' });
            stats.missing++;
          }
        }
      }
      att.checks = checks;
      att.failed_checks = checks.filter((c) => !c.ok).map((c) => c.type + '：' + c.detail);
      att.pass = !att.error && checks.every((c) => c.ok);
      if (before !== att.pass) stats.changed++;
    }
    stats.tasks++;
  }

  old.judge_version = 2.1;
  old.tasks_sha1 = crypto.createHash('sha1').update(rawTasks).digest('hex').slice(0, 12);
  old.rejudge = {
    at: new Date().toISOString(),
    from: src,
    from_judge_version: old && old.judge_version ? undefined : 2,
    note: 'judge v2.1：回复正则放宽（认得「没看到/不能/在哪」这类说法）；盘上判定沿用当次结果，未重跑模型。',
    stats
  };
  writeJson(OUT, old);

  const rows = old.tasks.filter((t) => t.attempts.length === 2);
  const both = rows.filter((t) => t.attempts.every((a) => a.pass)).length;
  const unstable = rows.filter((t) => t.attempts[0].pass !== t.attempts[1].pass).length;
  console.log('重判完成：' + stats.tasks + ' 题，重算 ' + stats.reply_rejudged + ' 条回复判定，沿用 '
    + stats.reused + ' 条盘上判定，缺证据 ' + stats.missing + ' 条，结论变化 ' + stats.changed + ' 遍');
  console.log('两遍都过 ' + both + '/' + rows.length + '，不稳定 ' + unstable);
}

main().catch((e) => { console.error(e.stack); process.exit(1); });
