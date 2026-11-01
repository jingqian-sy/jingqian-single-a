'use strict';
/*
 * 2A 模板 · 统一命令行入口
 *
 *   node src-2a/cli.js "帮我记一下：我周三晚上打羽毛球"
 *   node src-2a/cli.js --jobs jobs.json [--root data-2a/.test]
 *   node src-2a/cli.js --status
 *   node src-2a/cli.js --mode auto|1a|2a|3a "一句话"
 *
 * --mode 是给后面的「自适应层」留的口子：
 *   1a   走单A 模板（src/core.js，数据在 data/）
 *   2a   走本模板（默认，数据在 data-2a/）
 *   3a   转给 3A 模板（src-multi/cli.js，数据在 data-multi/）
 *   auto 目前**还没有判定逻辑**，会明确打印一句然后按 2a 走；接自适应时改 resolveMode() 即可。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildSystem } = require('./system');
const { readJson, nowIso, appendJsonl, ensureDir } = require('./util');

const ROOT = path.join(__dirname, '..');

function loadConfig(configPath) {
  const base = readJson(path.join(ROOT, 'config.example.json'), {});
  const file = configPath
    ? path.resolve(ROOT, configPath)
    : (process.env.JQ_CONFIG ? path.resolve(ROOT, process.env.JQ_CONFIG) : path.join(ROOT, 'config.json'));
  const user = readJson(file, null);
  const cfg = Object.assign({}, base, user || {});
  cfg.providers = ((user && user.providers) || base.providers || []).map((p) => Object.assign({}, p, {
    key: (p.env && process.env[p.env]) ? process.env[p.env] : p.key
  }));
  cfg.route = Object.assign({}, base.route, (user && user.route) || {});
  cfg.tools = Object.assign({}, base.tools, (user && user.tools) || {});
  cfg.sandbox = Object.assign({}, base.sandbox, (user && user.sandbox) || {});
  cfg.memory = Object.assign({}, base.memory, (user && user.memory) || {});
  cfg.budget = Object.assign({}, base.budget, (user && user.budget) || {});
  return cfg;
}

// --mode auto 真调自适应判定层（src/adaptive/decide.js），按结果分发
function resolveMode(mode) {
  const m = String(mode || '2a').toLowerCase();
  if (!['auto', '1a', '2a', '3a'].includes(m)) return { mode: '2a', note: '未知 --mode ' + mode + '，按 2a 走' };
  return { mode: m, note: '' };
}

function logAdaptive(entry) {
  try {
    ensureDir(path.join(ROOT, 'data-2a'));
    appendJsonl(path.join(ROOT, 'data-2a', 'adaptive.log'), Object.assign({ at: nowIso() }, entry));
  } catch (e) { /* 日志写不进去不影响执行 */ }
}

async function run1a(prompt, cfg) {
  const { Her } = require('../src/core');
  const her = new Her({ root: ROOT, cfg: Object.assign({}, cfg, { dataDir: undefined }) });
  const r = await her.chat(prompt, { sessionId: 'cli-1a' });
  console.log('\n回复：' + r.reply);
  console.log('模型：' + (r.stats.provider || '-') + ' · ' + (r.stats.total_tokens || 0) + ' tokens');
  return { ok: true, tokens: r.stats.total_tokens || 0, reply: r.reply };
}

async function run2a(prompt, cfg, root, quiet) {
  const sys = buildSystem(root, cfg, {
    onEvent: quiet ? null : (e) => {
      if (e.kind === 'transition') process.stdout.write('  [' + e.task_id + '] ' + e.from + ' → ' + e.to + '\n');
    }
  });
  try { sys.orchestrator.acquireLock(); } catch (e) { console.error('✗ ' + e.message); process.exit(2); }
  try {
    const recovered = sys.orchestrator.recover();
    if (recovered.length) console.log('恢复上次没跑完的任务：' + recovered.map((r) => r.task_id).join('、'));
    const jobsFile = process.argv.includes('--jobs') ? process.argv[process.argv.indexOf('--jobs') + 1] : null;
    if (jobsFile) {
      const jobs = readJson(path.resolve(ROOT, jobsFile), null);
      if (!jobs) { console.error('读不到 jobs 文件：' + jobsFile); process.exit(2); }
      for (const j of jobs) sys.orchestrator.submit(j);
      console.log('提交 ' + jobs.length + ' 个任务（数据目录 ' + path.relative(ROOT, root) + '）');
      const s = await sys.orchestrator.runAll();
      console.log('\n2A 跑完：' + JSON.stringify(s));
      if (s.done !== s.total) process.exitCode = 1;
      return;
    }
    const task = sys.orchestrator.submit({ id: 'one', prompt, checks: [] });
    await sys.orchestrator.runTask(task.id);
    const t = sys.orchestrator.state.tasks[task.id];
    console.log('\n回复：' + (t.reply || '（空）'));
    console.log('状态：' + t.status + ' · 步数 ' + t.stats.steps + ' · ' + t.stats.total_tokens + ' tokens'
      + (t.rework_round ? ' · 打回 ' + t.rework_round + ' 次' : ''));
    if (t.error) console.log('问题：' + t.error);
    return { ok: t.status === 'done', tokens: t.stats.total_tokens || 0, reply: t.reply };
  } finally {
    sys.orchestrator.releaseLock();
  }
}

function forward3a(args) {
  // 转发给 3A 时要把 --mode 这一对剥掉，否则 "3a" 会被 3A 的命令行当成提示词
  const fwd = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode') { i++; continue; }
    fwd.push(args[i]);
  }
  return spawnSync(process.execPath, [path.join(ROOT, 'src-multi', 'cli.js')].concat(fwd), {
    cwd: ROOT, stdio: 'inherit'
  });
}

function run3a(argv) {
  const r = forward3a(argv);
  process.exit(r.status == null ? 1 : r.status);
}

function run3aPrompt(prompt) {
  const r = forward3a([prompt]);
  return { ok: r.status === 0 };
}

async function main() {
  const argv = process.argv.slice(2);
  const modeArg = argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : (process.env.JQ_MODE || '2a');
  const picked = resolveMode(modeArg);
  if (picked.note) console.log('（' + picked.note + '）');

  const root = path.resolve(ROOT, argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : (process.env.JQ_2A_ROOT || 'data-2a'));
  const cfg = loadConfig(argv.includes('--config') ? argv[argv.indexOf('--config') + 1] : null);
  const quiet = argv.includes('--quiet');

  if (argv.includes('--status')) {
    const sys = buildSystem(root, cfg);
    console.log(JSON.stringify(sys.orchestrator.summary(), null, 2));
    return;
  }

  const prompt = argv.filter((a, i) => !a.startsWith('--')
    && argv[i - 1] !== '--mode' && argv[i - 1] !== '--root' && argv[i - 1] !== '--config' && argv[i - 1] !== '--jobs')[0];

  if (picked.mode === '3a') return run3a(argv);
  if (picked.mode === '1a') {
    if (!prompt) { console.log('用法：node src-2a/cli.js --mode 1a "一句话"'); return; }
    return run1a(prompt, cfg);
  }
  if (picked.mode === 'auto') {
    if (!prompt) {
      console.log('用法：node src-2a/cli.js --mode auto "一句话"（自适应判定只支持单条任务；--jobs 请显式指定 1a/2a/3a）');
      return;
    }
    const { decide } = require('../src/adaptive/decide');
    const t0 = Date.now();
    const d = await decide(prompt);
    console.log('判定：' + d.mode + '（score ' + d.score + '，by ' + d.by + '）—— ' + d.why);
    let res = { ok: false };
    try {
      if (d.mode === '1a') res = await run1a(prompt, cfg);
      else if (d.mode === '3a') res = run3aPrompt(prompt);
      else res = await run2a(prompt, cfg, root, quiet);
      if (res.ok === undefined) res.ok = true;
    } catch (e) {
      res = { ok: false, error: e.message };
      console.error('执行出错：' + e.message);
    } finally {
      logAdaptive({
        task: String(prompt).slice(0, 200),
        mode: d.mode,
        score: d.score,
        by: d.by,
        why: d.why,
        ms: Date.now() - t0,
        ok: !!res.ok
      });
    }
    return;
  }
  if (!prompt && !argv.includes('--jobs')) {
    console.log('用法：node src-2a/cli.js "一句话" | --jobs jobs.json | --status | --mode auto|1a|2a|3a');
    return;
  }
  return run2a(prompt, cfg, root, quiet);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('2A 出错：' + e.stack);
    process.exit(1);
  });
}

module.exports = { loadConfig, resolveMode };
