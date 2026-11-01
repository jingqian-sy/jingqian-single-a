'use strict';
/*
 * 3A 模板 · 命令行入口
 *
 *   node src-multi/cli.js "帮我记一下：我周三晚上打羽毛球"
 *   node src-multi/cli.js --jobs jobs.json          # 批量（评测/重启验证都用这个）
 *   node src-multi/cli.js --status                  # 只看当前状态，不干活
 *   node src-multi/cli.js --jobs jobs.json --root data-multi/.test   # 换数据目录
 *
 * 数据全在 --root 指的目录里（默认 data-multi），不碰单A 的 data/。
 */
const fs = require('fs');
const path = require('path');
const { buildSystem } = require('./system');
const { readJson, nowIso } = require('./util');

const ROOT = path.join(__dirname, '..');

function loadConfig(configPath) {
  const base = readJson(path.join(ROOT, 'config.example.json'), {});
  const file = configPath ? path.resolve(ROOT, configPath) : (process.env.JQ_CONFIG ? path.resolve(ROOT, process.env.JQ_CONFIG) : path.join(ROOT, 'config.json'));
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

async function main() {
  const argv = process.argv.slice(2);
  const get = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  const root = path.resolve(ROOT, get('--root') || 'data-multi');
  const cfg = loadConfig(get('--config'));
  const quiet = argv.includes('--quiet');
  const sys = buildSystem(root, cfg, {
    onEvent: quiet ? null : (e) => {
      if (e.kind === 'transition') process.stdout.write('  [' + e.task_id + '] ' + e.from + ' → ' + e.to + '\n');
    }
  });

  try {
    sys.scheduler.acquireLock();
  } catch (e) {
    console.error('✗ ' + e.message);
    process.exit(2);
  }

  try {
    const recovered = sys.scheduler.recover();
    if (recovered.length) {
      console.log('检测到上次没跑完的任务，恢复 ' + recovered.length + ' 个：' + recovered.map((r) => r.task_id + '(' + r.from + ')').join('、'));
      fs.mkdirSync(path.join(root, 'state'), { recursive: true });
      fs.writeFileSync(path.join(root, 'state', 'last-recover.json'), JSON.stringify({ at: nowIso(), recovered }, null, 2), 'utf8');
    }

    if (argv.includes('--status')) {
      console.log(JSON.stringify(sys.scheduler.summary(), null, 2));
      return;
    }

    const jobsFile = get('--jobs');
    if (jobsFile) {
      const jobs = readJson(path.resolve(ROOT, jobsFile), null);
      if (!jobs) { console.error('读不到 jobs 文件：' + jobsFile); process.exit(2); }
      for (const j of jobs) sys.scheduler.submit(j);
      console.log('提交 ' + jobs.length + ' 个任务，开始跑（数据目录 ' + path.relative(ROOT, root) + '）');
      const s = await sys.scheduler.runAll();
      console.log('\n3A 跑完：' + JSON.stringify(s));
      if (s.done !== s.total) process.exitCode = 1;
      return;
    }

    const prompt = argv.filter((a) => !a.startsWith('--') && a !== get('--root') && a !== get('--config') && a !== get('--jobs'))[0];
    if (!prompt) {
      console.log('用法：node src-multi/cli.js "一句话" | --jobs jobs.json | --status');
      return;
    }
    const task = sys.scheduler.submit({ id: 'one', prompt, acceptance: [] });
    await sys.scheduler.runTask(task.id);
    const t = sys.scheduler.state.tasks[task.id];
    console.log('\n回复：' + (t.reply || '（空）'));
    console.log('状态：' + t.status + ' · 步数 ' + t.stats.steps + ' · ' + t.stats.total_tokens + ' tokens');
    if (t.error) console.log('问题：' + t.error);
  } finally {
    sys.scheduler.releaseLock();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('3A 出错：' + e.stack);
    process.exit(1);
  });
}

module.exports = { loadConfig };
