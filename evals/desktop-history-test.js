'use strict';
/*
 * 软件版「启动铺历史气泡」回归测试（一条命令）
 *
 *   node evals/desktop-history-test.js
 *
 * 它跑的是正常启动路径（MainForm.Shown → 等服务 → LoadHistoryWithRetry），
 * 只是窗口放在屏幕外、抓完立刻关，不打扰人。
 * 断言：bubbles > 0、截图文件存在且不是空白（文件大小 > 5KB）、退出码 0。
 * 服务没起会自己拉（和双击启动一样）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'desktop', '鲸倩.exe');
const SHOT = path.join(ROOT, 'desktop', '_verify-history.png');

if (!fs.existsSync(EXE)) {
  console.error('✗ 没有 desktop\\鲸倩.exe，先跑 desktop\\build-desktop.cmd');
  process.exit(1);
}

const r = spawnSync(EXE, ['--dump-bubbles', '--shot', SHOT], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 120000,
  windowsHide: true,
  env: Object.assign({}, process.env, { JQ_SHELL_OFFSCREEN: '1' })
});
const out = String(r.stdout || '') + String(r.stderr || '');
console.log(out.trim());

const m = out.match(/bubbles=(\d+)/);
const bubbles = m ? Number(m[1]) : 0;
const shotOk = fs.existsSync(SHOT) && fs.statSync(SHOT).size > 5000;

const checks = {
  'bubbles > 0（服务里有历史就铺出来）': bubbles > 0,
  '退出码 0': r.status === 0,
  '截图存在且非空白': shotOk
};
let fail = 0;
for (const [k, v] of Object.entries(checks)) {
  if (!v) fail++;
  console.log('  ' + (v ? '✓' : '✗') + ' ' + k);
}
console.log('软件版历史气泡测试：' + (fail === 0 ? '通过' : '失败 ' + fail + ' 项') + '（bubbles=' + bubbles + '）');
process.exit(fail === 0 ? 0 : 1);
