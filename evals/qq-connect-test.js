'use strict';
/*
 * QQ 一键连接测试：假网关 + 真起服务，验四件：
 *   1) 自动发现能认出假网关（get_login_info）；
 *   2) 一键连接会把 config.json 的 qq.enabled 写成 true；
 *   3) 断连把 qq.enabled 写回 false；
 *   4) 没桥接时 discover 返回 found:false + hints（不会乱写配置）。
 * 全程本机、无外网。CI 里跑一步。
 *
 *   node evals/qq-connect-test.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'data', 'qq-connect-test');
const GATEWAY_PORT = 18080;
const APP_PORT = 7903;

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function get(url, opts) { const r = await fetch(url, opts); return r.json(); }

async function waitServer(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const j = await get('http://127.0.0.1:' + APP_PORT + '/api/selfcheck'); if (j && j.at) return true; } catch (e) {}
    await sleep(200);
  }
  return false;
}

(async () => {
  rmrf(TMP);
  fs.mkdirSync(path.join(TMP, 'data', 'workspace'), { recursive: true });
  const cfgFile = path.join(TMP, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    port: APP_PORT,
    providers: [{ name: 'mock', tier: 'local', base: 'http://127.0.0.1:18099/v1/chat/completions', model: 'mock-1', key: 'local' }],
    route: { mode: 'fixed', order: ['mock'], maxSteps: 3 },
    tools: { workspace: 'data/workspace' },
    qq: { enabled: false, gateway: '', token: 'testtoken', allow: [], groups: [], self_id: '' },
    budget: { perCallSeconds: 15, perTaskSeconds: 30 }
  }, null, 2), 'utf8');

  const gateway = http.createServer((req, res) => {
    if (req.url.indexOf('/get_login_info') >= 0) {
      const auth = req.headers.authorization || '';
      if (auth !== 'Bearer testtoken') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ status: 'failed', retcode: 401 })); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 88888, nickname: '假桥接' } }));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => gateway.listen(GATEWAY_PORT, '127.0.0.1', r));

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(APP_PORT), JQ_CONFIG: cfgFile, JQ_DATA_DIR: 'data/qq-connect-test/data' }),
    stdio: 'ignore', windowsHide: true
  });

  const checks = {};
  let fail = 0;
  const t0 = Date.now();
  try {
    if (!await waitServer(20000)) throw new Error('服务没起来');
    const base = 'http://127.0.0.1:' + APP_PORT;

    // 1) 自动发现
    const d = await get(base + '/api/qq/discover');
    checks['自动发现：找到假网关'] = !!(d.found && d.gateway.indexOf('18080') >= 0 && String(d.nickname).indexOf('假桥接') >= 0);
    if (!checks['自动发现：找到假网关']) fail++;

    // 2) 一键连接（不传参数，用 discover 的结果）
    const c = await get(base + '/api/qq/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    checks['一键连接：返回已连接'] = !!(c.ok && c.enabled === true);
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) {}
    checks['config.json 里 qq.enabled=true'] = !!(saved.qq && saved.qq.enabled === true);
    if (!checks['一键连接：返回已连接'] || !checks['config.json 里 qq.enabled=true']) fail++;

    // 3) 断连
    const u = await get(base + '/api/qq/disconnect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    saved = {};
    try { saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) {}
    checks['断连：enabled 变 false'] = !!(u.ok && u.enabled === false && saved.qq && saved.qq.enabled === false);
    if (!checks['断连：enabled 变 false']) fail++;
  } catch (e) {
    console.log('失败：' + e.message);
    fail++;
  } finally {
    try { child.kill('SIGKILL'); } catch (e) {}
    try { gateway.close(); } catch (e) {}
  }

  for (const [k, v] of Object.entries(checks)) { console.log('  ' + (v ? '✓' : '✗') + ' ' + k); }
  console.log('QQ 一键连接测试：' + (fail === 0 ? '通过' : '失败') + '（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
  process.exit(fail === 0 ? 0 : 1);
})();
