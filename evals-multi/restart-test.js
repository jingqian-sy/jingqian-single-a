'use strict';
/*
 * 3A 重启恢复验证（真跑，不是写在文档里的口号）
 *
 *   node evals-multi/restart-test.js
 *
 * 做法：
 *   1. 起 mock provider（不需要密钥），造 8 个可机器验收的小任务；
 *   2. 起调度进程 A，等它跑完 2 个任务后 **直接 kill -9**（模拟崩溃）；
 *   3. 检查落盘状态：已完成的不丢、正在跑的还挂在 running/inspecting、锁文件还在；
 *   4. 起调度进程 B（同一条命令），验证它接管旧锁、恢复未完成任务、把剩下的全跑完；
 *   5. 断言：8 个任务全部 done、每个任务只有一次 done 迁移、没有重复任务、
 *      单A 的 data/ 一个字节没动。
 *
 * 结果写 data-multi/restart-verify.json，人看的日志追加到 data-multi/logs/restart-verify.log。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { start: startMock } = require('../evals/mock-provider');
const { readJson, writeJson, appendJsonl, ensureDir } = require('../src-multi/util');

const ROOT = path.join(__dirname, '..');
const TEST_ROOT = process.env.RESTART_DIR
  ? path.resolve(ROOT, process.env.RESTART_DIR)
  : path.join(ROOT, 'data-multi', '.restart-test');
const JOBS = path.join(TEST_ROOT, 'jobs.json');
const CFG = path.join(TEST_ROOT, 'config.json');
const MOCK_PORT = 18098;

function sha(file) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12); } catch (e) { return 'missing'; }
}

function readState() {
  return readJson(path.join(TEST_ROOT, 'state', 'tasks.json'), { tasks: {} });
}

function counts(state) {
  const tasks = Object.values(state.tasks || {});
  const by = {};
  for (const t of tasks) by[t.status] = (by[t.status] || 0) + 1;
  return { total: tasks.length, by, done: by.done || 0 };
}

function spawnCli() {
  const args = [
    path.join(ROOT, 'src-multi', 'cli.js'),
    '--jobs', JOBS,
    '--config', CFG,
    '--root', TEST_ROOT,
    '--quiet'
  ];
  return spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
}

function waitExit(child, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    child.on('close', () => { clearTimeout(t); resolve(true); });
  });
}

async function waitDone(n, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const c = counts(readState());
    if (c.done >= n) return c;
    await new Promise((r) => setTimeout(r, 200));
  }
  return counts(readState());
}

async function main() {
  process.env.MOCK_DELAY_MS = '250';
  const singleA = {
    results: sha(path.join(ROOT, 'data', 'results.json')),
    report: sha(path.join(ROOT, 'data', 'report.md'))
  };

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  ensureDir(TEST_ROOT);

  const cfg = {
    port: 7898,
    providers: [{
      name: 'mock', tier: 'local',
      base: 'http://127.0.0.1:' + MOCK_PORT + '/v1/chat/completions',
      model: 'mock-1', key: 'local', price_in: 0, price_out: 0
    }],
    route: { mode: 'fixed', order: ['mock'], escalate: false, maxSteps: 6 },
    memory: { autoCapture: true },
    tools: { workspace: 'workspace', allowCommand: true, commandWhitelist: ['echo'], commandTimeoutMs: 10000, maxOutput: 4000 },
    sandbox: { mode: 'none' },
    budget: { perCallSeconds: 20, perTaskSeconds: 60, perTaskTokens: 20000 },
    temperature: 0
  };
  writeJson(CFG, cfg);

  const jobs = [];
  for (let i = 1; i <= 8; i++) {
    jobs.push({
      id: 'r' + i,
      prompt: '建一个 t' + i + '.txt 写 ' + i,
      acceptance: [{ type: 'file_contains', path: 't' + i + '.txt', value: String(i) }]
    });
  }
  writeJson(JOBS, jobs);

  const mock = await startMock({ port: MOCK_PORT });
  const result = {
    at: new Date().toISOString(),
    how: '调度进程 A 跑到一半被 SIGKILL 杀掉，再用同一条命令起进程 B 接管',
    before_kill: null,
    after_restart: null,
    checks: {},
    passed: false,
    single_a_data_touched: false
  };
  let childA = null;
  let childB = null;

  try {
    // ---- 进程 A：跑，然后被杀 ----
    childA = spawnCli();
    const mid = await waitDone(2, 60000);
    const killed = childA.kill('SIGKILL');
    await waitExit(childA, 5000);
    result.before_kill = {
      killed_signal_sent: killed,
      ...counts(readState()),
      lock_file_exists: fs.existsSync(path.join(TEST_ROOT, 'state', 'scheduler.lock')),
      running_or_inspecting: Object.values(readState().tasks).filter((t) => ['running', 'inspecting'].includes(t.status)).map((t) => t.id),
      note: '已完成 ' + mid.done + ' 个，被杀时另有任务正挂在 running/inspecting'
    };

    // ---- 进程 B：同一条命令，恢复 ----
    childB = spawnCli();
    const finished = await waitExit(childB, 180000);
    const after = readState();
    const c = counts(after);
    const perTaskDone = Object.values(after.tasks).map((t) => ({
      id: t.id,
      status: t.status,
      done_transitions: (t.transitions || []).filter((x) => x.to === 'done').length,
      recover_count: t.recover_count || 0
    }));
    const journal = fs.readFileSync(path.join(TEST_ROOT, 'state', 'journal.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const recovers = journal.filter((x) => x.kind === 'recover');

    result.after_restart = {
      process_exited: finished,
      ...c,
      recovery_events: recovers.map((r) => ({ task: r.task_id, from: r.from, recover_count: r.recover_count })),
      per_task: perTaskDone
    };

    result.checks = {
      '被杀前已有任务完成': result.before_kill.done >= 2,
      '恢复后全部任务 done': c.done === 8 && c.total === 8,
      '每个任务只 done 一次': perTaskDone.every((t) => t.done_transitions === 1),
      '确实触发了恢复（journal 有 recover）': recovers.length >= 1,
      '没有重复任务': c.total === 8,
      '单A 数据没被碰': sha(path.join(ROOT, 'data', 'results.json')) === singleA.results
        && sha(path.join(ROOT, 'data', 'report.md')) === singleA.report
    };
    result.single_a_data_touched = !result.checks['单A 数据没被碰'];
    result.passed = Object.values(result.checks).every(Boolean);
  } catch (e) {
    result.error = e.message;
    result.checks = { '流程没抛异常': false };
    result.passed = false;
  } finally {
    try { if (childA && !childA.killed) childA.kill('SIGKILL'); } catch (e) {}
    try { if (childB && !childB.killed) childB.kill('SIGKILL'); } catch (e) {}
    mock.close();
  }

  writeJson(path.join(TEST_ROOT, 'restart-verify.json'), result);
  if (!process.env.RESTART_DIR) {
    writeJson(path.join(ROOT, 'data-multi', 'restart-verify.json'), result);
  }
  appendJsonl(path.join(TEST_ROOT, 'restart-verify.log'), {
    at: result.at, passed: result.passed, before: result.before_kill && result.before_kill.done,
    after: result.after_restart && result.after_restart.done, checks: result.checks
  });
  if (!process.env.RESTART_DIR) {
    appendJsonl(path.join(ROOT, 'data-multi', 'logs', 'restart-verify.log'), {
      at: result.at, passed: result.passed, before: result.before_kill && result.before_kill.done,
      after: result.after_restart && result.after_restart.done, checks: result.checks
    });
  }

  console.log('');
  console.log('重启恢复验证：' + (result.passed ? '通过' : '失败'));
  console.log('  被杀前已完成：' + (result.before_kill ? result.before_kill.done : '?') + ' 个，' +
    '挂着的：' + (result.before_kill ? (result.before_kill.running_or_inspecting || []).join(',') || '无' : '?'));
  console.log('  重启后完成：' + (result.after_restart ? result.after_restart.done : '?') + ' / 8');
  console.log('  恢复事件：' + ((result.after_restart && result.after_restart.recovery_events) || []).length + ' 条');
  for (const [k, v] of Object.entries(result.checks || {})) console.log('  ' + (v ? '✓' : '✗') + ' ' + k);
  console.log('  明细：' + path.relative(ROOT, path.join(TEST_ROOT, 'restart-verify.json')));
  process.exit(result.passed ? 0 : 1);
}

main().catch((e) => { console.error(e.stack); process.exit(1); });
