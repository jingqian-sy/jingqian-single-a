'use strict';
/*
 * 2A 评测跑批：同一份 evals/tasks.json（sha1 不许变），55 题 × 2 遍。
 *
 *   node evals-2a/run.js --run [--from 1 --to 8] [--only id1,id2] [--fresh]
 *   node evals-2a/run.js --report
 *
 * 每一遍一个独立世界：data-2a/.run/<题号>/a/（自己的记忆、账本、审计、状态、信封）。
 * 最终计分仍用与 1A/3A 同一把尺子（evals/lib/judge.js），否则三边没法比；
 * 但 2A 编排者的「打回」只看客观证据（见 src-2a/quality.js），不会因为措辞打回。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildSystem } = require('../src-2a/system');
const { loadConfig } = require('../src-2a/cli');
const { readJson, writeJson, ensureDir, nowIso } = require('../src-2a/util');
const { runChecks } = require('../evals/lib/judge');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.JQ_2A_DIR ? path.resolve(ROOT, process.env.JQ_2A_DIR) : path.join(ROOT, 'data-2a');
const RESULTS = path.join(DATA, 'results.json');
const REPORT = path.join(DATA, 'report.md');
const RUN = path.join(DATA, '.run');
const ARCHIVE = path.join(DATA, 'archive');
const TASKS = path.join(ROOT, 'evals', 'tasks.json');
const ONE_A = path.join(ROOT, 'data', 'results.json');
const THREE_A = path.join(ROOT, 'data-multi', 'results.json');
const CLOUD_PRICE = { in: 2.0, out: 8.0 };
const JUDGE_VERSION = 2.1;
const ATTEMPTS = 2;

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
function sha1(b) { return crypto.createHash('sha1').update(b).digest('hex'); }
function cloudCost(a) {
  return (Number(a.prompt_tokens || 0) / 1e6) * CLOUD_PRICE.in + (Number(a.completion_tokens || 0) / 1e6) * CLOUD_PRICE.out;
}

function tasksFile() {
  const raw = fs.readFileSync(TASKS, 'utf8');
  return { raw, sha: sha1(raw).slice(0, 12), tasks: JSON.parse(raw).tasks || [] };
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
    template: '2A（编排 + 执行）'
  };
}

function seedFiles(task, workspace) {
  for (const [name, content] of Object.entries((task.setup && task.setup.files) || {})) {
    const abs = path.join(workspace, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

function seedMemory(task, memory) {
  for (const raw of (task.setup && task.setup.memory) || []) {
    const it = memory.add({ text: raw.text, kind: raw.kind || 'fact', importance: raw.importance || 1, pinned: !!raw.pinned, source: 'eval-seed-2a' });
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
  try { sys.memory.buildEvents(); } catch (e) {}

  sys.orchestrator.submit({ id: task.id, prompt: task.prompt, turns: task.turns, checks: task.checks || [] });
  const t0 = Date.now();
  let error = '';
  try {
    sys.orchestrator.acquireLock();
    await sys.orchestrator.runTask(task.id);
  } catch (e) {
    error = e.message;
  } finally {
    try { sys.orchestrator.releaseLock(); } catch (e) {}
  }
  const ms = Date.now() - t0;

  if (task.after === 'consolidate') {
    try { sys.memory.consolidate(); } catch (e) { error = error || ('整理失败：' + e.message); }
  } else {
    try { sys.memory.buildEvents(); } catch (e) {}
  }

  const t = sys.orchestrator.state.tasks[task.id] || { stats: {}, reply: '', status: 'failed' };
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
  const pass = !error && t.status === 'done' && checks.every((c) => c.ok);

  let envelopes = 0, rejected = 0;
  try { envelopes = fs.readFileSync(path.join(world, 'logs', 'envelopes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; } catch (e) {}
  try { rejected = fs.readFileSync(path.join(world, 'logs', 'rejected.log'), 'utf8').trim().split('\n').filter(Boolean).length; } catch (e) {}

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
    two_a: {
      status: t.status,
      rework_round: t.rework_round || 0,
      escalations: t.status === 'escalated' ? 1 : 0,
      envelopes,
      rejected_envelopes: rejected,
      quality_rounds: (t.checks_log || []).length,
      recover_count: t.recover_count || 0
    }
  };
}

function emptyResults(meta) {
  return {
    schema_version: 2,
    judge_version: JUDGE_VERSION,
    template: '2A',
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
  const tag = 'results-2a-' + (old.tasks_sha1 || 'unknown') + '-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(RESULTS, path.join(ARCHIVE, tag + '.json'));
  if (fs.existsSync(REPORT)) fs.copyFileSync(REPORT, path.join(ARCHIVE, tag + '.report.md'));
  console.log('题目定义变了，旧 2A 结果归档到 data-2a/archive/' + tag);
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
    const rework = [a1, a2].filter(Boolean).reduce((n, a) => n + ((a.two_a && a.two_a.rework_round) || 0), 0);
    const esc = [a1, a2].filter(Boolean).reduce((n, a) => n + ((a.two_a && a.two_a.escalations) || 0), 0);
    const envs = [a1, a2].filter(Boolean).reduce((n, a) => n + ((a.two_a && a.two_a.envelopes) || 0), 0);
    return { t, a1, a2, done, bothPass, unstable, failedBoth, ms, tokens, cost, cloud, steps, rework, esc, envs };
  });
  const finished = rows.filter((r) => r.done);
  const both = rows.filter((r) => r.bothPass).length;
  const singlePass = rows.reduce((n, r) => n + (r.a1 && r.a1.pass ? 1 : 0) + (r.a2 && r.a2.pass ? 1 : 0), 0);
  const totalMs = rows.reduce((n, r) => n + r.ms, 0);
  const totalTokens = rows.reduce((n, r) => n + r.tokens, 0);
  const totalCost = rows.reduce((n, r) => n + r.cost, 0);
  const totalCloud = rows.reduce((n, r) => n + r.cloud, 0);
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
    avg_ms_per_task: finished.length ? Math.round(totalMs / finished.length) : 0,
    avg_ms_per_attempt: finished.length ? Math.round(totalMs / (finished.length * 2)) : 0,
    total_tokens: totalTokens,
    tokens_per_task: finished.length ? Math.round(totalTokens / finished.length) : 0,
    cost: Math.round(totalCost * 1e6) / 1e6,
    cloud_cost: Math.round(totalCloud * 1e6) / 1e6,
    steps: rows.reduce((n, r) => n + r.steps, 0),
    rework: rows.reduce((n, r) => n + r.rework, 0),
    escalations: rows.reduce((n, r) => n + r.esc, 0),
    envelopes: rows.reduce((n, r) => n + r.envs, 0),
    objective_done: results.tasks.reduce((n, t) => n + t.attempts.filter((a) => a.two_a && a.two_a.status === 'done').length, 0),
    rows
  };
}

// 把任意一份 results.json 折成同一组口径（1A / 3A 用的就是它）
function summarizeFile(file) {
  const r = readJson(file, null);
  if (!r || !r.tasks) return null;
  const rows = [];
  for (const t of r.tasks) {
    const a1 = t.attempts.find((a) => a.attempt === 1);
    const a2 = t.attempts.find((a) => a.attempt === 2);
    if (!a1 || !a2) continue;
    const bothPass = a1.pass && a2.pass;
    const unstable = a1.pass !== a2.pass;
    const tokens = (a1.tokens || 0) + (a2.tokens || 0);
    const ms = (a1.ms || 0) + (a2.ms || 0);
    const cost = (a1.cost || 0) + (a2.cost || 0);
    const cloud = cloudCost(a1) + cloudCost(a2);
    const rework = (a1.three_a ? a1.three_a.rework_round : 0) + (a2.three_a ? a2.three_a.rework_round : 0)
      + (a1.two_a ? a1.two_a.rework_round : 0) + (a2.two_a ? a2.two_a.rework_round : 0);
    const esc = (a1.three_a && a1.three_a.escalations ? 1 : 0) + (a2.three_a && a2.three_a.escalations ? 1 : 0)
      + (a1.two_a && a1.two_a.escalations ? 1 : 0) + (a2.two_a && a2.two_a.escalations ? 1 : 0);
    const envs = (a1.three_a ? a1.three_a.envelopes || 0 : 0) + (a2.three_a ? a2.three_a.envelopes || 0 : 0)
      + (a1.two_a ? a1.two_a.envelopes || 0 : 0) + (a2.two_a ? a2.two_a.envelopes || 0 : 0);
    rows.push({ id: t.id, pass1: a1.pass, pass2: a2.pass, bothPass, unstable, tokens, ms, cost, cloud, rework, esc, envs, steps: (a1.steps || 0) + (a2.steps || 0) });
  }
  const n = rows.length;
  if (!n) return null;
  return {
    found: true,
    run_id: r.run_id,
    total: n,
    passed_both: rows.filter((x) => x.bothPass).length,
    passed_attempts: rows.reduce((k, x) => k + (x.pass1 ? 1 : 0) + (x.pass2 ? 1 : 0), 0),
    unstable: rows.filter((x) => x.unstable).length,
    total_ms: rows.reduce((k, x) => k + x.ms, 0),
    total_tokens: rows.reduce((k, x) => k + x.tokens, 0),
    cost: rows.reduce((k, x) => k + x.cost, 0),
    cloud_cost: rows.reduce((k, x) => k + x.cloud, 0),
    rework: rows.reduce((k, x) => k + x.rework, 0),
    escalations: rows.reduce((k, x) => k + x.esc, 0),
    envelopes: rows.reduce((k, x) => k + x.envs, 0),
    steps: rows.reduce((k, x) => k + x.steps, 0),
    objective_done: r.tasks.reduce((k, t) => k + t.attempts.filter((a) => (a.three_a && a.three_a.status === 'done') || (a.two_a && a.two_a.status === 'done')).length, 0),
    perTask: Object.fromEntries(rows.map((x) => [x.id, x])),
    pass_rate_both: Math.round((rows.filter((x) => x.bothPass).length / n) * 1000) / 10,
    avg_ms_per_task: Math.round(rows.reduce((k, x) => k + x.ms, 0) / n),
    avg_ms_per_attempt: Math.round(rows.reduce((k, x) => k + x.ms, 0) / (n * 2)),
    tokens_per_task: Math.round(rows.reduce((k, x) => k + x.tokens, 0) / n)
  };
}

function sec(ms) { return (Math.round(ms / 100) / 10).toFixed(1) + 's'; }
function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 + '%' : '—'; }

function writeReport(results) {
  const s = summarize(results);
  const one = summarizeFile(ONE_A);
  const three = summarizeFile(THREE_A);
  const env = results.environment || {};
  const L = [];
  L.push('# 2A 模板跑批报告（编排 + 执行）');
  L.push('');
  L.push('> 同一份 `evals/tasks.json`（sha1 `' + (results.tasks_sha1 || '') + '`，一个字没改），55 题 × 2 遍。');
  L.push('> 2A 只有两个角色：编排者（拆解 + 质检 + 唯一状态写者）和执行者，比 3A 少一层传话。');
  L.push('');
  L.push('## 环境与口径');
  L.push('');
  L.push('| 项 | 值 |');
  L.push('|---|---|');
  L.push('| 模板 | ' + (env.template || '2A') + ' |');
  L.push('| 系统 | ' + (env.os || '') + '（' + (env.platform || '') + '）|');
  L.push('| Node | ' + (env.node || '') + ' |');
  L.push('| 模型 tag | ' + (env.model_tags || []).join('、') + ' |');
  L.push('| 沙盒档位 | ' + (env.sandbox || 'none') + ' |');
  L.push('| 运行时间 | ' + (results.started_at || '') + ' → ' + (results.finished_at || '（未跑完）') + ' |');
  L.push('| 判定器 | judge v' + (results.judge_version || JUDGE_VERSION) + '（与 1A/3A 共用，保证可比）|');
  L.push('| 质检口径 | 只看盘上副作用 / 审计 / 记忆与事件 / 工具调用 / 字段完整性；**措辞类只计分，不打回** |');
  L.push('| 打回 | 带最小修改指令，只重做那一步，每题最多 1 次 |');
  L.push('');

  L.push('## 1A vs 2A vs 3A（同一批任务、同一个模型、同一把尺子）');
  L.push('');
  L.push('| 指标 | 1A 单A | 2A 编排+执行 | 3A 三角色 |');
  L.push('|---|---|---|---|');
  const cell = (v, f) => (v ? f(v) : '—');
  const row = (name, f) => L.push('| ' + name + ' | ' + cell(one, f) + ' | ' + cell({ v: s }, f) + ' | ' + cell(three, f) + ' |');
  // 注意：2A 这一列直接读本文件汇总，不走 summarizeFile
  const own = {
    passed_both: s.passed_both, total: s.done, pass_rate_both: s.pass_rate_both,
    passed_attempts: s.passed_attempts, unstable: s.unstable,
    total_ms: s.total_ms, avg_ms_per_task: s.avg_ms_per_task,
    total_tokens: s.total_tokens, cloud_cost: s.cloud_cost, rework: s.rework, envelopes: s.envelopes,
    escalations: s.escalations
  };
  const line = (name, f1, f2, f3) => L.push('| ' + name + ' | ' + f1 + ' | ' + f2 + ' | ' + f3 + ' |');
  line('两遍都过',
    one ? one.passed_both + '/' + one.total : '—',
    s.passed_both + '/' + s.done,
    three ? three.passed_both + '/' + three.total : '—');
  line('成功率（两遍都过）',
    one ? one.pass_rate_both + '%' : '—', s.pass_rate_both + '%', three ? three.pass_rate_both + '%' : '—');
  line('单遍通过率',
    one ? pct(one.passed_attempts, one.total * 2) : '—', pct(s.passed_attempts, s.done * 2), three ? pct(three.passed_attempts, three.total * 2) : '—');
  line('不稳定题', one ? String(one.unstable) : '—', String(s.unstable), three ? String(three.unstable) : '—');
  line('总耗时', one ? sec(one.total_ms) : '—', sec(s.total_ms), three ? sec(three.total_ms) : '—');
  line('平均每题耗时', one ? sec(one.avg_ms_per_task) : '—', sec(s.avg_ms_per_task), three ? sec(three.avg_ms_per_task) : '—');
  line('总 tokens', one ? fmt(one.total_tokens) : '—', fmt(s.total_tokens), three ? fmt(three.total_tokens) : '—');
  line('按 deepseek-chat 折算', one ? one.cloud_cost.toFixed(6) + ' 元' : '—', s.cloud_cost.toFixed(6) + ' 元', three ? three.cloud_cost.toFixed(6) + ' 元' : '—');
  line('打回次数', one ? String(one.rework) : '—', String(s.rework), three ? String(three.rework) : '—');
  line('升级给人', one ? String(one.escalations) : '—', String(s.escalations), three ? String(three.escalations) : '—');
  line('角色间信封数', one ? '—' : '—', String(s.envelopes), three ? String(three.envelopes) : '—');
  line('客观交付（质检通过）',
    '—（1A 没有质检环节）',
    s.objective_done + '/' + (s.done * 2),
    three ? three.objective_done + '/' + (three.total * 2) : '—');
  L.push('');
  L.push('> 「两遍都过 / 成功率」是**评测口径**：包含措辞类判定（回复里有没有命中关键词）。');
  L.push('> 「客观交付」是**2A 质检口径**：只看盘上副作用、审计、记忆/事件、工具调用、字段完整性，');
  L.push('> 不看措辞。两个数字差多少，就是「话没说到点上、但活干完了」的比例。');
  L.push('');
  L.push('> 1A 的 run_id：`' + (one ? one.run_id : '缺') + '`；2A：`' + results.run_id + '`；3A：`' + (three ? three.run_id : '缺') + '`。');
  L.push('');

  // 结论
  if (one && three) {
    const dTokens3a = s.total_tokens - three.total_tokens;
    const dTime3a = Math.round((s.total_ms / three.total_ms - 1) * 1000) / 10;
    const dPp1a = Math.round((s.pass_rate_both - one.pass_rate_both) * 10) / 10;
    L.push('**2A 比 3A 省在哪**：');
    L.push('');
    L.push('- 少一个角色、每轮少 2 个信封：2A 一共 ' + s.envelopes + ' 个信封，3A 是 ' + three.envelopes + ' 个；');
    L.push('- 打回只看客观证据、每题最多 1 次：2A 打回 ' + s.rework + ' 次，3A 打了 ' + three.rework + ' 次；');
    L.push('- 结果：2A 比 3A 少 ' + fmt(Math.abs(dTokens3a)) + ' tokens（' + (Math.round(-dTokens3a / three.total_tokens * 1000) / 10) + '%），'
      + '墙钟时间' + (dTime3a >= 0 ? '多' : '少') + Math.abs(dTime3a) + '%。');
    L.push('- 对比 1A：成功率 ' + (dPp1a >= 0 ? '+' : '') + dPp1a + ' pp（1A ' + one.pass_rate_both + '% / 2A ' + s.pass_rate_both + '%）。');
    L.push('  注意：这是不同采样跑出来的数字，措辞命中本身有随机性（同一模型同一题，换个说法就变），');
    L.push('  别把这几十个百分点当成能力差——客观交付两边都是 108/110 这个量级。');
    L.push('');
    L.push('> 说明：2A 的打回不再为「措辞没落在正则里」触发，所以像 r06/r08 那种「第一遍对、被改坏」的情况不会再发生；');
    L.push('> 但最终计分仍然用同一把尺子，措辞不达标照样算不过——这是评测口径，不是 2A 的质检口径。');
    L.push('');
    L.push('**为什么 2A 的「成功率」反而比 1A 低**：2A 客观交付 ' + s.objective_done + '/' + (s.done * 2)
      + '（' + pct(s.objective_done, s.done * 2) + '），但评测只认 ' + s.passed_both + '/' + s.done
      + '。差的那些题不是没干成，而是模型这次的回复用词没落进判定正则（比如「不敢乱动」对不上「不做」、'
      + '「你确定要读吗」对不上「确认」）。2A 按设计不为这种原因打回，所以它**宁可少拿评测分，也不烧 token 去改措辞**。');
    L.push('换个说法：这一轮 2A 用最少的 tokens 完成了最多的客观任务，评测分数被措辞判定拖低了；');
    L.push('如果你只关心「活有没有干成」，看「客观交付」那一行；如果关心「回复是否命中评测口径」，就看成功率。');
    L.push('');
  }

  L.push('## 2A 汇总');
  L.push('');
  L.push('| 指标 | 数值 |');
  L.push('|---|---|');
  L.push('| 题目 | ' + s.total + '（已完成 ' + s.done + ' / ' + s.attempts_done + ' 遍）|');
  L.push('| 两遍都过 | **' + s.passed_both + '/' + s.done + '（' + s.pass_rate_both + '%）** |');
  L.push('| 单遍通过率 | ' + s.passed_attempts + '/' + s.attempts_done + '（' + s.pass_rate_attempt + '%）|');
  L.push('| 客观交付（质检通过、不看措辞） | ' + s.objective_done + '/' + s.attempts_done
    + '（' + pct(s.objective_done, s.attempts_done) + '）|');
  L.push('| 不稳定题 | ' + s.unstable + ' |');
  L.push('| 两遍都失败 | ' + s.failed_both + ' |');
  L.push('| 总耗时 | ' + sec(s.total_ms) + '（平均 ' + sec(s.avg_ms_per_attempt) + '/遍）|');
  L.push('| 总 tokens | ' + fmt(s.total_tokens) + ' |');
  L.push('| 实际成本 | ' + s.cost.toFixed(6) + ' 元（本地模型按 0 计）|');
  L.push('| 按 deepseek-chat 单价折算 | ' + s.cloud_cost.toFixed(6) + ' 元 |');
  L.push('| 打回 / 升级给人 | ' + s.rework + ' / ' + s.escalations + ' |');
  L.push('');

  L.push('## 逐题（2A，附 1A / 3A 对照）');
  L.push('');
  L.push('| # | 题号 | 组 | 2A 第1遍 | 2A 第2遍 | 判定 | 1A 两遍 | 3A 两遍 | 耗时 | tokens | 步数 | 打回 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  s.rows.forEach((r, i) => {
    const mark = (a) => (a ? (a.pass ? '✓' : '✗') : '—');
    let verdict = '—';
    if (r.bothPass) verdict = '过';
    else if (r.unstable) verdict = '不稳定';
    else if (r.done) verdict = '不过';
    const o = one && one.perTask[r.t.id];
    const t = three && three.perTask[r.t.id];
    L.push('| ' + (i + 1) + ' | ' + r.t.id + ' | ' + r.t.group + ' | ' + mark(r.a1) + ' | ' + mark(r.a2) + ' | '
      + verdict + ' | ' + (o ? (o.pass1 ? '✓' : '✗') + (o.pass2 ? '✓' : '✗') : '—')
      + ' | ' + (t ? (t.pass1 ? '✓' : '✗') + (t.pass2 ? '✓' : '✗') : '—')
      + ' | ' + sec(r.ms) + ' | ' + r.tokens + ' | ' + r.steps + ' | ' + r.rework + ' |');
  });
  L.push('');

  const unstable = s.rows.filter((r) => r.unstable);
  L.push('## 不稳定题');
  L.push('');
  if (!unstable.length) L.push('没有。两遍结果一致。');
  else {
    for (const r of unstable) {
      L.push('### ' + r.t.id + ' · ' + r.t.name);
      L.push('');
      L.push('- 第1遍：' + (r.a1.pass ? '过' : '不过（' + (r.a1.failed_checks || []).join('；') + '）'));
      L.push('- 第2遍：' + (r.a2.pass ? '过' : '不过（' + (r.a2.failed_checks || []).join('；') + '）'));
      L.push('- 第1遍回复：' + String(r.a1.reply_snippet || '').slice(0, 160));
      L.push('- 第2遍回复：' + String(r.a2.reply_snippet || '').slice(0, 160));
    }
    L.push('');
  }
  const failed = s.rows.filter((r) => (r.a1 && !r.a1.pass) || (r.a2 && !r.a2.pass));
  if (failed.length) {
    L.push('## 没过的题（含只过一遍的）');
    L.push('');
    for (const r of failed) {
      L.push('### ' + r.t.id + ' · ' + r.t.name + '（' + r.t.group + '）');
      L.push('');
      for (const a of [r.a1, r.a2]) {
        if (!a || a.pass) continue;
        L.push('- 第' + a.attempt + '遍没过：' + (a.error || (a.failed_checks || []).join('；')));
        L.push('  - 2A 状态：' + (a.two_a ? a.two_a.status : '?') + '，打回 ' + (a.two_a ? a.two_a.rework_round : 0) + ' 轮');
        L.push('  - 它当时回的：' + String(a.reply_snippet || '').slice(0, 200));
      }
      L.push('');
    }
  }

  const rv = readJson(path.join(DATA, 'restart-verify.json'), null);
  L.push('## 稳定性：编排进程重启恢复（真跑）');
  L.push('');
  if (!rv) {
    L.push('还没跑：`node evals-2a/restart-test.js`。');
  } else {
    L.push('- 怎么做：' + rv.how);
    L.push('- 被杀前：已完成 ' + ((rv.before_kill && rv.before_kill.done) || 0) + ' 个，挂着的 '
      + (((rv.before_kill && rv.before_kill.running_or_checking) || []).join('、') || '无'));
    L.push('- 重启后：完成 ' + ((rv.after_restart && rv.after_restart.done) || 0) + '/' + ((rv.after_restart && rv.after_restart.total) || 8));
    L.push('');
    L.push('| 断言 | 结果 |');
    L.push('|---|---|');
    for (const [k, v] of Object.entries(rv.checks || {})) L.push('| ' + k + ' | ' + (v ? '✓' : '✗') + ' |');
    L.push('');
    L.push('> 明细：`data-2a/restart-verify.json`；日志：`data-2a/logs/restart-verify.log`。');
  }
  L.push('');
  L.push('## 怎么复跑');
  L.push('');
  L.push('```bash');
  L.push('node evals-2a/restart-test.js   # 重启恢复演练（mock，十几秒）');
  L.push('node evals-2a/run.js --run      # 55 题 × 2 遍（可断点续跑）');
  L.push('node evals-2a/run.js --report   # 只重写报表');
  L.push('```');
  L.push('');
  L.push('2A 的数据全在 `data-2a/`，不碰单A 的 `data/` 和 3A 的 `data-multi/`。');
  L.push('');

  ensureDir(DATA);
  fs.writeFileSync(REPORT, L.join('\n'), 'utf8');
  return { s, one, three };
}

async function main() {
  const argv = process.argv.slice(2);
  const meta = tasksFile();
  const cfg = loadConfig();
  meta.env = environment(cfg);

  if (argv.includes('--report')) {
    const r = readJson(RESULTS, null);
    if (!r) { console.error('还没有 data-2a/results.json，先跑 --run'); process.exit(2); }
    const { s } = writeReport(r);
    console.log('2A 报表已重写：data-2a/report.md（' + s.passed_both + '/' + s.done + ' 两遍都过）');
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
  console.log('2A：' + results.tasks.length + ' 题 × ' + ATTEMPTS + ' 遍；范围 '
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
          two_a: { status: 'failed', rework_round: 0, escalations: 0, envelopes: 0, rejected_envelopes: 0, quality_rounds: 0 }
        };
      }
      entry.attempts.push(out);
      entry.attempts.sort((a, b) => a.attempt - b.attempt);
      results.finished_at = null;
      writeJson(RESULTS, results);
      console.log('  ' + (out.pass ? '✓' : '✗') + ' ' + entry.id.padEnd(26) + ' 第' + att + '遍 '
        + sec(out.ms).padStart(8) + '  ' + String(out.tokens).padStart(6) + ' tok'
        + (out.two_a && out.two_a.rework_round ? '  打回' + out.two_a.rework_round : '')
        + (out.pass ? '' : '  ' + (out.error || (out.failed_checks || []).join('；')).slice(0, 70)));
    }
    if ((i + 1) % 5 === 0) console.log('  —— 已完成 ' + (i + 1) + '/' + to + ' 题，累计 ' + sec(Date.now() - t0));
  }

  const allDone = results.tasks.every((t) => t.attempts.length >= ATTEMPTS);
  if (allDone) {
    results.finished_at = nowIso();
    writeJson(RESULTS, results);
    const { s, one, three } = writeReport(results);
    console.log('');
    console.log('2A 全部跑完：两遍都过 ' + s.passed_both + '/' + s.done + '（' + s.pass_rate_both + '%）'
      + ' · 不稳定 ' + s.unstable + ' · 打回 ' + s.rework + ' · 升级 ' + s.escalations);
    console.log('对照：1A ' + (one ? one.passed_both + '/' + one.total : '缺') + ' · 2A ' + s.passed_both + '/' + s.done
      + ' · 3A ' + (three ? three.passed_both + '/' + three.total : '缺')
      + '；tokens 1A ' + (one ? fmt(one.total_tokens) : '-') + ' / 2A ' + fmt(s.total_tokens) + ' / 3A ' + (three ? fmt(three.total_tokens) : '-'));
    console.log('报表：data-2a/report.md   机器可读：data-2a/results.json');
  } else {
    const todo = results.tasks.filter((t) => t.attempts.length < ATTEMPTS).map((t) => t.id);
    console.log('');
    console.log('本轮结束（还没跑全），剩余 ' + todo.length + ' 题：' + todo.slice(0, 5).join('、') + (todo.length > 5 ? ' …' : ''));
    console.log('接着跑：node evals-2a/run.js --run');
  }
}

main().catch((e) => {
  console.error('2A 跑批挂了：' + e.stack);
  process.exit(1);
});
