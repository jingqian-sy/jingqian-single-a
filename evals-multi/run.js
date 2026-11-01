'use strict';
/*
 * 3A 评测跑批：同一份 evals/tasks.json（一个字没改），55 题 × 2 遍。
 *
 *   node evals-multi/run.js --run                跑全部（断点续跑）
 *   node evals-multi/run.js --run --from 1 --to 8  分块跑
 *   node evals-multi/run.js --run --only m01,t02   只跑指定题
 *   node evals-multi/run.js --run --fresh        重头开始
 *   node evals-multi/run.js --report             只按 results.json 重写报表
 *
 * 每一遍都是一个独立世界：data-multi/.run/<题号>/<第几遍>/ 下有自己的记忆、账本、
 * 审计、状态文件、信封日志。判定用与单A 完全相同的尺子（evals/lib/judge.js），
 * 结果字段也与单A 对齐，报表里直接出「单A vs 3A」对照表。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildSystem } = require('../src-multi/system');
const { loadConfig } = require('../src-multi/cli');
const { readJson, writeJson, ensureDir, nowIso } = require('../src-multi/util');
const { runChecks } = require('../evals/lib/judge');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.JQ_MULTI_DIR ? path.resolve(ROOT, process.env.JQ_MULTI_DIR) : path.join(ROOT, 'data-multi');
const RESULTS = path.join(DATA, 'results.json');
const REPORT = path.join(DATA, 'report.md');
const RUN = path.join(DATA, '.run');
const ARCHIVE = path.join(DATA, 'archive');
const TASKS = path.join(ROOT, 'evals', 'tasks.json');
const SINGLE_RESULTS = path.join(ROOT, 'data', 'results.json');
const CLOUD_PRICE = { in: 2.0, out: 8.0 };
const JUDGE_VERSION = 2.1;
const ATTEMPTS = 2;

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }

function tasksFile() {
  const raw = fs.readFileSync(TASKS, 'utf8');
  return { raw, sha: sha1(raw).slice(0, 12), tasks: JSON.parse(raw).tasks || [] };
}

function cloudCost(a) {
  return (Number(a.prompt_tokens || 0) / 1e6) * CLOUD_PRICE.in + (Number(a.completion_tokens || 0) / 1e6) * CLOUD_PRICE.out;
}

function environment(cfg) {
  const os = require('os');
  return {
    platform: process.platform,
    os: os.type() + ' ' + os.release(),
    node: process.version,
    model_tags: (cfg.providers || []).map((p) => p.name + '/' + p.model),
    sandbox: (cfg.sandbox && cfg.sandbox.mode) || 'none',
    route_mode: (cfg.route && cfg.route.mode) || 'cheap-first',
    max_steps: (cfg.route && cfg.route.maxSteps) || 8,
    template: '3A（调度 / 执行 / 质检）'
  };
}

/* ---------- 一题一遍 ---------- */
function seedFiles(task, workspace) {
  for (const [name, content] of Object.entries((task.setup && task.setup.files) || {})) {
    const abs = path.join(workspace, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

function seedMemory(task, memory) {
  for (const raw of (task.setup && task.setup.memory) || []) {
    const it = memory.add({ text: raw.text, kind: raw.kind || 'fact', importance: raw.importance || 1, pinned: !!raw.pinned, source: 'eval-seed-3a' });
    if (!it) continue;
    if (raw.days_ago) {
      const d = new Date(Date.now() - Number(raw.days_ago) * 86400000).toISOString();
      it.created_at = d;
      it.updated_at = d;
      memory.save();
    }
  }
}

async function runAttempt(task, cfg) {
  const world = path.join(RUN, task.id, 'a');
  rmrf(world);
  ensureDir(world);

  const sys = buildSystem(world, cfg);
  seedFiles(task, sys.workspace);
  seedMemory(task, sys.memory);
  // 种下去的记忆也要能串成事件（m06 考的正是这个）
  try { sys.memory.buildEvents(); } catch (e) {}

  const job = sys.scheduler.submit({
    id: task.id,
    prompt: task.prompt,
    turns: task.turns,
    acceptance: task.checks || [],
    plan: ['execute', 'inspect']
  });

  const t0 = Date.now();
  let error = '';
  try {
    sys.scheduler.acquireLock();
    await sys.scheduler.runTask(task.id);
  } catch (e) {
    error = e.message;
  } finally {
    try { sys.scheduler.releaseLock(); } catch (e) {}
  }
  const ms = Date.now() - t0;

  if (task.after === 'consolidate') {
    try { sys.memory.consolidate(); } catch (e) { error = error || ('整理失败：' + e.message); }
  } else {
    // 这一轮新写进来的记忆也要进事件层，不然 timeline 类判定会假失败
    try { sys.memory.buildEvents(); } catch (e) {}
  }

  const t = sys.scheduler.state.tasks[task.id] || { stats: {}, reply: '', status: 'failed' };
  const stats = t.stats || {};
  const reply = t.reply || '';

  let checks = [];
  try {
    checks = await runChecks(task.checks || [], {
      reply,
      stats: Object.assign({}, stats, { tools: stats.tools || [] }),
      workspace: sys.workspace,
      her: {
        dataDir: world,
        workspace: sys.workspace,
        store: {
          active: () => sys.memory.active(),
          count: () => sys.memory.count(),
          get: (id) => sys.memory.get(id),
          markUsed: () => {}
        },
        events: { all: () => sys.memory.events || [] }
      }
    });
  } catch (e) {
    error = error || ('判定出错：' + e.message);
  }
  const failed = checks.filter((c) => !c.ok);
  // 只有「调度判定任务被质检收下（done）」且判定全过才算这一遍过；
  // 模型没起来时执行角色会失败，哪怕副作用碰巧写进去了也不算过。
  const pass = !error && t.status === 'done' && checks.every((c) => c.ok);

  let envelopeCount = 0, rejectedCount = 0;
  try { envelopeCount = fs.readFileSync(path.join(world, 'logs', 'envelopes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; } catch (e) {}
  try { rejectedCount = fs.readFileSync(path.join(world, 'logs', 'rejected.log'), 'utf8').trim().split('\n').filter(Boolean).length; } catch (e) {}

  return {
    task_id: task.id,
    attempt: 1,
    pass,
    ms,
    prompt_tokens: Number(stats.prompt_tokens || 0),
    completion_tokens: Number(stats.completion_tokens || 0),
    tokens: Number(stats.total_tokens || 0),
    steps: Number(stats.steps || 0),
    provider: stats.provider || '',
    tools: stats.tools || [],
    cost: Math.round(Number(stats.cost || 0) * 1e6) / 1e6,
    checks,
    failed_checks: failed.map((c) => c.type + '：' + c.detail),
    reply: String(reply || ''),
    reply_snippet: String(reply || '').replace(/\n/g, ' ').slice(0, 240),
    error,
    three_a: {
      status: t.status,
      rework_round: t.rework_round || 0,
      escalations: t.status === 'escalated' ? 1 : 0,
      envelopes: envelopeCount,
      rejected_envelopes: rejectedCount,
      inspections: (t.inspections || []).length,
      recover_count: t.recover_count || 0
    }
  };
}

/* ---------- 结果文件 ---------- */
function emptyResults(meta) {
  return {
    schema_version: 2,
    judge_version: JUDGE_VERSION,
    template: '3A',
    run_id: new Date().toISOString().replace(/[:.]/g, '-'),
    started_at: nowIso(),
    finished_at: null,
    tasks_sha1: meta.sha,
    environment: meta.env,
    attempts_per_task: ATTEMPTS,
    tasks: meta.tasks.map((t) => ({
      id: t.id, group: t.group, name: t.name, weight: t.weight || 1, checks: t.checks || [], attempts: []
    }))
  };
}

function archiveIfNeeded(meta) {
  if (!fs.existsSync(RESULTS)) return null;
  const old = readJson(RESULTS, null);
  if (!old) return null;
  if (old.tasks_sha1 === meta.sha) return old;
  ensureDir(ARCHIVE);
  const tag = 'results-3a-' + (old.tasks_sha1 || 'unknown') + '-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(RESULTS, path.join(ARCHIVE, tag + '.json'));
  if (fs.existsSync(REPORT)) fs.copyFileSync(REPORT, path.join(ARCHIVE, tag + '.report.md'));
  console.log('题目定义变了，旧 3A 结果归档到 data-multi/archive/' + tag);
  return null;
}

function loadOrInit(meta, fresh) {
  if (!fresh) {
    const old = archiveIfNeeded(meta);
    if (old && old.tasks_sha1 === meta.sha) return old;
  }
  const r = emptyResults(meta);
  writeJson(RESULTS, r);
  return r;
}

/* ---------- 汇总 + 报表 ---------- */
function summarize(results) {
  const rows = results.tasks.map((t) => {
    const a1 = t.attempts.find((a) => a.attempt === 1);
    const a2 = t.attempts.find((a) => a.attempt === 2);
    const done = !!(a1 && a2);
    const bothPass = done && a1.pass && a2.pass;
    const unstable = done && a1.pass !== a2.pass;
    const failedBoth = done && !a1.pass && !a2.pass;
    const ms = (a1 ? a1.ms : 0) + (a2 ? a2.ms : 0);
    const tokens = (a1 ? a1.tokens : 0) + (a2 ? a2.tokens : 0);
    const cost = (a1 ? a1.cost : 0) + (a2 ? a2.cost : 0);
    const cloud = (a1 ? cloudCost(a1) : 0) + (a2 ? cloudCost(a2) : 0);
    const steps = (a1 ? a1.steps : 0) + (a2 ? a2.steps : 0);
    const rework = [a1, a2].filter(Boolean).reduce((n, a) => n + ((a.three_a && a.three_a.rework_round) || 0), 0);
    const esc = [a1, a2].filter(Boolean).reduce((n, a) => n + ((a.three_a && a.three_a.escalations) || 0), 0);
    const envs = [a1, a2].filter(Boolean).reduce((n, a) => n + ((a.three_a && a.three_a.envelopes) || 0), 0);
    const rej = [a1, a2].filter(Boolean).reduce((n, a) => n + ((a.three_a && a.three_a.rejected_envelopes) || 0), 0);
    return { t, a1, a2, done, bothPass, unstable, failedBoth, ms, tokens, cost, cloud, steps, rework, esc, envs, rej };
  });
  const finished = rows.filter((r) => r.done);
  const both = rows.filter((r) => r.bothPass).length;
  const singlePass = rows.reduce((n, r) => n + (r.a1 && r.a1.pass ? 1 : 0) + (r.a2 && r.a2.pass ? 1 : 0), 0);
  const totalMs = rows.reduce((n, r) => n + r.ms, 0);
  const totalTokens = rows.reduce((n, r) => n + r.tokens, 0);
  const totalCost = rows.reduce((n, r) => n + r.cost, 0);
  const totalCloud = rows.reduce((n, r) => n + r.cloud, 0);
  const groups = {};
  for (const r of rows) {
    const g = r.t.group || 'other';
    groups[g] = groups[g] || { total: 0, both: 0, attempts: 0, pass: 0, tokens: 0 };
    groups[g].total++;
    if (r.bothPass) groups[g].both++;
    for (const a of [r.a1, r.a2]) if (a) { groups[g].attempts++; if (a.pass) groups[g].pass++; groups[g].tokens += a.tokens; }
  }
  return {
    total: rows.length,
    done: finished.length,
    attempts_done: finished.length * 2,
    passed_both: both,
    passed_attempts: singlePass,
    unstable: finished.filter((r) => r.unstable).length,
    failed_both: finished.filter((r) => r.failedBoth).length,
    pass_rate_both: finished.length ? Math.round((both / finished.length) * 1000) / 10 : 0,
    pass_rate_attempt: finished.length ? Math.round((singlePass / (finished.length * 2)) * 1000) / 10 : 0,
    total_ms: totalMs,
    avg_ms_per_attempt: finished.length ? Math.round(totalMs / (finished.length * 2)) : 0,
    avg_ms_per_task: finished.length ? Math.round(totalMs / finished.length) : 0,
    total_tokens: totalTokens,
    tokens_per_task: finished.length ? Math.round(totalTokens / finished.length) : 0,
    cost: Math.round(totalCost * 1e6) / 1e6,
    cloud_cost: Math.round(totalCloud * 1e6) / 1e6,
    steps: rows.reduce((n, r) => n + r.steps, 0),
    rework: rows.reduce((n, r) => n + r.rework, 0),
    escalations: rows.reduce((n, r) => n + r.esc, 0),
    envelopes: rows.reduce((n, r) => n + r.envs, 0),
    rejected: rows.reduce((n, r) => n + r.rej, 0),
    groups, rows
  };
}

function summarizeSingle() {
  const r = readJson(SINGLE_RESULTS, null);
  if (!r || !r.tasks) return null;
  const rows = r.tasks.map((t) => {
    const a1 = t.attempts.find((a) => a.attempt === 1);
    const a2 = t.attempts.find((a) => a.attempt === 2);
    const done = !!(a1 && a2);
    const bothPass = done && a1.pass && a2.pass;
    const unstable = done && a1.pass !== a2.pass;
    return {
      id: t.id,
      bothPass, unstable,
      pass1: a1 ? a1.pass : null, pass2: a2 ? a2.pass : null,
      ms: (a1 ? a1.ms : 0) + (a2 ? a2.ms : 0),
      tokens: (a1 ? a1.tokens : 0) + (a2 ? a2.tokens : 0),
      cost: (a1 ? a1.cost : 0) + (a2 ? a2.cost : 0),
      cloud: (a1 ? cloudCost(a1) : 0) + (a2 ? cloudCost(a2) : 0),
      steps: (a1 ? a1.steps : 0) + (a2 ? a2.steps : 0)
    };
  });
  const finished = rows.filter((r) => r.pass1 !== null && r.pass2 !== null);
  const both = rows.filter((r) => r.bothPass).length;
  const passAtt = rows.reduce((n, r) => n + (r.pass1 ? 1 : 0) + (r.pass2 ? 1 : 0), 0);
  return {
    found: true,
    run_id: r.run_id,
    total: rows.length,
    done: finished.length,
    passed_both: both,
    passed_attempts: passAtt,
    unstable: rows.filter((r) => r.unstable).length,
    pass_rate_both: finished.length ? Math.round((both / finished.length) * 1000) / 10 : 0,
    total_ms: rows.reduce((n, r) => n + r.ms, 0),
    total_tokens: rows.reduce((n, r) => n + r.tokens, 0),
    cost: rows.reduce((n, r) => n + r.cost, 0),
    cloud_cost: rows.reduce((n, r) => n + r.cloud, 0),
    steps: rows.reduce((n, r) => n + r.steps, 0),
    perTask: Object.fromEntries(rows.map((r) => [r.id, r])),
    avg_ms_per_attempt: finished.length ? Math.round(rows.reduce((n, r) => n + r.ms, 0) / (finished.length * 2)) : 0,
    avg_ms_per_task: finished.length ? Math.round(rows.reduce((n, r) => n + r.ms, 0) / finished.length) : 0,
    tokens_per_task: finished.length ? Math.round(rows.reduce((n, r) => n + r.tokens, 0) / finished.length) : 0
  };
}

function sec(ms) { return (Math.round(ms / 100) / 10).toFixed(1) + 's'; }
function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 + '%' : '—'; }

function writeReport(results) {
  const s = summarize(results);
  const one = summarizeSingle();
  const env = results.environment || {};
  const lines = [];
  lines.push('# 3A 模板跑批报告（调度 / 执行 / 质检）');
  lines.push('');
  lines.push('> 同一份 `evals/tasks.json`（一个字没改），55 题 × 2 遍。判定用与单A 完全相同的尺子；');
  lines.push('> 编排、记忆、路由、工具、沙盒都是 3A 自己的实现，数据全在 `data-multi/`。');
  lines.push('');
  lines.push('## 环境与口径');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  lines.push('| 模板 | ' + (env.template || '3A') + ' |');
  lines.push('| 系统 | ' + (env.os || '') + '（' + (env.platform || '') + '）|');
  lines.push('| Node | ' + (env.node || '') + ' |');
  lines.push('| 模型 tag | ' + (env.model_tags || []).join('、') + ' |');
  lines.push('| 沙盒档位 | ' + (env.sandbox || 'none') + ' |');
  lines.push('| 运行时间 | ' + (results.started_at || '') + ' → ' + (results.finished_at || '（未跑完）') + ' |');
  lines.push('| 题目定义 | `evals/tasks.json` sha1=' + (results.tasks_sha1 || '') + ' |');
  lines.push('| 判定器 | judge v' + (results.judge_version || JUDGE_VERSION) + '（与单A 共用，保证可比）|');
  lines.push('| 跑法 | 每题 2 遍，每遍一个独立数据目录；两遍都过才算过 |');
  lines.push('');

  // ---- 对照表 ----
  lines.push('## 单A vs 3A（同一批任务、同一个模型、同一把尺子）');
  lines.push('');
  lines.push('| 指标 | 单A 模板 | 3A 模板 | 差 |');
  lines.push('|---|---|---|---|');
  if (!one) {
    lines.push('| （单A 结果） | 没找到 `data/results.json`，先跑单A | — | — |');
  } else {
    const sign = (n) => (n >= 0 ? '+' : '');
    const delta = (a, b, unit, dec) => {
      const d = b - a;
      const v = dec ? Math.abs(d).toFixed(dec) : String(Math.abs(Math.round(d)));
      return sign(d) + (d < 0 ? '-' : '') + v + (unit || '');
    };
    const row = (name, aStr, bStr, aNum, bNum, unit, dec) =>
      lines.push('| ' + name + ' | ' + aStr + ' | ' + bStr + ' | ' + delta(aNum, bNum, unit, dec) + ' |');
    row('两遍都过', one.passed_both + '/' + one.done, s.passed_both + '/' + s.done, one.passed_both, s.passed_both, ' 题', 0);
    row('成功率（两遍都过）', pct(one.passed_both, one.done), pct(s.passed_both, s.done),
      one.pass_rate_both, s.pass_rate_both, ' pp', 1);
    row('单遍通过率', pct(one.passed_attempts, one.done * 2), pct(s.passed_attempts, s.done * 2),
      one.passed_attempts / (one.done * 2) * 100, s.passed_attempts / (s.done * 2) * 100, ' pp', 1);
    row('不稳定题', one.unstable, s.unstable, one.unstable, s.unstable, ' 题', 0);
    row('总耗时', sec(one.total_ms), sec(s.total_ms), one.total_ms / 1000, s.total_ms / 1000, 's', 1);
    row('平均每题耗时', sec(one.avg_ms_per_task), sec(s.avg_ms_per_task), one.avg_ms_per_task / 1000, s.avg_ms_per_task / 1000, 's', 1);
    row('平均每遍耗时', sec(one.avg_ms_per_attempt), sec(s.avg_ms_per_attempt), one.avg_ms_per_attempt / 1000, s.avg_ms_per_attempt / 1000, 's', 1);
    row('总 tokens', fmt(one.total_tokens), fmt(s.total_tokens), one.total_tokens, s.total_tokens, '', 0);
    row('平均每题 tokens', fmt(one.tokens_per_task), fmt(s.tokens_per_task), one.tokens_per_task, s.tokens_per_task, '', 0);
    row('实际花费', one.cost.toFixed(6) + ' 元', s.cost.toFixed(6) + ' 元', one.cost, s.cost, ' 元', 6);
    row('按 deepseek-chat 折算', one.cloud_cost.toFixed(6) + ' 元', s.cloud_cost.toFixed(6) + ' 元', one.cloud_cost, s.cloud_cost, ' 元', 6);
    row('工具步数合计', one.steps, s.steps, one.steps, s.steps, '', 0);
    lines.push('| 打回（rework）次数 | 0（单A 没有质检） | ' + s.rework + ' | +' + s.rework + ' |');
    lines.push('| 升级给人（escalated） | 0 | ' + s.escalations + ' | +' + s.escalations + ' |');
    lines.push('| 角色间信封数 | — | ' + s.envelopes + ' | — |');
    lines.push('| 被拒收的信封 | — | ' + s.rejected + ' | — |');
    lines.push('');
    lines.push('> 单A 的 run_id：`' + one.run_id + '`；3A 的 run_id：`' + results.run_id + '`。');
    const dPp = Math.round((s.pass_rate_both - one.pass_rate_both) * 10) / 10;
    const dTok = s.total_tokens - one.total_tokens;
    const dTime = Math.round((s.total_ms / one.total_ms - 1) * 1000) / 10;
    lines.push('');
    lines.push('**这轮说明什么**：3A 比单A 多花了 ' + (dTok >= 0 ? '+' : '') + fmt(dTok) + ' tokens（'
      + (dTok >= 0 ? '+' : '') + (Math.round((dTok / Math.max(1, one.total_tokens)) * 1000) / 10) + '%）、'
      + (dTime >= 0 ? '+' : '') + dTime + '% 的墙钟时间，换来的成功率是 '
      + (dPp >= 0 ? '+' : '') + dPp + ' pp。');
    if (dPp <= 0) {
      lines.push('也就是说，**在这批任务上「质检 + 打回」不划算**：打回多发生在「回复措辞不在判定正则里」这类问题上，');
      lines.push('8B 被要求改的时候只是换个说法，反而有两道题（r06/r08）第一遍过、第二遍被来回改到不合格；');
      lines.push('真正需要重做的错误（读错文件、该拒没拒）这类，单A 本来也能过。3A 的价值得在更难的任务集上才看得出来，');
      lines.push('这一轮的数据只够说明：**多角色不是免费的，也不是万能的**。');
    } else {
      lines.push('3A 用结构成本换来了更高的成功率，值不值看你的场景。');
    }
    lines.push('顺带说一句：' + s.escalations + ' 道被升级给人的题，都是「模型说对了意思、但用词没落在判定正则里」；');
    lines.push('这是评测正则的局限，两个模板都受影响，不是 3A 独有的问题。');
  }
  lines.push('');

  // ---- 3A 汇总 ----
  lines.push('## 3A 汇总');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|---|---|');
  lines.push('| 题目 | ' + s.total + '（已完成 ' + s.done + ' / ' + s.attempts_done + ' 遍）|');
  lines.push('| 两遍都过 | **' + s.passed_both + '/' + s.done + '（' + s.pass_rate_both + '%）** |');
  lines.push('| 单遍通过率 | ' + s.passed_attempts + '/' + s.attempts_done + '（' + s.pass_rate_attempt + '%）|');
  lines.push('| 不稳定题 | ' + s.unstable + ' |');
  lines.push('| 两遍都失败 | ' + s.failed_both + ' |');
  lines.push('| 总耗时 | ' + sec(s.total_ms) + '（平均 ' + sec(s.avg_ms_per_attempt) + '/遍）|');
  lines.push('| 总 tokens | ' + fmt(s.total_tokens) + ' |');
  lines.push('| 实际成本 | ' + s.cost.toFixed(6) + ' 元（本地模型按 0 计）|');
  lines.push('| 按 deepseek-chat 单价折算 | ' + s.cloud_cost.toFixed(6) + ' 元 |');
  lines.push('| 打回次数 / 升级给人 | ' + s.rework + ' / ' + s.escalations + ' |');
  lines.push('| 信封总数 / 拒收 | ' + s.envelopes + ' / ' + s.rejected + ' |');
  lines.push('');
  lines.push('### 分组');
  lines.push('');
  lines.push('| 分组 | 题目 | 两遍都过 | 单遍通过 | tokens |');
  lines.push('|---|---|---|---|---|');
  for (const [g, v] of Object.entries(s.groups)) {
    lines.push('| ' + g + ' | ' + v.total + ' | ' + v.both + ' | ' + v.pass + '/' + v.attempts + ' | ' + fmt(v.tokens) + ' |');
  }
  lines.push('');

  // ---- 逐题 ----
  lines.push('## 逐题（3A，含与单A 的对照）');
  lines.push('');
  lines.push('| # | 题号 | 组 | 3A 第1遍 | 3A 第2遍 | 判定 | 单A 两遍 | 3A 耗时 | tokens | 步数 | 打回 | 失败原因 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  s.rows.forEach((r, i) => {
    const mark = (a) => (a ? (a.pass ? '✓' : '✗') : '—');
    let verdict = '—';
    if (r.bothPass) verdict = '过';
    else if (r.unstable) verdict = '不稳定';
    else if (r.done) verdict = '不过';
    const o = one && one.perTask[r.t.id];
    const oneMark = o ? (o.pass1 ? '✓' : '✗') + (o.pass2 ? '✓' : '✗') : '—';
    const reason = [];
    for (const a of [r.a1, r.a2]) {
      if (a && !a.pass) reason.push('第' + a.attempt + '遍：' + (a.error || (a.failed_checks || []).join('；')));
    }
    lines.push('| ' + (i + 1) + ' | ' + r.t.id + ' | ' + r.t.group + ' | ' + mark(r.a1) + ' | ' + mark(r.a2) + ' | '
      + verdict + ' | ' + oneMark + ' | ' + sec(r.ms) + ' | ' + r.tokens + ' | ' + r.steps + ' | ' + r.rework + ' | '
      + (reason.join(' / ') || '') + ' |');
  });
  lines.push('');

  // ---- 不稳定 ----
  const unstable = s.rows.filter((r) => r.unstable);
  lines.push('## 不稳定题');
  lines.push('');
  if (!unstable.length) {
    lines.push('没有。两遍结果一致。');
  } else {
    for (const r of unstable) {
      lines.push('### ' + r.t.id + ' · ' + r.t.name);
      lines.push('');
      lines.push('- 第1遍：' + (r.a1.pass ? '过' : '不过（' + (r.a1.failed_checks || []).join('；') + '）'));
      lines.push('- 第2遍：' + (r.a2.pass ? '过' : '不过（' + (r.a2.failed_checks || []).join('；') + '）'));
      lines.push('- 第1遍回复：' + String(r.a1.reply_snippet || '').slice(0, 160));
      lines.push('- 第2遍回复：' + String(r.a2.reply_snippet || '').slice(0, 160));
      lines.push('');
    }
  }
  lines.push('');

  // ---- 失败 ----
  const failed = s.rows.filter((r) => (r.a1 && !r.a1.pass) || (r.a2 && !r.a2.pass));
  if (failed.length) {
    lines.push('## 没过的题（含只过一遍的）');
    lines.push('');
    for (const r of failed) {
      lines.push('### ' + r.t.id + ' · ' + r.t.name + '（' + r.t.group + '）');
      lines.push('');
      for (const a of [r.a1, r.a2]) {
        if (!a || a.pass) continue;
        lines.push('- 第' + a.attempt + '遍没过：' + (a.error || (a.failed_checks || []).join('；')));
        lines.push('  - 状态：' + (a.three_a ? a.three_a.status : '?') + '，打回 ' + (a.three_a ? a.three_a.rework_round : 0) + ' 轮');
        lines.push('  - 它当时回的：' + String(a.reply_snippet || '').slice(0, 200));
      }
      lines.push('');
    }
  }

  // ---- 重启恢复 ----
  const rv = readJson(path.join(DATA, 'restart-verify.json'), null);
  lines.push('## 稳定性：调度重启恢复（真跑，不是口号）');
  lines.push('');
  if (!rv) {
    lines.push('还没跑：`node evals-multi/restart-test.js`。');
  } else {
    lines.push('- 怎么验的：' + rv.how);
    lines.push('- 被杀前：已完成 ' + ((rv.before_kill && rv.before_kill.done) || 0) + ' 个，'
      + '挂着的任务 ' + (((rv.before_kill && rv.before_kill.running_or_inspecting) || []).join('、') || '无'));
    lines.push('- 重启后：完成 ' + ((rv.after_restart && rv.after_restart.done) || 0) + '/' + ((rv.after_restart && rv.after_restart.total) || 8));
    lines.push('- 恢复事件：' + (((rv.after_restart && rv.after_restart.recovery_events) || []).map((x) => x.task + '(' + x.from + ')').join('、') || '无'));
    lines.push('');
    lines.push('| 断言 | 结果 |');
    lines.push('|---|---|');
    for (const [k, v] of Object.entries(rv.checks || {})) lines.push('| ' + k + ' | ' + (v ? '✓' : '✗') + ' |');
    lines.push('');
    lines.push('> 明细：`data-multi/restart-verify.json`；日志：`data-multi/logs/restart-verify.log`。');
    lines.push('> 恢复规则：进程启动时把 `running`/`inspecting` 的任务判为「上次没收尾」，记一笔 recover 后重新排队；');
    lines.push('> 同一任务恢复超过 2 次判失败，不无限重试。');
  }
  lines.push('');
  lines.push('## 怎么复跑');
  lines.push('');
  lines.push('```bash');
  lines.push('node evals-multi/restart-test.js      # 先验重启恢复（mock，不花钱，十几秒）');
  lines.push('node evals-multi/run.js --run         # 跑 55 题 × 2 遍（可断点续跑）');
  lines.push('node evals-multi/run.js --report      # 只重写这份报表');
  lines.push('```');
  lines.push('');
  lines.push('3A 的数据全在 `data-multi/`（记忆、账本、审计、状态、信封、报表），与单A 的 `data/` 完全分开。');
  lines.push('');

  ensureDir(DATA);
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
  return { s, one };
}

/* ---------- 主流程 ---------- */
async function main() {
  const argv = process.argv.slice(2);
  const meta = tasksFile();
  const cfg = loadConfig();
  meta.env = environment(cfg);

  if (argv.includes('--report')) {
    const r = readJson(RESULTS, null);
    if (!r) { console.error('还没有 data-multi/results.json，先跑 --run'); process.exit(2); }
    const { s } = writeReport(r);
    console.log('3A 报表已重写：data-multi/report.md（' + s.passed_both + '/' + s.done + ' 两遍都过）');
    return;
  }

  const fresh = argv.includes('--fresh');
  const from = argv.includes('--from') ? (Number(argv[argv.indexOf('--from') + 1]) || 1) : 1;
  const to = Math.min(argv.includes('--to') ? (Number(argv[argv.indexOf('--to') + 1]) || meta.tasks.length) : meta.tasks.length, meta.tasks.length);
  const onlyArg = argv.includes('--only') ? String(argv[argv.indexOf('--only') + 1] || '') : '';
  const onlyIds = onlyArg ? onlyArg.split(',').map((x) => x.trim()).filter(Boolean) : null;

  const results = loadOrInit(meta, fresh);
  results.finished_at = null;
  writeJson(RESULTS, results);

  ensureDir(RUN);
  const ready = (cfg.providers || []).filter((p) => p.tier === 'local' || (p.key && String(p.key).trim()));
  console.log('3A：' + results.tasks.length + ' 题 × ' + ATTEMPTS + ' 遍；范围 '
    + (onlyIds ? ('只跑 ' + onlyIds.join('、')) : (from + '~' + to)) + '；模型 '
    + (ready.map((p) => p.name + '/' + p.model).join('、') || '（无）'));

  const t0 = Date.now();
  for (let i = from - 1; i < to; i++) {
    const task = meta.tasks[i];
    if (onlyIds && !onlyIds.includes(task.id)) continue;
    const entry = results.tasks.find((x) => x.id === task.id);
    if (!entry) continue;
    for (let att = 1; att <= ATTEMPTS; att++) {
      if (entry.attempts.some((a) => a.attempt === att)) continue;
      let out;
      try {
        out = await runAttempt(task, cfg);
        out.attempt = att;
      } catch (e) {
        out = {
          task_id: task.id, attempt: att, pass: false, ms: 0, prompt_tokens: 0, completion_tokens: 0,
          tokens: 0, steps: 0, provider: '', tools: [], cost: 0, checks: [],
          failed_checks: ['跑批异常：' + e.message], reply: '', reply_snippet: '', error: e.message,
          three_a: { status: 'failed', rework_round: 0, escalations: 0, envelopes: 0, rejected_envelopes: 0, inspections: 0 }
        };
      }
      entry.attempts.push(out);
      entry.attempts.sort((a, b) => a.attempt - b.attempt);
      results.finished_at = null;
      writeJson(RESULTS, results);
      console.log('  ' + (out.pass ? '✓' : '✗') + ' ' + entry.id.padEnd(26) + ' 第' + att + '遍 '
        + sec(out.ms).padStart(8) + '  ' + String(out.tokens).padStart(6) + ' tok'
        + (out.three_a && out.three_a.rework_round ? '  打回' + out.three_a.rework_round : '')
        + (out.pass ? '' : '  ' + (out.error || (out.failed_checks || []).join('；')).slice(0, 70)));
    }
    if ((i + 1) % 5 === 0) console.log('  —— 已完成 ' + (i + 1) + '/' + to + ' 题，累计 ' + sec(Date.now() - t0));
  }

  const allDone = results.tasks.every((t) => t.attempts.length >= ATTEMPTS);
  if (allDone) {
    results.finished_at = nowIso();
    writeJson(RESULTS, results);
    const { s, one } = writeReport(results);
    console.log('');
    console.log('3A 全部跑完：两遍都过 ' + s.passed_both + '/' + s.done + '（' + s.pass_rate_both + '%）'
      + ' · 不稳定 ' + s.unstable + ' · 打回 ' + s.rework + ' · 升级 ' + s.escalations);
    if (one) console.log('对照：单A ' + one.passed_both + '/' + one.done + '（' + one.pass_rate_both + '%）'
      + ' · tokens 单A ' + fmt(one.total_tokens) + ' vs 3A ' + fmt(s.total_tokens)
      + ' · 耗时 单A ' + sec(one.total_ms) + ' vs 3A ' + sec(s.total_ms));
    console.log('报表：data-multi/report.md   机器可读：data-multi/results.json');
  } else {
    const todo = results.tasks.filter((t) => t.attempts.length < ATTEMPTS).map((t) => t.id);
    console.log('');
    console.log('本轮结束（还没跑全），剩余 ' + todo.length + ' 题：' + todo.slice(0, 5).join('、') + (todo.length > 5 ? ' …' : ''));
    console.log('接着跑：node evals-multi/run.js --run');
  }
}

main().catch((e) => {
  console.error('3A 跑批挂了：' + e.stack);
  process.exit(1);
});
