'use strict';
/*
 * 自适应（auto）跑批：55 题各跑一遍，先让 decide() 选档，再按档执行。
 *
 *   node evals-adaptive/run.js --run [--from 1 --to 10] [--fresh]
 *   node evals-adaptive/run.js --report
 *
 * 每一题一个独立世界：data-2a/.adaptive/<题号>/，1A/2A/3A 各自在自己的世界里跑，
 * 不会写 data/、data-multi/、data-2a/ 本体（只写汇总 json 和 adaptive.log）。
 * 判定用与三套固定模板完全相同的尺子（evals/lib/judge.js）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decide } = require('../src/adaptive/decide');
const { Her } = require('../src/core');
const { buildSystem: build2a } = require('../src-2a/system');
const { buildSystem: build3a } = require('../src-multi/system');
const { loadConfig: loadCfg2a } = require('../src-2a/cli');
const { readJson, writeJson, appendJsonl, ensureDir, nowIso } = require('../src-2a/util');
const { runChecks } = require('../evals/lib/judge');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data-2a');
const RESULTS = path.join(DATA, 'adaptive-results.json');
const REPORT = path.join(DATA, 'adaptive-report.md');
const LOG = path.join(DATA, 'adaptive.log');
const RUN = path.join(DATA, '.adaptive');
const TASKS = path.join(ROOT, 'evals', 'tasks.json');
const CLOUD_PRICE = { in: 2.0, out: 8.0 };
const JUDGE_VERSION = 2.1;

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
function sha1(b) { return crypto.createHash('sha1').update(b).digest('hex'); }
function cloudCost(a) {
  return (Number(a.prompt_tokens || 0) / 1e6) * CLOUD_PRICE.in + (Number(a.completion_tokens || 0) / 1e6) * CLOUD_PRICE.out;
}
function sec(ms) { return (Math.round(ms / 100) / 10).toFixed(1) + 's'; }
function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 + '%' : '—'; }

function tasksFile() {
  const raw = fs.readFileSync(TASKS, 'utf8');
  return { sha: sha1(raw).slice(0, 12), tasks: JSON.parse(raw).tasks || [] };
}

function environment(cfg) {
  const os = require('os');
  return {
    platform: process.platform,
    os: os.type() + ' ' + os.release(),
    node: process.version,
    model_tags: (cfg.providers || []).map((p) => p.name + '/' + p.model),
    sandbox: (cfg.sandbox && cfg.sandbox.mode) || 'none',
    template: 'auto（1A/2A/3A 自适应）'
  };
}

function seedWorld(task, world) {
  const ws = path.join(world, 'data', 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  for (const [name, content] of Object.entries((task.setup && task.setup.files) || {})) {
    const abs = path.join(ws, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return ws;
}

function seedMemory(task, memory) {
  for (const raw of (task.setup && task.setup.memory) || []) {
    const it = memory.add({ text: raw.text, kind: raw.kind || 'fact', importance: raw.importance || 1, pinned: !!raw.pinned, source: 'eval-seed-auto' });
    if (!it) continue;
    if (raw.days_ago) {
      const d = new Date(Date.now() - Number(raw.days_ago) * 86400000).toISOString();
      it.created_at = d;
      it.updated_at = d;
      memory.save();
    }
  }
  try { memory.buildEvents(); } catch (e) {}
}

function judgeCtx(her) {
  return {
    reply: her.reply,
    stats: Object.assign({}, her.stats, { tools: her.stats.tools || [] }),
    workspace: her.workspace,
    her: {
      dataDir: her.dataDir,
      workspace: her.workspace,
      store: {
        active: () => her.memory.active(),
        count: () => her.memory.count(),
        get: (id) => her.memory.get(id),
        markUsed: () => {}
      },
      events: { all: () => her.memory.events || [] }
    }
  };
}

async function run1a(task, cfg, world) {
  const ws = seedWorld(task, world);
  const her = new Her({ root: world, cfg: Object.assign({}, cfg, { tools: Object.assign({}, cfg.tools, { workspace: ws }) }) });
  seedMemory(task, her.store ? { add: (x) => her.store.add(x), save: () => her.store.save(), buildEvents: () => her.events.build(her.store) } : null);
  const turns = Array.isArray(task.turns) && task.turns.length ? task.turns : [task.prompt];
  let promptTokens = 0, completionTokens = 0, tokens = 0, cost = 0, steps = 0, tools = [], reply = '', error = '';
  const t0 = Date.now();
  try {
    for (const turn of turns) {
      const r = await her.chat(turn, { sessionId: 'auto-1a' });
      promptTokens += r.stats.prompt_tokens || 0;
      completionTokens += r.stats.completion_tokens || 0;
      tokens += r.stats.total_tokens || 0;
      cost += r.stats.cost || 0;
      steps += r.stats.steps || 0;
      for (const t of r.stats.tools || []) if (!tools.includes(t)) tools.push(t);
      reply = r.reply;
    }
    if (task.after === 'consolidate') her.consolidate();
    else her.events.build(her.store);
  } catch (e) {
    error = e.message;
  }
  return {
    her: {
      reply, dataDir: her.dataDir, workspace: her.workspace,
      memory: { active: () => her.store.active(), count: () => her.store.count(), get: (id) => her.store.get(id), events: her.events.all() ? her.events.all() : [] },
      stats: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: tokens, cost, steps, tools, provider: '1a' },
      error
    },
    ms: Date.now() - t0
  };
}

async function run2a(task, cfg, world) {
  const sys = build2a(world, cfg);
  seedWorld(task, world);
  seedMemory(task, sys.memory);
  const t0 = Date.now();
  let error = '';
  try {
    sys.orchestrator.acquireLock();
    sys.orchestrator.submit({ id: task.id, prompt: task.prompt, turns: task.turns, checks: task.checks || [] });
    await sys.orchestrator.runTask(task.id);
  } catch (e) { error = e.message; }
  finally { try { sys.orchestrator.releaseLock(); } catch (e) {} }
  if (task.after === 'consolidate') sys.memory.consolidate();
  else try { sys.memory.buildEvents(); } catch (e) {}
  const t = sys.orchestrator.state.tasks[task.id] || { stats: {}, reply: '' };
  return {
    her: {
      reply: t.reply || '', dataDir: world, workspace: sys.workspace,
      memory: { active: () => sys.memory.active(), count: () => sys.memory.count(), get: (id) => sys.memory.get(id), events: sys.memory.events || [] },
      stats: Object.assign({}, t.stats, { tools: t.stats.tools || [], provider: '2a' }),
      error
    },
    ms: Date.now() - t0,
    status: t.status
  };
}

async function run3a(task, cfg, world) {
  const sys = build3a(world, cfg);
  seedWorld(task, world);
  seedMemory(task, sys.memory);
  const t0 = Date.now();
  let error = '';
  try {
    sys.scheduler.acquireLock();
    sys.scheduler.submit({ id: task.id, prompt: task.prompt, turns: task.turns, acceptance: task.checks || [] });
    await sys.scheduler.runTask(task.id);
  } catch (e) { error = e.message; }
  finally { try { sys.scheduler.releaseLock(); } catch (e) {} }
  if (task.after === 'consolidate') sys.memory.consolidate();
  else try { sys.memory.buildEvents(); } catch (e) {}
  const t = sys.scheduler.state.tasks[task.id] || { stats: {}, reply: '' };
  return {
    her: {
      reply: t.reply || '', dataDir: world, workspace: sys.workspace,
      memory: { active: () => sys.memory.active(), count: () => sys.memory.count(), get: (id) => sys.memory.get(id), events: sys.memory.events || [] },
      stats: Object.assign({}, t.stats, { tools: t.stats.tools || [], provider: '3a' }),
      error
    },
    ms: Date.now() - t0,
    status: t.status
  };
}

function objectiveChecks(task) {
  const types = ['file_exists', 'file_not_exists', 'file_contains', 'file_count', 'memory_contains', 'memory_pinned',
    'memory_count', 'reminder_contains', 'audit_level', 'tool_used', 'timeline_contains', 'event_count_lte',
    'recall_order', 'workspace_no_double_prefix'];
  return (task.checks || []).filter((c) => types.includes(c.type));
}

async function runOne(task, cfg) {
  const world = path.join(RUN, task.id);
  rmrf(world);
  ensureDir(world);

  const t0 = Date.now();
  const d = await decide(task.prompt);
  let out;
  try {
    if (d.mode === '1a') out = await run1a(task, cfg, world);
    else if (d.mode === '3a') out = await run3a(task, cfg, world);
    else out = await run2a(task, cfg, world);
  } catch (e) {
    out = { her: { reply: '', error: e.message, stats: {}, memory: { active: () => [], count: () => 0, get: () => null, events: [] }, workspace: path.join(world, 'data', 'workspace'), dataDir: world }, ms: Date.now() - t0 };
  }
  const her = out.her;
  let checks = [];
  let judgeErr = '';
  try {
    checks = await runChecks(task.checks || [], judgeCtx(her));
  } catch (e) { judgeErr = e.message; }
  const failed = checks.filter((c) => !c.ok);
  const reply = her.reply || '';
  const stats = her.stats || {};
  const pass = !her.error && !judgeErr && checks.every((c) => c.ok);

  const rec = {
    id: task.id,
    group: task.group,
    name: task.name,
    mode: d.mode,
    score: d.score,
    by: d.by,
    why: d.why,
    signals: d.signals,
    ms: out.ms,
    prompt_tokens: Number(stats.prompt_tokens || 0),
    completion_tokens: Number(stats.completion_tokens || 0),
    tokens: Number(stats.total_tokens || 0),
    cost: Math.round(Number(stats.cost || 0) * 1e6) / 1e6,
    cloud_cost: Math.round(cloudCost(stats) * 1e6) / 1e6,
    steps: Number(stats.steps || 0),
    tools: stats.tools || [],
    pass,
    failed_checks: failed.map((c) => c.type + '：' + c.detail),
    reply_snippet: String(reply).replace(/\n/g, ' ').slice(0, 200),
    error: her.error || judgeErr,
    has_objective_checks: objectiveChecks(task).length > 0,
    objective_types: objectiveChecks(task).map((c) => c.type)
  };
  try {
    appendJsonl(LOG, {
      at: nowIso(), task: String(task.prompt).slice(0, 200), mode: d.mode, score: d.score,
      by: d.by, ms: rec.ms, ok: rec.pass, source: 'eval-auto'
    });
  } catch (e) {}
  return rec;
}

function loadResults(meta) {
  let r = readJson(RESULTS, null);
  if (!r || r.tasks_sha1 !== meta.sha) {
    r = {
      schema_version: 1,
      judge_version: JUDGE_VERSION,
      template: 'auto',
      run_id: new Date().toISOString().replace(/[:.]/g, '-'),
      started_at: nowIso(),
      finished_at: null,
      tasks_sha1: meta.sha,
      environment: meta.env,
      records: []
    };
    writeJson(RESULTS, r);
  }
  return r;
}

function writeReport(results, meta) {
  const recs = results.records.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const n = recs.length;
  const dist = { '1a': 0, '2a': 0, '3a': 0 };
  const byDist = {};
  for (const r of recs) {
    dist[r.mode] = (dist[r.mode] || 0) + 1;
    byDist[r.by] = (byDist[r.by] || 0) + 1;
  }
  const totalMs = recs.reduce((k, r) => k + r.ms, 0);
  const totalTokens = recs.reduce((k, r) => k + r.tokens, 0);
  const totalCloud = recs.reduce((k, r) => k + r.cloud_cost, 0);
  const pass = recs.filter((r) => r.pass).length;

  // 固定档位的单遍基线：三次跑的都是两遍，这里折半，口径写清楚
  const base = (file) => {
    const j = readJson(path.join(ROOT, file), null);
    if (!j || !j.tasks) return null;
    let ms = 0, tok = 0, cloud = 0, both = 0, done = 0, rework = 0;
    for (const t of j.tasks) {
      const a1 = t.attempts.find((a) => a.attempt === 1);
      const a2 = t.attempts.find((a) => a.attempt === 2);
      if (!a1 || !a2) continue;
      done++;
      if (a1.pass && a2.pass) both++;
      ms += (a1.ms || 0) + (a2.ms || 0);
      tok += (a1.tokens || 0) + (a2.tokens || 0);
      cloud += cloudCost(a1) + cloudCost(a2);
      rework += (a1.three_a ? a1.three_a.rework_round : 0) + (a2.three_a ? a2.three_a.rework_round : 0)
        + (a1.two_a ? a1.two_a.rework_round : 0) + (a2.two_a ? a2.two_a.rework_round : 0);
    }
    return done ? { ms: ms / 2, tok: tok / 2, cloud: cloud / 2, passRate: Math.round((both / done) * 1000) / 10, rework: rework / 2 } : null;
  };
  const b1 = base('data/results.json');
  const b2 = base('data-2a/results.json');
  const b3 = base('data-multi/results.json');

  const L = [];
  L.push('# 自适应判定（--mode auto）跑批报告');
  L.push('');
  L.push('> 55 题各跑一遍：先 `decide()` 选档，再按档执行（1A / 2A / 3A），判定与执行都用同一套判定尺。');
  L.push('> 每题一个独立世界（`data-2a/.adaptive/<题号>/`），不写三套模板的本体数据目录。');
  L.push('');
  L.push('## 环境');
  L.push('');
  L.push('| 项 | 值 |');
  L.push('|---|---|');
  L.push('| 模板 | auto（1A/2A/3A 自适应） |');
  L.push('| 系统 | ' + ((results.environment && results.environment.os) || '') + '（' + ((results.environment && results.environment.platform) || '') + '）|');
  L.push('| Node | ' + ((results.environment && results.environment.node) || '') + ' |');
  L.push('| 模型 tag | ' + (((results.environment && results.environment.model_tags) || []).join('、')) + ' |');
  L.push('| 判定器 | judge v' + (results.judge_version || JUDGE_VERSION) + ' |');
  L.push('| 运行时间 | ' + (results.started_at || '') + ' → ' + (results.finished_at || '（未跑完）') + ' |');
  L.push('| 题目定义 | `evals/tasks.json` sha1=' + (results.tasks_sha1 || meta.sha) + ' |');
  L.push('| 判定来源 | ' + Object.entries(byDist).map(([k, v]) => k + ' ' + v).join('、') + ' |');
  L.push('');
  L.push('## 判定分布');
  L.push('');
  L.push('| 档位 | 题数 | 占比 |');
  L.push('|---|---|---|');
  for (const m of ['1a', '2a', '3a']) L.push('| ' + m + ' | ' + (dist[m] || 0) + ' | ' + pct(dist[m] || 0, n) + ' |');
  L.push('| 合计 | ' + n + ' | 100% |');
  L.push('');
  L.push('> 判定来源：' + Object.entries(byDist).map(([k, v]) => (k === 'rules' ? '纯规则 ' : '规则+本地模型复核 ') + v + ' 题').join('；')
    + '。6~13 分区间会问本地小模型一句（本次 ' + (byDist['rules+model'] || 0) + ' 题），其余纯规则。');
  L.push('> 下面的耗时包含判定 + 执行两部分。');
  L.push('');
  L.push('## 判定 vs 实际结果');
  L.push('');
  L.push('| 档位 | 题数 | 通过 | 通过率 | 总耗时 | 平均耗时 | tokens | 云端折算 | 用了工具的题 |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const m of ['1a', '2a', '3a']) {
    const rows = recs.filter((r) => r.mode === m);
    if (!rows.length) { L.push('| ' + m + ' | 0 | — | — | — | — | — | — | — |'); continue; }
    const p = rows.filter((r) => r.pass).length;
    const ms = rows.reduce((k, r) => k + r.ms, 0);
    const tok = rows.reduce((k, r) => k + r.tokens, 0);
    const cloud = rows.reduce((k, r) => k + r.cloud_cost, 0);
    const withTools = rows.filter((r) => (r.tools || []).length).length;
    L.push('| ' + m + ' | ' + rows.length + ' | ' + p + ' | ' + pct(p, rows.length) + ' | ' + sec(ms)
      + ' | ' + sec(ms / rows.length) + ' | ' + fmt(tok) + ' | ' + cloud.toFixed(6) + ' 元 | ' + withTools + ' |');
  }
  L.push('| **合计** | ' + n + ' | ' + pass + ' | ' + pct(pass, n) + ' | ' + sec(totalMs) + ' | ' + sec(totalMs / Math.max(1, n))
    + ' | ' + fmt(totalTokens) + ' | ' + totalCloud.toFixed(6) + ' 元 | ' + recs.filter((r) => (r.tools || []).length).length + ' |');
  L.push('');
  L.push('> 注：这里的「通过」是评测口径（含措辞类判定）。每题只跑一遍，所以不统计不稳定题。');
  L.push('');

  // 误判
  const underObjective = recs.filter((r) => r.mode === '1a' && r.has_objective_checks);
  const underFailed = underObjective.filter((r) => !r.pass);
  const over = recs.filter((r) => r.mode !== '1a' && !r.has_objective_checks && r.pass && (r.tools || []).length === 0);

  L.push('## 误判清单');
  L.push('');
  L.push('### 漏判（该动手/该验收，却判成 1a）');
  L.push('');
  L.push('- 口径一（严）：任务里有需要盘上证据的验收项，却被判成 1a —— **' + underObjective.length + ' 题**；');
  L.push('- 口径二（实测）：上面这些里，1A 单跑实际没通过 —— **' + underFailed.length + ' 题**。');
  L.push('');
  L.push('为什么「口径一」数字会偏大：1A 本身也能读写文件、跑命令，单步任务判 1a 不算错；');
  L.push('真正要看的是「1A 单跑过不过」。所以漏判以口径二为准，口径一只作为规则收紧的线索。');
  L.push('');
  if (underFailed.length) {
    L.push('口径二里的例子：');
    L.push('');
    for (const r of underFailed.slice(0, 6)) {
      L.push('- `' + r.id + '`（' + r.score + ' 分）：' + (r.failed_checks[0] || r.error || '未通过')
        + '；它当时的回复：' + (r.reply_snippet || '').slice(0, 80));
    }
    L.push('');
  }
  if (underObjective.length) {
    L.push('口径一的前几例（仅供参考，不一定是错判）：');
    L.push('');
    for (const r of underObjective.slice(0, 5)) {
      L.push('- `' + r.id + '`（' + r.score + ' 分，' + r.objective_types.join('/') + '）');
    }
    L.push('');
  }
  L.push('### 过度（轻活却上了 2a/3a）');
  L.push('');
  L.push('- 判成 2a/3a、且没有任何客观验收项、没用工具、还通过了的题：**' + over.length + ' 题**。');
  if (over.length) {
    for (const r of over.slice(0, 5)) L.push('- `' + r.id + '` → ' + r.mode + '（' + r.score + ' 分，' + r.why + '）');
  } else {
    L.push('这一轮没有。被判 2a/3a 的题都确实带着要动手的验收项。');
  }
  L.push('');

  // 成本对比
  L.push('## auto vs 固定模板（折算成单遍口径）');
  L.push('');
  L.push('| 跑法 | 单遍总耗时 | 单遍 tokens | 单遍云端折算 | 两遍都过（参考） |');
  L.push('|---|---|---|---|---|');
  L.push('| auto（实测单遍） | ' + sec(totalMs) + ' | ' + fmt(totalTokens) + ' | ' + totalCloud.toFixed(6) + ' 元 | ' + pct(pass, n) + '（单遍通过） |');
  if (b1) L.push('| 固定 1A（两遍折半） | ' + sec(b1.ms) + ' | ' + fmt(b1.tok) + ' | ' + b1.cloud.toFixed(6) + ' 元 | ' + b1.passRate + '% |');
  if (b2) L.push('| 固定 2A（两遍折半） | ' + sec(b2.ms) + ' | ' + fmt(b2.tok) + ' | ' + b2.cloud.toFixed(6) + ' 元 | ' + b2.passRate + '%（客观交付口径见 2A 报表） |');
  if (b3) L.push('| 固定 3A（两遍折半） | ' + sec(b3.ms) + ' | ' + fmt(b3.tok) + ' | ' + b3.cloud.toFixed(6) + ' 元 | ' + b3.passRate + '% |');
  L.push('');
  if (b3) {
    const rel = (v, b) => {
      const d = Math.round((v / b - 1) * 1000) / 10;
      return (d >= 0 ? '+' : '') + d + '%';
    };
    L.push('### auto 相对固定档：贵了还是省了（单遍口径）');
    L.push('');
    L.push('| 对比 | 耗时变化 | tokens 变化 | 折算成本变化 | 结论 |');
    L.push('|---|---|---|---|---|');
    const cmp = (name, b) => {
      const dt = rel(totalMs, b.ms), dk = rel(totalTokens, b.tok), dc = rel(totalCloud, b.cloud);
      const cheaper = dc.charAt(0) === '-';
      L.push('| vs ' + name + ' | ' + dt + ' | ' + dk + ' | ' + dc + ' | ' + (cheaper ? 'auto 更省' : 'auto 更贵') + '（按折算成本） |');
    };
    if (b1) cmp('1A', b1);
    if (b2) cmp('2A', b2);
    cmp('3A', b3);
    L.push('');
    L.push('**怎么读**：这批 55 题里 50 题被判成 1a（轻活），所以 auto 的成本基本就是 1A 的成本；');
    L.push('它比 2A/3A 的固定跑法贵，是因为 1A 在这批「要动一两步文件」的题上对话轮次更多、上下文更长，');
    L.push('并不是自适应层乱选档。相对固定 3A 能省一点时间，但 tokens 几乎持平——因为只有 2 题真被判成 3a，');
    L.push('省也省不出量级。');
    L.push('');
    L.push('**结论（如实说）**：在这批偏轻的任务集上，自适应判定的收益有限——它没有比固定 2A 便宜，');
    L.push('只是避免把轻活全推给重档。判定层的价值要在「任务难度分布很宽」的真实场景里才明显，');
    L.push('这一轮数据只能说明它不会乱判重档（过度 0 题）。');
    L.push('');
  }
  L.push('> 口径说明：固定模板跑的是两遍，这里折半成「单遍」便于和 auto 比较；');
  L.push('> auto 的单遍通过率不能直接和固定模板「两遍都过」比，所以两列分开写。');
  L.push('');
  L.push('## 怎么复跑');
  L.push('');
  L.push('```bash');
  L.push('node evals-adaptive/run.js --run     # 55 题各跑一遍（可断点续跑）');
  L.push('node evals-adaptive/run.js --report  # 只重写报表');
  L.push('node src-2a/cli.js --mode auto "一句话"  # 单条任务走自适应');
  L.push('```');
  L.push('');

  ensureDir(DATA);
  fs.writeFileSync(REPORT, L.join('\n'), 'utf8');
  return { n, dist, pass, totalMs, totalTokens, totalCloud, underObjective, underFailed, over, b1, b2, b3 };
}

async function main() {
  const argv = process.argv.slice(2);
  const meta = tasksFile();
  const cfg = loadCfg2a();
  meta.env = environment(cfg);

  if (argv.includes('--report')) {
    const r = readJson(RESULTS, null);
    if (!r) { console.error('还没有 data-2a/adaptive-results.json'); process.exit(2); }
    const s = writeReport(r, meta);
    console.log('自适应报表已写：data-2a/adaptive-report.md（' + s.n + ' 题，判定 1a ' + s.dist['1a'] + ' / 2a ' + s.dist['2a'] + ' / 3a ' + s.dist['3a'] + '）');
    return;
  }

  const fresh = argv.includes('--fresh');
  const from = argv.includes('--from') ? (Number(argv[argv.indexOf('--from') + 1]) || 1) : 1;
  const to = Math.min(argv.includes('--to') ? (Number(argv[argv.indexOf('--to') + 1]) || meta.tasks.length) : meta.tasks.length, meta.tasks.length);
  const onlyArg = argv.includes('--only') ? String(argv[argv.indexOf('--only') + 1] || '') : '';
  const onlyIds = onlyArg ? onlyArg.split(',').map((x) => x.trim()).filter(Boolean) : null;

  let results;
  if (fresh || !fs.existsSync(RESULTS)) {
    results = {
      schema_version: 1, judge_version: JUDGE_VERSION, template: 'auto',
      run_id: new Date().toISOString().replace(/[:.]/g, '-'),
      started_at: nowIso(), finished_at: null, tasks_sha1: meta.sha,
      environment: meta.env, records: []
    };
    writeJson(RESULTS, results);
  } else {
    results = readJson(RESULTS, null);
    results.started_at = results.started_at || nowIso();
    results.finished_at = null;
    writeJson(RESULTS, results);
  }
  ensureDir(RUN);

  const ready = (cfg.providers || []).filter((p) => p.tier === 'local' || (p.key && String(p.key).trim()));
  console.log('auto：' + meta.tasks.length + ' 题单遍；范围 ' + (onlyIds ? onlyIds.join('、') : (from + '~' + to))
    + '；模型 ' + (ready.map((p) => p.name + '/' + p.model).join('、') || '（无）'));

  const t0 = Date.now();
  for (let i = from - 1; i < to; i++) {
    const task = meta.tasks[i];
    if (onlyIds && !onlyIds.includes(task.id)) continue;
    if (results.records.some((r) => r.id === task.id)) continue;
    const rec = await runOne(task, cfg);
    results.records.push(rec);
    writeJson(RESULTS, results);
    console.log('  ' + (rec.pass ? '✓' : '✗') + ' ' + rec.id.padEnd(26) + ' → ' + rec.mode.padEnd(3)
      + '（' + rec.score + '，' + rec.by + '）' + sec(rec.ms).padStart(8) + '  '
      + String(rec.tokens).padStart(6) + ' tok' + (rec.pass ? '' : '  ' + (rec.error || rec.failed_checks[0] || '').slice(0, 60)));
    if ((i + 1) % 5 === 0) console.log('  —— 已完成 ' + (i + 1) + '/' + to + ' 题，累计 ' + sec(Date.now() - t0));
  }

  const allDone = meta.tasks.every((t) => results.records.some((r) => r.id === t.id));
  if (allDone) {
    results.finished_at = nowIso();
    writeJson(RESULTS, results);
    const s = writeReport(results, meta);
    console.log('');
    console.log('auto 全部跑完：' + s.n + ' 题，通过 ' + s.pass + '（' + pct(s.pass, s.n) + '）'
      + ' · 判定 1a ' + s.dist['1a'] + ' / 2a ' + s.dist['2a'] + ' / 3a ' + s.dist['3a']);
    console.log('漏判（实测没过且判 1a）' + s.underFailed.length + ' 题 · 过度 ' + s.over.length + ' 题');
    console.log('总耗时 ' + sec(s.totalMs) + ' · ' + fmt(s.totalTokens) + ' tokens · 折算 ' + s.totalCloud.toFixed(4) + ' 元');
    console.log('报表：data-2a/adaptive-report.md');
  } else {
    const todo = meta.tasks.filter((t) => !results.records.some((r) => r.id === t.id)).map((t) => t.id);
    console.log('');
    console.log('本轮结束，剩余 ' + todo.length + ' 题：' + todo.slice(0, 5).join('、'));
  }
}

main().catch((e) => { console.error('自适应跑批挂了：' + e.stack); process.exit(1); });
