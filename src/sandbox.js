'use strict';
/*
 * 沙盒（可选项，默认关）
 *
 *   mode: "none"    直接执行。只靠四级红线 + 命令白名单 + 受限工作目录。默认这档。
 *         "process" 子进程 + 临时工作目录 + 超时 + 输出与内存上限。半可信场景用。
 *         "docker"  容器内执行。检测不到 docker 就明确报错并回退到 process，不静默失败。
 *
 * 为什么要做成开关：很多人机器上没有 WSL2/docker，默认开 docker 等于 clone 下来跑不起来。
 * 开了会慢、有额外依赖，README 里如实写了。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

const MODES = ['none', 'process', 'docker'];

function normalizeMode(mode) {
  const m = String(mode || 'none').toLowerCase();
  return MODES.includes(m) ? m : 'none';
}

function dockerAvailable() {
  try {
    const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 5000, encoding: 'utf8', windowsHide: true
    });
    return !!(r && r.status === 0 && String(r.stdout || '').trim());
  } catch (e) { return false; }
}

/*
 * 跑一次命令，返回 { ok, code, stdout, stderr, mode, sandboxed, note, ms }
 * ctx: { workspace, timeoutMs, maxOutput, env }
 * allowFn: 命令白名单校验（tools 层传进来），沙盒不负责这层
 */
function run(command, ctx) {
  ctx = ctx || {};
  const mode = normalizeMode(ctx.sandboxMode);
  const timeoutMs = Math.min(Number(ctx.timeoutMs) || 30000, 300000);
  const maxOutput = Number(ctx.maxOutput) || 20000;
  const workspace = ctx.workspace || process.cwd();
  const started = Date.now();

  let actual = mode;
  let note = '';
  if (mode === 'docker' && !dockerAvailable()) {
    actual = 'process';
    note = '配置要 docker，但这台机器上探测不到可用的 docker，已回退到 process 模式（沙盒变弱了）。';
    console.warn('[sandbox] ' + note);
  }

  if (actual === 'none') {
    return runDirect(command, workspace, timeoutMs, maxOutput, started, 'none', '直接执行，只靠红线与白名单');
  }
  if (actual === 'docker') {
    return runDocker(command, workspace, timeoutMs, maxOutput, started, ctx);
  }
  return runInProcess(command, workspace, timeoutMs, maxOutput, started, note);
}

function runDirect(command, workspace, timeoutMs, maxOutput, started, mode, note) {
  return runInProcess(command, workspace, timeoutMs, maxOutput, started, note, mode);
}

function truncateOut(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '\n…（输出被截断）' : s;
}

// Windows 上子进程的输出编码不一定跟 Node 一致：cmd 走 OEM 代码页（中文机器是 GBK），
// PowerShell 可能走 UTF-16。这里先按 UTF-8 严格解，解不动就退 GBK，别把中文变成问号。
function decodeOutput(buf) {
  if (!buf || !buf.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    try { return new TextDecoder('gbk').decode(buf); } catch (e2) { return buf.toString('utf8'); }
  }
}

function runInProcess(command, workspace, timeoutMs, maxOutput, started, note, modeOverride) {
  const isWin = process.platform === 'win32';
  const file = isWin ? 'cmd.exe' : '/bin/sh';
  // Windows 控制台默认是 OEM 代码页（中文机器上是 936），中文输出会变乱码；
  // 先切到 UTF-8 再跑，Node 这边按 utf8 解才不糊。
  const wrapped = isWin ? ('chcp 65001>nul & ' + command) : command;
  const args = isWin ? ['/d', '/s', '/c', wrapped] : ['-c', command];
  const tmp = path.join(workspace, '.tmp');
  try { fs.mkdirSync(tmp, { recursive: true }); } catch (e) { /* 建不了就用系统临时目录 */ }
  const r = spawnSync(file, args, {
    cwd: workspace,
    timeout: timeoutMs,
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: Math.max(maxOutput * 4, 1024 * 1024),
    env: Object.assign({}, process.env, {
      // 进程档：限制一下能看到的临时目录，顺带把常见密钥环境变量藏掉
      TMPDIR: path.join(workspace, '.tmp'),
      TEMP: path.join(workspace, '.tmp'),
      DEEPSEEK_API_KEY: '',
      OPENAI_API_KEY: '',
      ZHIPU_API_KEY: ''
    })
  });
  const out = (decodeOutput(r.stdout) + (r.stderr && r.stderr.length ? '\n' + decodeOutput(r.stderr) : '')).trim();
  return {
    ok: r.status === 0,
    code: r.status == null ? -1 : r.status,
    output: truncateOut(out, maxOutput),
    mode: modeOverride || 'process',
    note: note || '子进程执行，带超时与临时工作目录',
    timedOut: r.error && r.error.code === 'ETIMEDOUT',
    ms: Date.now() - started
  };
}

function runDocker(command, workspace, timeoutMs, maxOutput, started, ctx) {
  if (!dockerAvailable()) {
    return { ok: false, code: -1, output: '探测不到 docker，没跑。', mode: 'docker', note: 'docker 不可用', ms: Date.now() - started };
  }
  const image = (ctx.dockerImage || 'node:22-alpine');
  const abs = path.resolve(workspace);
  const r = spawnSync('docker', [
    'run', '--rm', '--network=none',
    '-v', abs + ':/work', '-w', '/work',
    image, 'sh', '-c', command
  ], {
    timeout: timeoutMs + 5000,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: Math.max(maxOutput * 4, 1024 * 1024)
  });
  const out = String((r.stdout || '') + (r.stderr ? '\n' + r.stderr : '')).trim();
  return {
    ok: r.status === 0,
    code: r.status == null ? -1 : r.status,
    output: truncateOut(out, maxOutput),
    mode: 'docker',
    note: '容器内执行（network=none，工作目录挂载到 /work）',
    ms: Date.now() - started
  };
}

function status(ctx) {
  const mode = normalizeMode(ctx && ctx.sandboxMode);
  return {
    configured: mode,
    docker_available: dockerAvailable(),
    effective: mode === 'docker' && !dockerAvailable() ? 'process' : mode
  };
}

module.exports = { run, status, dockerAvailable, normalizeMode, MODES };
