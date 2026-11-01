'use strict';
/*
 * QQ 适配层测试：起一个假 OneBot 网关 + 真起本机服务（mock 模型），验四件事：
 *   1) 入方向：白名单私聊能拿到真的回复；
 *   2) 出方向：/api/qq/send 真的打到假网关（并带 token）；
 *   3) 白名单外：拒收、不调模型；
 *   4) 群里没 @/点名：不理（不刷屏）。
 * 全程不联网、不需要密钥；跑完清理现场。
 *
 *   node evals/qq-test.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { start: startMock } = require('./mock-provider');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'data', 'qq-test');
const MOCK_PORT = 18096;
const GATEWAY_PORT = 18095;
const APP_PORT = 7902;

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function get(url, opts) {
  const r = await fetch(url, opts);
  return r.json();
}

async function waitServer(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const j = await get('http://127.0.0.1:' + APP_PORT + '/api/selfcheck'); if (j && j.at) return true; } catch (e) {}
    await sleep(300);
  }
  return false;
}

async function main() {
  rmrf(TMP);
  fs.mkdirSync(path.join(TMP, 'data', 'workspace'), { recursive: true });

  const got = [];
  const gateway = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      got.push({ url: req.url, auth: req.headers.authorization || '', body: raw });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 } }));
    });
  });
  await new Promise((r) => gateway.listen(GATEWAY_PORT, '127.0.0.1', r));
  const mock = await startMock({ port: MOCK_PORT });

  const cfg = {
    port: APP_PORT,
    host: '127.0.0.1',
    providers: [{ name: 'mock', tier: 'local', base: 'http://127.0.0.1:' + MOCK_PORT + '/v1/chat/completions', model: 'mock-1', key: 'local', price_in: 0, price_out: 0 }],
    route: { mode: 'fixed', order: ['mock'], escalate: false, maxSteps: 5 },
    memory: { autoCapture: true },
    tools: { workspace: 'data/workspace', allowCommand: true, commandWhitelist: ['echo'], commandTimeoutMs: 10000, maxOutput: 4000 },
    sandbox: { mode: 'none' },
    budget: { perCallSeconds: 20, perTaskSeconds: 60, perTaskTokens: 20000 },
    qq: { enabled: true, gateway: 'http://127.0.0.1:' + GATEWAY_PORT, token: 'test-token', allow: ['1001'], groups: ['2001'], self_id: '999' },
    temperature: 0
  };
  const cfgFile = path.join(TMP, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8');

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(APP_PORT), JQ_CONFIG: cfgFile, JQ_DATA_DIR: 'data/qq-test/data' }),
    stdio: 'ignore',
    windowsHide: true
  });

  const checks = {};
  let fail = 0;
  const t0 = Date.now();
  try {
    if (!await waitServer(20000)) throw new Error('服务没起来');
    const base = 'http://127.0.0.1:' + APP_PORT;

    // 1) 入方向：白名单私聊
    const r1 = await get(base + '/api/qq/incoming', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 1001, raw_message: '你好，一句话介绍自己' })
    });
    checks['入方向：白名单私聊拿到回复'] = !!(r1.ok && String(r1.reply || '').trim());
    if (!checks['入方向：白名单私聊拿到回复']) fail++;

    // 2) 出方向：主动发送打到假网关
    const r2 = await get(base + '/api/qq/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 1001, text: '这是主动发出去的一条' })
    });
    const hit = got.find((g) => g.url.indexOf('/send_private_msg') >= 0);
    checks['出方向：假网关真收到'] = !!(r2.ok && hit && hit.body.indexOf('这是主动发出去的') >= 0);
    checks['出方向：带了 access_token'] = !!(hit && hit.auth === 'Bearer test-token');
    if (!checks['出方向：假网关真收到'] || !checks['出方向：带了 access_token']) fail++;

    // 3) 白名单外：拒收
    const r3 = await get(base + '/api/qq/incoming', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 1002, raw_message: '你好' })
    });
    checks['白名单外被拒'] = !!(r3.ok === false && r3.ignored === true);
    if (!checks['白名单外被拒']) fail++;

    // 4) 群里没 @/点名：不回
    const r4 = await get(base + '/api/qq/incoming', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 2001, user_id: 1001, raw_message: '今天中午吃什么' })
    });
    checks['群里没 @ 不回'] = !!(r4.ok === false && r4.ignored === true);
    if (!checks['群里没 @ 不回']) fail++;

    // 5) （附加）群里 @ 了就回
    const r5 = await get(base + '/api/qq/incoming', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 2001, user_id: 1001, raw_message: '[CQ:at,qq=999] 在吗' })
    });
    checks['群里 @ 了会回'] = !!(r5.ok && String(r5.reply || '').trim());
    if (!checks['群里 @ 了会回']) fail++;

    checks['qq.log 有记录'] = fs.existsSync(path.join(ROOT, 'data', 'qq-test', 'data', 'qq.log'));
    if (!checks['qq.log 有记录']) fail++;
  } catch (e) {
    console.log('失败：' + e.message);
    fail++;
  } finally {
    try { child.kill('SIGKILL'); } catch (e) {}
    try { mock.close(); } catch (e) {}
    try { gateway.close(); } catch (e) {}
  }

  for (const [k, v] of Object.entries(checks)) console.log('  ' + (v ? '✓' : '✗') + ' ' + k);
  console.log('QQ 适配层测试：' + (fail === 0 ? '通过' : '失败 ' + fail + ' 项') + '（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e.stack); process.exit(1); });
