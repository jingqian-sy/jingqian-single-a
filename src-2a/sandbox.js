'use strict';
/*
 * 2A 模板 · 沙盒三档（自己一份实现，行为对齐单A）
 *
 *   none 默认：直接执行，只靠红线 + 白名单 + 受限目录
 *   process  ：子进程 + 临时目录 + 超时 + 输出上限
 *   docker   ：容器内跑；探测不到 docker 明确警告并回退 process，不静默失败
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MODES = ['none', 'process', 'docker'];

function normalizeMode(m) {
  const v = String(m || 'none').toLowerCase();
  return MODES.includes(v) ? v : 'none';
}

function dockerAvailable() {
  try {
    const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000, encoding: 'utf8', windowsHide: true });
    return !!(r && r.status === 0 && String(r.stdout || '').trim());
  } catch (e) { return false; }
}

function decodeOutput(buf) {
  if (!buf || !buf.length) return '';
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) {
    try { return new TextDecoder('gbk').decode(buf); } catch (e2) { return buf.toString('utf8'); }
  }
}

function run(command, opts) {
  opts = opts || {};
  const mode = normalizeMode(opts.mode);
  const workspace = opts.workspace || process.cwd();
  const timeoutMs = Math.min(Number(opts.timeoutMs) || 30000, 300000);
  const maxOutput = Number(opts.maxOutput) || 12000;
  const started = Date.now();
  let actual = mode;
  let note = '';

  if (mode === 'docker' && !dockerAvailable()) {
    actual = 'process';
    note = '配置要 docker，但这台机器上探测不到可用的 docker，已回退到 process 模式。';
    console.warn('[3a sandbox] ' + note);
  }

  if (actual === 'docker') {
    const abs = path.resolve(workspace);
    const r = spawnSync('docker', ['run', '--rm', '--network=none', '-v', abs + ':/work', '-w', '/work',
      opts.image || 'node:22-alpine', 'sh', '-c', command], {
      timeout: timeoutMs + 5000, encoding: 'buffer', windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
    return {
      ok: r.status === 0,
      code: r.status == null ? -1 : r.status,
      output: truncateOut((decodeOutput(r.stdout) + (r.stderr && r.stderr.length ? '\n' + decodeOutput(r.stderr) : '')).trim(), maxOutput),
      mode: 'docker',
      note: '容器内执行（network=none）',
      ms: Date.now() - started
    };
  }

  const isWin = process.platform === 'win32';
  const wrapped = isWin ? ('chcp 65001>nul & ' + command) : command;
  const file = isWin ? 'cmd.exe' : '/bin/sh';
  const args = isWin ? ['/d', '/s', '/c', wrapped] : ['-c', command];
  const tmp = path.join(workspace, '.tmp');
  try { fs.mkdirSync(tmp, { recursive: true }); } catch (e) {}
  const r = spawnSync(file, args, {
    cwd: workspace,
    timeout: timeoutMs,
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: Math.max(maxOutput * 4, 1024 * 1024),
    env: Object.assign({}, process.env, {
      TMPDIR: tmp, TEMP: tmp,
      DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', ZHIPU_API_KEY: ''
    })
  });
  const out = (decodeOutput(r.stdout) + (r.stderr && r.stderr.length ? '\n' + decodeOutput(r.stderr) : '')).trim();
  return {
    ok: r.status === 0,
    code: r.status == null ? -1 : r.status,
    output: truncateOut(out, maxOutput),
    mode: actual,
    note: note || (actual === 'process' ? '子进程执行，带超时与临时目录' : '直接执行，只靠红线与白名单'),
    timedOut: !!(r.error && r.error.code === 'ETIMEDOUT'),
    ms: Date.now() - started
  };
}

function truncateOut(s, n) { return s.length > n ? s.slice(0, n) + '\n…（输出被截断）' : s; }

function status(mode) {
  const m = normalizeMode(mode);
  const d = dockerAvailable();
  return { configured: m, docker_available: d, effective: m === 'docker' && !d ? 'process' : m };
}

module.exports = { run, status, dockerAvailable, normalizeMode, MODES };
