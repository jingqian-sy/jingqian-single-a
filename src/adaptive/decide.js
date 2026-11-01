'use strict';
/*
 * 自适应判定层：先看清楚这活有多大，再决定上几个 Agent
 *
 *   node src/adaptive/decide.js "<任务>"           看一条任务的判定
 *   node src/adaptive/decide.js --batch tasks.json 批量看分布
 *
 * 输出：{ mode: '1a' | '2a' | '3a', score, signals: {...}, why: '...' }
 *
 * 原则：规则先行（毫秒级、可解释），拿不准才问本地小模型；
 * 判成哪一档都要落日志，后面用真实数据校准。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const STATE = path.join(ROOT, 'data');
const LOG = path.join(STATE, 'mode-decision.log');

// 动词越重，越可能需要质检
const HEAVY = /写|改|建|创建|删|跑|执行|安装|部署|重构|整理|汇总|生成文件|批量|迁移|备份/g;
const CONSTRAINT = /然后|接着|再|并且|同时|分别|每个|所有|如果|否则|直到|汇总|表格|清单|对比|核对/g;
const PARALLEL = /同时|并行|分别|各自|同时进行|多个|两边/g;
const READONLY = /^(看看|查一下|读一下|列一下|告诉我|是什么|有多少)/;

// 用户语气：催得急就少一层质检，时间宽裕才上重档
const URGENT = /快点|赶紧|马上|就现在|急/;
const RELAXED = /不急|慢慢|有时间|宽裕|好好/;

function count(text, re) {
  const m = String(text || '').match(re);
  return m ? m.length : 0;
}

function pathHits(text) {
  const m = String(text || '').match(/([A-Za-z]:\\[^\s"'，。]+|\/[^\s"'，。]+|[a-zA-Z0-9_\-]+\.(txt|md|json|js|py|csv|log))/g);
  return m ? m.length : 0;
}

// 规则判定：输出分数 + 信号（不调模型，纯本地）
function score(task) {
  const t = String(task || '');
  const heavy = count(t, HEAVY);
  const cons = count(t, CONSTRAINT);
  const par = count(t, PARALLEL);
  const files = pathHits(t);
  const len = t.length;
  const readonly = READONLY.test(t.trim());
  const urgent = URGENT.test(t);
  const relaxed = RELAXED.test(t);

  let s = 0;
  s += Math.min(4, heavy) * 2;      // 重活，每样 +2，最多 +8
  s += Math.min(4, cons) * 1.5;     // 多约束，每样 +1.5
  s += Math.min(3, files) * 1.5;    // 涉及文件，每个 +1.5
  s += Math.min(3, par) * 2;        // 要并行，每样 +2
  if (len > 60) s += 2;
  if (len > 140) s += 2;
  if (readonly) s -= 3;
  if (urgent) s -= 2;
  if (relaxed) s += 1;

  return {
    score: Math.round(s * 10) / 10,
    signals: { heavy, constraints: cons, parallel: par, files, len, readonly, urgent, relaxed }
  };
}

function decideByRules(task) {
  const { score: s, signals } = score(task);
  let mode = '1a';
  let why = '';
  if (s >= 14) { mode = '3a'; why = '多步 + 多约束/并行，值得上三档互相纠错'; }
  else if (s >= 6) { mode = '2a'; why = '要动手或多步，加一层质检更稳'; }
  else { mode = '1a'; why = '轻活，主脑直接做最快'; }
  if (signals.parallel >= 1 && s >= 10) { mode = '3a'; why = '有并行诉求，三档能省墙钟'; }
  if (signals.readonly && s < 8) { mode = '1a'; why = '只读查询，别为它上一层质检'; }
  return { mode, score: s, signals, why, by: 'rules' };
}

// 拿不准（6~9 分之间）才问本地小模型一句，判不了按 2a 兜底
async function decideWithModel(task) {
  const base = decideByRules(task);
  if (base.score < 5 || base.score > 13) return base;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const conf = cfg.localModel || {};
    const url = (conf.base || 'http://127.0.0.1:11434').replace(/\/$/, '') + '/api/chat';
    const model = (conf.models && conf.models['8b']) || 'qwen3:8b';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, think: false,
        options: { temperature: 0, num_predict: 8 },
        messages: [
          { role: 'system', content: '给任务分档：1a=一句话能答完；2a=要动手、可能要改一两步；3a=多步且互相依赖、需要质检纠错。只回 1a 或 2a 或 3a。' },
          { role: 'user', content: String(task).slice(0, 400) }
        ]
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return base;
    const j = await r.json();
    const v = String((j.message && j.message.content) || '').trim().toLowerCase();
    const m = v.match(/(1a|2a|3a)/);
    if (m) return Object.assign(base, { mode: m[1], why: base.why + '（模型复核：' + m[1] + '）', by: 'rules+model' });
  } catch (e) { }
  return base;
}

async function decide(task) {
  const d = await decideWithModel(task);
  log(task, d);
  return d;
}

function log(task, d) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), task: String(task).slice(0, 80), mode: d.mode, score: d.score, by: d.by }) + '\n', 'utf8');
  } catch (e) { }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--batch') {
    const file = args[1] || path.join(ROOT, 'evals', 'tasks.json');
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tasks = Array.isArray(list) ? list : (list.tasks || []);
    const dist = { '1a': 0, '2a': 0, '3a': 0 };
    const rows = [];
    for (const t of tasks) {
      const ask = t.ask || t.prompt || t.title || t.id || '';
      const d = decideByRules(ask);
      dist[d.mode]++;
      rows.push({ id: t.id, mode: d.mode, score: d.score, ask: String(ask).slice(0, 40) });
    }
    console.log('规则判定分布：1a ' + dist['1a'] + ' · 2a ' + dist['2a'] + ' · 3a ' + dist['3a'] + '（共 ' + tasks.length + ' 题）');
    const show = rows.slice(0, 12).map((r) => '  ' + (r.id || '') + ' → ' + r.mode + ' (' + r.score + ') ' + r.ask);
    console.log(show.join('\n'));
    return;
  }
  const task = args.join(' ').trim();
  if (!task) { console.log('用法: node src/adaptive/decide.js "<任务>" | --batch [tasks.json]'); return; }
  const d = await decide(task);
  console.log(JSON.stringify(d, null, 2));
}

if (require.main === module) {
  main().catch((e) => { console.error('判定失败：' + e.message); process.exit(1); });
}

module.exports = { decide, decideByRules, score };
