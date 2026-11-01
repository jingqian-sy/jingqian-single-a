'use strict';
/*
 * 55 题 × 2 遍 的跑批器。
 *
 *   node evals/run.js --run                跑全部（可断点续跑，中途挂了不会白跑）
 *   node evals/run.js --run --from 1 --to 8  只跑第 1~8 题（给本地慢模型分块用）
 *   node evals/run.js --run --fresh        扔掉旧结果，开新一轮
 *   node evals/run.js --report             只按 data/results.json 重写报表
 *   node evals/run.js --list               看题目清单
 *
 * 数据口径：
 *   - 每题两遍，两遍都过才算「过」；不一致的进「不稳定题」；
 *   - 判定在 evals/lib/judge.js，全是盘上副作用 / 审计日志 / 明确正则，没有模型自评；
 *   - 环境（系统、Node、模型 tag、沙盒档位）和时间写进 results.json 与报表开头；
 *   - tasks.json 一改，旧结果自动归档到 data/archive/，不覆盖、不混淆。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadCfg, runAttempt, environment } = require('./lib/harness');
const { readJson, writeJson, ensureDir } = require('../src/util');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.JQ_DATA_DIR ? path.resolve(ROOT, process.env.JQ_DATA_DIR) : path.join(ROOT, 'data');
const RESULTS = path.join(DATA, 'results.json');
const REPORT = path.join(DATA, 'report.md');
const TASKS = path.join(__dirname, 'tasks.json');
const ARCHIVE = path.join(DATA, 'archive');
const CLOUD_PRICE = { in: 2.0, out: 8.0 }; // 元/百万 token，deepseek-chat 档，仅折算
const JUDGE_VERSION = 2;
const ATTEMPTS = 2;

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

function tasksFile() {
  const raw = fs.readFileSync(TASKS, 'utf8');
  const j = JSON.parse(raw);
  return { raw, sha: sha1(raw).slice(0, 12), tasks: j.tasks || [], schema: j.schema || {} };
}

function cloudCost(stat) {
  return (Number(stat.prompt_tokens || 0) / 1e6) * CLOUD_PRICE.in
    + (Number(stat.completion_tokens || 0) / 1e6) * CLOUD_PRICE.out;
}

function emptyResults(meta) {
  return {
    schema_version: 2,
    judge_version: JUDGE_VERSION,
    run_id: new Date().toISOString().replace(/[:.]/g, '-'),
    started_at: new Date().toISOString(),
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
  if (old.tasks_sha1 === meta.sha) return old; // 同一批题：继续用
  ensureDir(ARCHIVE);
  const tag = 'results-' + (old.tasks_sha1 || 'unknown') + '-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(RESULTS, path.join(ARCHIVE, tag + '.json'));
  if (fs.existsSync(REPORT)) fs.copyFileSync(REPORT, path.join(ARCHIVE, tag + '.report.md'));
  console.log('题目定义变了，旧结果已归档到 data/archive/' + tag + '.*');
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
    const pass1 = a1 ? !!a1.pass : null;
    const pass2 = a2 ? !!a2.pass : null;
    const done = !!(a1 && a2);
    const bothPass = done && pass1 && pass2;
    const unstable = done && pass1 !== pass2;
    const failedBoth = done && !pass1 && !pass2;
    const ms = (a1 ? a1.ms : 0) + (a2 ? a2.ms : 0);
    const tokens = (a1 ? a1.tokens : 0) + (a2 ? a2.tokens : 0);
    const cost = (a1 ? a1.cost : 0) + (a2 ? a2.cost : 0);
    const cloud = (a1 ? cloudCost(a1) : 0) + (a2 ? cloudCost(a2) : 0);
    const steps = Math.max(a1 ? a1.steps : 0, a2 ? a2.steps : 0);
    const provider = (a2 && a2.provider) || (a1 && a1.provider) || '';
    return { t, a1, a2, done, bothPass, unstable, failedBoth, ms, tokens, cost, cloud, steps, provider };
  });
  const finished = rows.filter((r) => r.done);
  const both = rows.filter((r) => r.bothPass).length;
  const single = rows.reduce((n, r) => n + (r.a1 && r.a1.pass ? 1 : 0) + (r.a2 && r.a2.pass ? 1 : 0), 0);
  const attemptsDone = finished.length * 2;
  const totalMs = rows.reduce((n, r) => n + r.ms, 0);
  const totalTokens = rows.reduce((n, r) => n + r.tokens, 0);
  const totalCost = rows.reduce((n, r) => n + r.cost, 0);
  const totalCloud = rows.reduce((n, r) => n + r.cloud, 0);
  const groups = {};
  for (const r of rows) {
    const g = r.t.group || 'other';
    groups[g] = groups[g] || { total: 0, both: 0, attempts: 0, pass: 0 };
    groups[g].total++;
    if (r.bothPass) groups[g].both++;
    for (const a of [r.a1, r.a2]) if (a) { groups[g].attempts++; if (a.pass) groups[g].pass++; }
  }
  return {
    total: rows.length,
    done: finished.length,
    attempts_done: attemptsDone,
    passed_both: both,
    passed_attempts: single,
    unstable: finished.filter((r) => r.unstable).length,
    failed_both: finished.filter((r) => r.failedBoth).length,
    pass_rate_both: finished.length ? Math.round((both / finished.length) * 1000) / 10 : 0,
    pass_rate_attempt: attemptsDone ? Math.round((single / attemptsDone) * 1000) / 10 : 0,
    total_ms: totalMs,
    avg_ms: finished.length ? Math.round(totalMs / (finished.length * 2)) : 0,
    total_tokens: totalTokens,
    cost: Math.round(totalCost * 1e6) / 1e6,
    cloud_cost: Math.round(totalCloud * 1e6) / 1e6,
    groups, rows
  };
}

function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function sec(ms) { return (Math.round(ms / 100) / 10).toFixed(1) + 's'; }

function writeReport(results) {
  const s = summarize(results);
  const env = results.environment || {};
  let whyById = {};
  try {
    const raw = JSON.parse(fs.readFileSync(TASKS, 'utf8'));
    whyById = Object.fromEntries((raw.tasks || []).map((t) => [t.id, t.why || '']));
  } catch (e) { /* 题目文件读不到就留空，不影响报表其它部分 */ }
  const lines = [];
  lines.push('# 跑批报告（单A 雏版 · 55 题 × 2 遍）');
  lines.push('');
  lines.push('> 所有数字都是这台机器上真跑出来的。判定全部走盘上副作用、审计日志或明确正则，没有「模型说自己过了就算过」。');
  lines.push('');
  lines.push('## 环境与口径');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  lines.push('| 系统 | ' + (env.os || '') + '（' + (env.platform || '') + '）|');
  lines.push('| Node | ' + (env.node || '') + ' |');
  lines.push('| 模型 tag | ' + (env.model_tags || []).join('、') + ' |');
  lines.push('| 沙盒档位 | ' + (env.sandbox || 'none') + '（默认 none，直接执行靠红线+白名单）|');
  lines.push('| 路由模式 | ' + (env.route_mode || '') + ' |');
  lines.push('| 单题工具步数上限 | ' + (env.max_steps || '') + ' |');
  lines.push('| 运行时间 | ' + (results.started_at || '') + ' → ' + (results.finished_at || '（未跑完）') + ' |');
  lines.push('| 题目定义 | `evals/tasks.json` sha1=' + (results.tasks_sha1 || '') + ' |');
  lines.push('| 判定器版本 | judge v' + (results.judge_version || JUDGE_VERSION) + ' |');
  if (results.rejudge) {
    lines.push('| 重判说明 | ' + (results.rejudge.note || '') + '（旧结果：`' + (results.rejudge.from || '') + '`）|');
  }
  lines.push('| 跑法 | 每题跑 ' + (results.attempts_per_task || 2) + ' 遍，各自独立状态；两遍都过才算过 |');
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|---|---|');
  lines.push('| 题目 | ' + s.total + ' 题（已完成 ' + s.done + ' 题 / ' + s.attempts_done + ' 遍）|');
  lines.push('| **两遍都过** | **' + s.passed_both + '/' + s.done + '（' + s.pass_rate_both + '%）** |');
  lines.push('| 单遍通过率 | ' + s.passed_attempts + '/' + s.attempts_done + '（' + s.pass_rate_attempt + '%）|');
  lines.push('| 不稳定题（两遍不一致） | ' + s.unstable + ' |');
  lines.push('| 两遍都失败 | ' + s.failed_both + ' |');
  lines.push('| 总耗时 | ' + sec(s.total_ms) + '（平均 ' + sec(s.avg_ms) + '/遍）|');
  lines.push('| 总 tokens | ' + fmt(s.total_tokens) + ' |');
  lines.push('| 实际成本 | ' + s.cost.toFixed(6) + ' 元（本地模型按 0 计）|');
  lines.push('| 按 deepseek-chat 单价折算 | ' + s.cloud_cost.toFixed(6) + ' 元 |');
  lines.push('');
  lines.push('### 分组');
  lines.push('');
  lines.push('| 分组 | 题目 | 两遍都过 | 单遍通过 | 单遍通过率 |');
  lines.push('|---|---|---|---|---|');
  for (const [g, v] of Object.entries(s.groups)) {
    lines.push('| ' + g + ' | ' + v.total + ' | ' + v.both + ' | ' + v.pass + '/' + v.attempts + ' | '
      + (v.attempts ? Math.round((v.pass / v.attempts) * 1000) / 10 : 0) + '% |');
  }
  lines.push('');
  lines.push('## 逐题（两遍都在）');
  lines.push('');
  lines.push('| # | 题号 | 组 | 第1遍 | 第2遍 | 合计判定 | 耗时ms（两遍合计） | tokens | 步数 | 模型 | 实际成本 | 云端折算 | 失败原因 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  s.rows.forEach((r, i) => {
    const mark = (a) => (a ? (a.pass ? '✓' : '✗') : '—');
    let verdict = '—';
    if (r.bothPass) verdict = '过';
    else if (r.unstable) verdict = '不稳定';
    else if (r.done) verdict = '不过';
    const reason = [];
    for (const a of [r.a1, r.a2]) {
      if (a && !a.pass) {
        const why = a.error ? ('报错：' + a.error) : (a.failed_checks || []).join('；');
        reason.push('第' + a.attempt + '遍：' + why);
      }
    }
    lines.push('| ' + (i + 1) + ' | ' + r.t.id + ' | ' + r.t.group + ' | ' + mark(r.a1) + ' | ' + mark(r.a2) + ' | '
      + verdict + ' | ' + r.ms + ' | ' + r.tokens + ' | ' + r.steps + ' | ' + (r.provider || '-') + ' | '
      + r.cost.toFixed(6) + ' | ' + r.cloud.toFixed(6) + ' | ' + (reason.join(' / ') || '') + ' |');
  });
  lines.push('');
  const unstable = s.rows.filter((r) => r.unstable);
  lines.push('## 不稳定题');
  lines.push('');
  if (!unstable.length) {
    lines.push('没有。两遍结果全部一致。');
    lines.push('');
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
  const failed = s.rows.filter((r) => (r.a1 && !r.a1.pass) || (r.a2 && !r.a2.pass));
  if (failed.length) {
    lines.push('## 没过的题（含只过一遍的）');
    lines.push('');
    for (const r of failed) {
      lines.push('### ' + r.t.id + ' · ' + r.t.name + '（' + r.t.group + '）');
      lines.push('');
      lines.push('- 为什么重要：' + (r.t.why || whyById[r.t.id] || ''));
      for (const a of [r.a1, r.a2]) {
        if (!a || a.pass) continue;
        lines.push('- 第' + a.attempt + '遍没过：' + (a.error ? ('报错 ' + a.error) : (a.failed_checks || []).join('；')));
        lines.push('- 它当时回的：' + String(a.reply_snippet || '').slice(0, 200));
      }
      lines.push('');
    }
  }
  lines.push('## 服务验证（真起服务打一发）');
  lines.push('');
  const smoke = readJson(path.join(DATA, 'smoke.json'), null);
  if (smoke && smoke.at) {
    lines.push('- 起服务：`node src/server.js`，端口 ' + smoke.port + '，启动 ' + smoke.start_ms + ' ms');
    lines.push('- 打接口：`POST /api/chat`，往返 ' + smoke.chat_ms + ' ms，' + ((smoke.stats && smoke.stats.total_tokens) || 0) + ' tokens，模型 ' + ((smoke.stats && smoke.stats.provider) || '-'));
    lines.push('- 回复（原样）：' + String(smoke.reply || '').replace(/\n/g, ' '));
    lines.push('- 结果：' + (smoke.ok ? '通过' : '失败（' + smoke.error + '）'));
    lines.push('');
    lines.push('> 记录时间 ' + smoke.at + '，由 `node evals/smoke.js` 自动生成（自己起、自己打、自己关）。');
  } else {
    lines.push('还没跑服务验证：`node evals/smoke.js` 后再重写报表即可带上。');
  }
  lines.push('');
  lines.push('## 怎么复跑');
  lines.push('');
  lines.push('```bash');
  lines.push('node evals/smoke.js            # 先确认服务能起、能打一发');
  lines.push('node evals/run.js --run        # 跑全部（断点续跑，中途挂了接着跑）');
  lines.push('node evals/run.js --run --from 1 --to 8   # 本地慢模型可以分块跑');
  lines.push('node evals/run.js --report     # 只按 results.json 重写这份报表');
  lines.push('```');
  lines.push('');
  lines.push('机器可读的同一份成绩在 `data/results.json`；题目与判定标准在 `evals/tasks.json`，3A 模板可以原样复用。');
  lines.push('题目/判定改过的历史版本在 `data/archive/`，变更说明见 `docs/评测变更说明.md`。');
  lines.push('');

  ensureDir(DATA);
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
  return s;
}

async function main() {
  const argv = process.argv.slice(2);
  const meta = tasksFile();
  meta.env = environment(loadCfg());

  if (argv.includes('--list')) {
    meta.tasks.forEach((t, i) => console.log(String(i + 1).padStart(2) + '. ' + t.id + '  [' + t.group + '] ' + t.name));
    return;
  }

  if (argv.includes('--report')) {
    const r = readJson(RESULTS, null);
    if (!r) { console.error('还没有 data/results.json，先跑 --run'); process.exit(2); }
    const s = writeReport(r);
    console.log('报表已重写：data/report.md（' + s.passed_both + '/' + s.done + ' 两遍都过）');
    return;
  }

  const from = argv.includes('--from') ? (Number(argv[argv.indexOf('--from') + 1]) || 1) : 1;
  const toArg = argv.includes('--to') ? Number(argv[argv.indexOf('--to') + 1]) : meta.tasks.length;
  const to = Math.min(toArg || meta.tasks.length, meta.tasks.length);
  const fresh = argv.includes('--fresh');
  // --only m01,t02：只跑指定题号（CI 用 mock provider 跑子集）
  const onlyArg = argv.includes('--only') ? String(argv[argv.indexOf('--only') + 1] || '') : '';
  const onlyIds = onlyArg ? onlyArg.split(',').map((x) => x.trim()).filter(Boolean) : null;

  const cfg = loadCfg();
  const results = loadOrInit(meta, fresh);
  results.finished_at = null;
  writeJson(RESULTS, results);

  const ready = cfg.providers.filter((p) => (p.tier === 'local' || (p.key && p.key.trim()))).map((p) => p.name + '/' + p.model);
  console.log('跑 ' + results.tasks.length + ' 题 × ' + ATTEMPTS + ' 遍；本次范围 '
    + (onlyIds ? ('只跑 ' + onlyIds.join('、')) : (from + '~' + to)) + '；模型 ' + (ready.join('、') || '（无）'));
  const t0 = Date.now();
  for (let i = from - 1; i < to; i++) {
    const task = meta.tasks[i];
    if (onlyIds && !onlyIds.includes(task.id)) continue;
    const entry = results.tasks.find((x) => x.id === task.id);
    if (!entry) continue;
    for (let att = 1; att <= ATTEMPTS; att++) {
      if (entry.attempts.some((a) => a.attempt === att)) continue;
      const s = Date.now();
      let out;
      try {
        out = await runAttempt(task, cfg, att);
      } catch (e) {
        out = {
          task_id: entry.id, attempt: att, pass: false, ms: Date.now() - s, prompt_tokens: 0,
          completion_tokens: 0, tokens: 0, steps: 0, provider: '', tools: [], cost: 0,
          checks: [], failed_checks: ['跑批异常：' + e.message], reply: '', reply_snippet: '', error: e.message
        };
      }
      entry.attempts.push(out);
      entry.attempts.sort((a, b) => a.attempt - b.attempt);
      results.finished_at = null;
      writeJson(RESULTS, results);
      console.log('  ' + (out.pass ? '✓' : '✗') + ' ' + entry.id.padEnd(26) + ' 第' + att + '遍 '
        + sec(out.ms).padStart(7) + '  ' + String(out.tokens).padStart(6) + ' tok'
        + (out.pass ? '' : '  ' + (out.error || (out.failed_checks || []).join('；')).slice(0, 80)));
    }
    if ((i + 1) % 5 === 0) console.log('  —— 已完成 ' + (i + 1) + '/' + to + ' 题，累计 ' + sec(Date.now() - t0));
  }

  const allDone = results.tasks.every((t) => t.attempts.length >= ATTEMPTS);
  if (allDone) {
    results.finished_at = new Date().toISOString();
    writeJson(RESULTS, results);
    const s = writeReport(results);
    console.log('');
    console.log('全部跑完：两遍都过 ' + s.passed_both + '/' + s.done + '（' + s.pass_rate_both + '%）'
      + ' · 不稳定 ' + s.unstable + ' · 不过 ' + s.failed_both);
    console.log('总耗时 ' + sec(s.total_ms) + ' · ' + fmt(s.total_tokens) + ' tokens · 实际 '
      + s.cost.toFixed(4) + ' 元 / 云端折算 ' + s.cloud_cost.toFixed(4) + ' 元');
    console.log('报表：data/report.md   机器可读：data/results.json');
  } else {
    const todo = results.tasks.filter((t) => t.attempts.length < ATTEMPTS).map((t) => t.id);
    console.log('');
    console.log('本轮结束（还没跑全），剩余 ' + todo.length + ' 题：' + todo.slice(0, 5).join('、') + (todo.length > 5 ? ' …' : ''));
    console.log('接着跑：node evals/run.js --run');
  }
}

main().catch((e) => {
  console.error('跑批挂了：' + e.stack);
  process.exit(1);
});
