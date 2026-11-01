'use strict';
/*
 * CI 入口：一条命令把「不需要密钥」的检查全跑一遍。
 *
 *   node evals/ci.js            跑完自己清理临时数据
 *   node evals/ci.js --keep     留着 data/ci-run/ 方便看现场
 *
 * 顺序（每步失败都会打清是哪一步、哪条规则）：
 *   1. 语法检查（src/ evals/ 下所有 .js）
 *   2. 判定器单元测试（evals/test-judge.js，26 条规则）
 *   3. 工具 / 红线 / 路径 / 沙盒单元测试（evals/test-tools.js）
 *   4. 起 mock provider（本地假模型，无需密钥）
 *   5. 服务冒烟：真起 src/server.js，打 /api/chat
 *   6. 评测子集：m01 m02 t02 t08 r01 x01（跑两遍，机器判定）
 *
 * 所有临时数据都写在 data/ci-run/ 和 evals/.run/ 下，覆盖不到你的真实记忆与成绩报表。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { start: startMock } = require('./mock-provider');

const ROOT = path.join(__dirname, '..');
const CI_DATA = 'data/ci-run';
const CI_CONFIG = 'config.ci.json';
const MOCK_PORT = 18000 + (process.pid % 900); // 用 pid 派生端口，避免上次残留进程占着 18099 把 CI 卡死
const SUBSET = ['m01_memory_write', 'm02_memory_recall', 't02_write_file', 't08_path_prefix_regression', 'r01_p0_format', 'x01_three_files'];

const keep = process.argv.includes('--keep');
let mock = null;
let failedStep = '';

function node(args, env) {
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: Object.assign({}, process.env, env || {})
  });
  if (r.status !== 0) throw new Error('退出码 ' + r.status);
}

// 跑子进程但不阻塞事件循环：mock provider 就在本进程里，用 spawnSync 会把它一起卡死
function nodeAsync(args, env) {
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: Object.assign({}, process.env, env || {})
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('退出码 ' + code));
    });
  });
}

function step(name, fn) {
  console.log('\n=== ' + name + ' ===');
  try {
    fn();
    console.log('✓ ' + name);
  } catch (e) {
    failedStep = name;
    console.error('✗ ' + name + '：' + e.message);
    throw e;
  }
}

async function stepAsync(name, fn) {
  console.log('\n=== ' + name + ' ===');
  try {
    await fn();
    console.log('✓ ' + name);
  } catch (e) {
    failedStep = name;
    console.error('✗ ' + name + '：' + e.message);
    throw e;
  }
}

function syntaxCheck() {
  const files = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === 'node_modules' || d.name.startsWith('.')) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'src-multi'));
  walk(path.join(__dirname));
  walk(path.join(ROOT, 'evals-multi'));
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('语法错误：' + path.relative(ROOT, f) + '\n' + (r.stderr || ''));
  }
  console.log('检查了 ' + files.length + ' 个 .js 文件');
}

function writeCiConfig() {
  const cfg = {
    port: 7899,
    host: '127.0.0.1',
    providers: [{
      name: 'mock-local',
      tier: 'local',
      base: 'http://127.0.0.1:' + MOCK_PORT + '/v1/chat/completions',
      model: 'mock-1',
      key: 'local',
      price_in: 0,
      price_out: 0,
      note: 'CI 用的假模型，不花钱、不联网'
    }],
    route: { mode: 'fixed', order: ['mock-local'], escalate: false, maxSteps: 6 },
    memory: { topK: 3, maxHistory: 6, autoCapture: true, writeEvents: true, eventWindowDays: 7, idleConsolidateMinutes: 0 },
    embedding: { enabled: false },
    tools: { workspace: 'data/ci-run/workspace', allowCommand: true, commandWhitelist: ['echo', 'dir', 'node'], commandTimeoutMs: 15000, maxOutput: 4000 },
    sandbox: { mode: 'none' },
    budget: { perCallSeconds: 30, perTaskSeconds: 90, perTaskTokens: 20000 },
    temperature: 0
  };
  fs.writeFileSync(path.join(ROOT, CI_CONFIG), JSON.stringify(cfg, null, 2), 'utf8');
  console.log('生成 ' + CI_CONFIG + '（mock provider，无密钥）');
}

function verifyResults() {
  const file = path.join(ROOT, CI_DATA, 'results.json');
  if (!fs.existsSync(file)) throw new Error('没找到 ' + path.relative(ROOT, file));
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = [];
  for (const id of SUBSET) {
    const t = r.tasks.find((x) => x.id === id);
    if (!t) { problems.push(id + ' 没跑到'); continue; }
    if (t.attempts.length !== 2) { problems.push(id + ' 只跑了 ' + t.attempts.length + ' 遍'); continue; }
    for (const a of t.attempts) {
      if (!a.pass) problems.push(id + ' 第' + a.attempt + '遍没过：' + (a.error || (a.failed_checks || []).join('；')));
    }
  }
  if (problems.length) throw new Error('评测子集没过：\n  - ' + problems.join('\n  - '));
  console.log('子集 ' + SUBSET.length + ' 题 × 2 遍全部通过');
}

function verifyMultiResults() {
  const file = path.join(ROOT, CI_DATA, 'multi', 'results.json');
  if (!fs.existsSync(file)) throw new Error('没找到 ' + path.relative(ROOT, file));
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = ['m01_memory_write', 't02_write_file', 't08_path_prefix_regression', 'r01_p0_format'];
  const problems = [];
  for (const id of ids) {
    const t = r.tasks.find((x) => x.id === id);
    if (!t) { problems.push(id + ' 没跑到'); continue; }
    if (t.attempts.length !== 2) { problems.push(id + ' 只跑了 ' + t.attempts.length + ' 遍'); continue; }
    for (const a of t.attempts) {
      if (!a.pass) problems.push(id + ' 第' + a.attempt + '遍没过：' + (a.error || (a.failed_checks || []).join('；')));
    }
  }
  if (problems.length) throw new Error('3A 子集没过：\n  - ' + problems.join('\n  - '));
  console.log('3A 子集 ' + ids.length + ' 题 × 2 遍全部通过');
}

function verify2AResults() {
  const file = path.join(ROOT, CI_DATA, '2a', 'results.json');
  if (!fs.existsSync(file)) throw new Error('没找到 ' + path.relative(ROOT, file));
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = ['m01_memory_write', 't02_write_file', 't08_path_prefix_regression', 'r01_p0_format'];
  const problems = [];
  for (const id of ids) {
    const t = r.tasks.find((x) => x.id === id);
    if (!t) { problems.push(id + ' 没跑到'); continue; }
    if (t.attempts.length !== 2) { problems.push(id + ' 只跑了 ' + t.attempts.length + ' 遍'); continue; }
    for (const a of t.attempts) {
      if (!a.pass) problems.push(id + ' 第' + a.attempt + '遍没过：' + (a.error || (a.failed_checks || []).join('；')));
    }
  }
  if (problems.length) throw new Error('2A 子集没过：\n  - ' + problems.join('\n  - '));
  console.log('2A 子集 ' + ids.length + ' 题 × 2 遍全部通过');
}

async function main() {
  const t0 = Date.now();
  try {
    await stepAsync('1. 语法检查', syntaxCheck);
    await stepAsync('2. 判定器单元测试', () => node([path.join(__dirname, 'test-judge.js')]));
    await stepAsync('3. 工具 / 红线 / 路径 / 沙盒单元测试', () => node([path.join(__dirname, 'test-tools.js')]));
    await stepAsync('4. 启动 mock provider', async () => {
      mock = await startMock({ port: MOCK_PORT });
      const r = await fetch('http://127.0.0.1:' + MOCK_PORT + '/health');
      if (!r.ok) throw new Error('mock provider 没起来');
      console.log('mock provider：http://127.0.0.1:' + MOCK_PORT + '/v1/chat/completions');
    });
    await stepAsync('5. 准备 CI 配置（无密钥）', writeCiConfig);
    await stepAsync('6. 服务冒烟（真起 server，打 /api/chat）', () => nodeAsync([path.join(__dirname, 'smoke.js')], {
      JQ_CONFIG: CI_CONFIG, JQ_DATA_DIR: CI_DATA, SMOKE_PORT: '7899'
    }));
    await stepAsync('7. 评测子集（' + SUBSET.join(' ') + '）', () => nodeAsync([
      path.join(__dirname, 'run.js'), '--run', '--fresh', '--only', SUBSET.join(',')
    ], { JQ_CONFIG: CI_CONFIG, JQ_DATA_DIR: CI_DATA }));
    await stepAsync('8. 校验子集结果', verifyResults);
    await stepAsync('9. 3A 模板子集（mock：m01 t02 t08 r01）', () => nodeAsync([
      path.join(ROOT, 'evals-multi', 'run.js'), '--run', '--fresh', '--only', 'm01_memory_write,t02_write_file,t08_path_prefix_regression,r01_p0_format'
    ], { JQ_CONFIG: CI_CONFIG, JQ_MULTI_DIR: CI_DATA + '/multi' }));
    await stepAsync('10. 校验 3A 子集结果', () => verifyMultiResults());
    await stepAsync('11. 3A 调度重启恢复（kill -9 后重启接管）', () => nodeAsync([
      path.join(ROOT, 'evals-multi', 'restart-test.js')
    ], { RESTART_DIR: CI_DATA + '/3a-restart', RESTART_TASKS: '5', MOCK_DELAY_MS: '100' }));
    await stepAsync('12. 2A 模板子集（mock：m01 t02 t08 r01）', () => nodeAsync([
      path.join(ROOT, 'evals-2a', 'run.js'), '--run', '--fresh', '--only', 'm01_memory_write,t02_write_file,t08_path_prefix_regression,r01_p0_format'
    ], { JQ_CONFIG: CI_CONFIG, JQ_2A_DIR: CI_DATA + '/2a' }));
    await stepAsync('13. 校验 2A 子集结果', () => verify2AResults());
    await stepAsync('14. 2A 编排进程重启恢复', () => nodeAsync([
      path.join(ROOT, 'evals-2a', 'restart-test.js')
    ], { RESTART_DIR: CI_DATA + '/2a-restart', RESTART_TASKS: '5', MOCK_DELAY_MS: '100' }));
    await stepAsync('15. QQ 适配层（入/出/白名单/群里没@不回）', () => nodeAsync([
      path.join(__dirname, 'qq-test.js')
    ], {}));

    console.log('\n全部通过，用时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒');
  } catch (e) {
    console.error('\nCI 失败于步骤：' + (failedStep || '未知') + (e.message ? '（' + e.message + '）' : ''));
    process.exitCode = 1;
  } finally {
    if (mock && mock.close) mock.close();
    // 清理：配置文件不留（里面只有假地址），临时数据按 --keep 决定
    try { fs.unlinkSync(path.join(ROOT, CI_CONFIG)); } catch (e) {}
    if (!keep && !failedStep) {
      try { fs.rmSync(path.join(ROOT, CI_DATA), { recursive: true, force: true }); } catch (e) {}
    } else {
      console.log('保留现场：' + CI_DATA + '/（失败时留着给人看，下次跑会覆盖）');
    }
  }
}

main();
