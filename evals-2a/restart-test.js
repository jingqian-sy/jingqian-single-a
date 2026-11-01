'use strict';
/*
 * 2A 重启恢复验证（真跑）
 *
 *   node evals-2a/restart-test.js
 *   RESTART_DIR=data/ci-run/2a-restart RESTART_TASKS=5 MOCK_DELAY_MS=120 node evals-2a/restart-test.js
 *
 * 做法和 3A 那套一致，但验的是 2A 的编排进程：
 *   1. mock 模型，造 N 个可机器验收的小任务；
 *   2. 编排进程 A 跑到一半 SIGKILL；
 *   3. 检查落盘：已完成的不丢、running/checking 还挂着、锁文件还在；
 *   4. 同一条命令起进程 B：接管死锁、recover 后重新排队、把剩下的跑完；
 *   5. 断言全部 done、每任务只 done 一次、journal 有 recover、单A 与 3A 的数据一个字节没动。
 *
 * 结果写 data-2a/restart-verify.json（CI 里走 RESTART_DIR，不覆盖这份证据）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { start: startMock } = require('../evals/mock-provider');
const { readJson, writeJson, appendJsonl, ensureDir } = require('../src-2a/util');

const ROOT = path.join(__dirname, '..');
const TEST_ROOT = process.env.RESTART_DIR
  ? path.resolve(ROOT, process.env.RESTART_DIR)
  : path.join(ROOT, 'data-2a', '.restart-test');
const TASK_COUNT = Math.max(3, Number(process.env.RESTART_TASKS || 8));
const DELAY = Number(process.env.MOCK_DELAY_MS || 200);
const JOBS = path.join(TEST_ROOT, 'jobs.json');
const CFG = path.join(TEST_ROOT, 'config.json');
const MOCK_PORT = 18097;

function sha(file) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12); } catch (e) { return 'missing'; }
}
function readState() { return readJson(path.join(TEST_ROOT, 'state', 'tasks.json'), { tasks: {} }); }
function counts(state) {
  const tasks = Object.values(state.tasks || {});
  const by = {};
  for (const t of tasks) by[t.status] = (by[t.status] || 0) + 1;
  return { total: tasks.length, by, done: by.done || 0 };
}
function spawnCli() {
  return spawn(process.execPath, [
    path.join(ROOT, 'src-2a', 'cli.js'), '--jobs', JOBS, '--config', CFG, '--root', TEST_ROOT, '--quiet'
  ], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
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
    await new Promise((r) => setTimeout(r, 150));
  }
  return counts(readState());
}

async function main() {
  process.env.MOCK_DELAY_MS = String(DELAY);
  const others = {
    singleA: sha(path.join(ROOT, 'data', 'results.json')),
    threeA: sha(path.join(ROOT, 'data-multi', 'results.json'))
  };

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  ensureDir(TEST_ROOT);

  writeJson(CFG, {
    port: 7897,
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
  });

  const jobs = [];
  for (let i = 1; i <= TASK_COUNT; i++) {
    jobs.push({
      id: 'r' + i,
      prompt: '建一个 t' + i + '.txt 写 ' + i,
      checks: [{ type: 'file_contains', path: 't' + i + '.txt', value: String(i) }]
    });
  }
  writeJson(JOBS, jobs);

  const mock = await startMock({ port: MOCK_PORT });
  const result = {
    at: new Date().toISOString(),
    how: '编排进程 A 跑到一半被 SIGKILL 杀掉，再用同一条命令起进程 B 接管',
    task_count: TASK_COUNT,
    before_kill: null,
    after_restart: null,
    checks: {},
    passed: false
  };
  let childA = null, childB = null;
  try {
    childA = spawnCli();
    await waitDone(2, 60000);
    const killed = childA.kill('SIGKILL');
    await waitExit(childA, 5000);
    const st = readState();
    result.before_kill = {
      killed_signal_sent: killed,
      ...counts(st),
      lock_file_exists: fs.existsSync(path.join(TEST_ROOT, 'state', 'scheduler.lock')),
      running_or_checking: Object.values(st.tasks).filter((t) => ['running', 'checking'].includes(t.status)).map((t) => t.id)
    };

    childB = spawnCli();
    const exited = await waitExit(childB, 180000);
    const after = readState();
    const c = counts(after);
    const perTask = Object.values(after.tasks).map((t) => ({
      id: t.id,
      status: t.status,
      done_transitions: (t.transitions || []).filter((x) => x.to === 'done').length,
      recover_count: t.recover_count || 0
    }));
    const journal = fs.readFileSync(path.join(TEST_ROOT, 'state', 'journal.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const recovers = journal.filter((x) => x.kind === 'recover');

    result.after_restart = {
      process_exited: exited,
      ...c,
      recovery_events: recovers.map((r) => ({ task: r.task_id, from: r.from, recover_count: r.recover_count })),
      per_task: perTask
    };
    result.checks = {
      '被杀前已有任务完成': result.before_kill.done >= 2,
      '恢复后全部任务 done': c.done === TASK_COUNT && c.total === TASK_COUNT,
      '每个任务只 done 一次': perTask.every((t) => t.done_transitions === 1),
      '确实触发了恢复（journal 有 recover）': recovers.length >= 1,
      '没有重复任务': c.total === TASK_COUNT,
      '单A 数据没被碰': sha(path.join(ROOT, 'data', 'results.json')) === others.singleA,
      '3A 数据没被碰': sha(path.join(ROOT, 'data-multi', 'results.json')) === others.threeA
    };
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
    writeJson(path.join(ROOT, 'data-2a', 'restart-verify.json'), result);
    appendJsonl(path.join(ROOT, 'data-2a', 'logs', 'restart-verify.log'), { at: result.at, passed: result.passed, checks: result.checks });
  }

  console.log('');
  console.log('2A 重启恢复验证：' + (result.passed ? '通过' : '失败'));
  console.log('  被杀前已完成：' + (result.before_kill ? result.before_kill.done : '?') + '，挂着：'
    + (result.before_kill ? (result.before_kill.running_or_checking || []).join(',') || '无' : '?'));
  console.log('  重启后完成：' + (result.after_restart ? result.after_restart.done : '?') + ' / ' + TASK_COUNT);
  for (const [k, v] of Object.entries(result.checks || {})) console.log('  ' + (v ? '✓' : '✗') + ' ' + k);
  console.log('  明细：' + path.relative(ROOT, path.join(TEST_ROOT, 'restart-verify.json')));
  process.exit(result.passed ? 0 : 1);
}

main().catch((e) => { console.error(e.stack); process.exit(1); });
