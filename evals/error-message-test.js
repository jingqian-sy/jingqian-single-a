'use strict';
/*
 * 报错文案用例：全挂的时候说人话，别把 HTTP 码和 Node 报错甩给用户。
 *
 * 验九件（全程本机假服务，不联网、不碰真实记忆）：
 *   1) 一家 401 + 一家连不上：原因要分开说，不能一句「key 不对」糊住；
 *   2) 全是 500：说「服务器错误」，别说 key；
 *   3) 全是连不上：说「连不上」，让他查网络；
 *   4) 只有一家 401：用「这家」而不是「几家」；
 *   5) 选模型问不到列表：说「key 不对」，别丢裸 HTTP 码；
 *   6) 选了不支持工具调用的家：说清楚「不支持工具调用」，不是「没填 key」；
 *   7) 端口被占：人话提示，不出现 Node 的 EADDRINUSE 调用栈；
 *   8) /api/route 的 provider 清单带 tools 标记（界面靠它标「不支持工具」）。
 *
 * 每个场景单起一份临时服务 + 临时数据目录，测完删干净。
 *
 *   node evals/error-message-test.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')); }
}

function mock(port, code, body) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

function pv(name, port, extra) {
  return Object.assign({
    name,
    base: 'http://127.0.0.1:' + port + '/v1/chat/completions',
    model: 'mock',
    key: 'x',
    tier: 'cloud',
    price_in: 1,
    price_out: 1,
    enabled: true,
    tools: true
  }, extra || {});
}

// 起一份独立服务：自己的 config + 数据目录 + 端口
async function scenario(port, providers) {
  const dir = path.join(os.tmpdir(), 'jq-errmsg-' + port + '-' + Date.now());
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  base.port = port;
  base.host = '127.0.0.1';
  // 这些用例都在验「干活模式」的报错；仓库 config.json 的默认模式可能是对话
  base.mode = 'work';
  base.modes = { desktop: 'work', qq: 'work', mcp: 'work' };
  base.providers = providers;
  base.route = { mode: 'fixed', order: providers.map((p) => p.name), escalate: false, maxSteps: 3 };
  base.memory.autoCapture = false;
  base.budget = Object.assign({}, base.budget, { perTaskSeconds: 60 });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(base, null, 2), 'utf8');

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      JQ_CONFIG: path.join(dir, 'config.json'),
      JQ_DATA_DIR: path.join(dir, 'data')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });

  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/api/selfcheck'); if (r.ok) { up = true; break; } } catch (e) {}
    await sleep(150);
  }
  return {
    port,
    up,
    log: () => out,
    dir,
    chat: async (message, session) => {
      const r = await fetch('http://127.0.0.1:' + port + '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, session })
      });
      return r.json();
    },
    route: () => fetch('http://127.0.0.1:' + port + '/api/route').then((r) => r.json()),
    kill: () => { try { child.kill(); } catch (e) {} },
    clean: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  };
}

(async () => {
  const m401 = await mock(18251, 401, { error: { message: 'invalid api key' } });
  const m500 = await mock(18252, 500, { error: { message: 'internal server error' } });
  const m402 = await mock(18254, 402, { error: { message: 'Insufficient Balance' } });
  // 18253 什么都不起，当「断网」

  // 场景一：一家 key 错 + 一家连不上（原因不同要分开说）
  let s = await scenario(7925, [pv('key错', 18251), pv('连不上', 18253)]);
  ok(s.up, '临时服务起得来', s.log().slice(0, 300));
  if (s.up) {
    let r = await s.chat('你好', 'e1');
    ok(r.ok === false && /key 不对或没权限/.test(r.error), '401 说 key 不对', r.error);
    ok(/连不上/.test(r.error), '同一句里也说清连不上的那家', r.error);
    ok(/；/.test(r.error), '原因不同就分开列，不糊成一句', r.error);
    // 选模型时问列表失败，也要说人话
    const ml = await fetch('http://127.0.0.1:' + s.port + '/api/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'key错' })
    }).then((x) => x.json());
    ok(ml.ok === false && /key 不对或没权限/.test(ml.error), '列表问不到时说 key 不对', ml.error);
    ok(!/HTTP 401$/.test(ml.error), '不把裸 HTTP 码丢给人', ml.error);
  }
  s.kill(); s.clean();

  // 场景二：全是 500
  s = await scenario(7926, [pv('服务器错', 18252)]);
  if (s.up) {
    const r = await s.chat('你好', 'e2');
    ok(r.ok === false && /服务器出错/.test(r.error), '500 说服务器出错', r.error);
    ok(!/key/.test(r.error), '500 不误报 key 不对', r.error);
  }
  s.kill(); s.clean();

  // 场景三：全是连不上
  s = await scenario(7927, [pv('断网', 18253)]);
  if (s.up) {
    const r = await s.chat('你好', 'e3');
    ok(/连不上/.test(r.error), '断网说连不上', r.error);
    ok(/网络/.test(r.error), '断网给下一步：看网络', r.error);
  }
  s.kill(); s.clean();

  // 场景四：只有一家 401（用「这家」）
  s = await scenario(7928, [pv('key错', 18251)]);
  if (s.up) {
    const r = await s.chat('你好', 'e4');
    ok(/这家说/.test(r.error), '只有一家时用「这家」', r.error);
  }
  s.kill(); s.clean();

  // 场景四之二：余额不足（402）算额度，不算 key
  s = await scenario(7931, [pv('没余额', 18254)]);
  if (s.up) {
    const r = await s.chat('你好', 'e4b');
    ok(/额度/.test(r.error), '402 余额不足算额度用完', r.error);
    ok(!/key 不对/.test(r.error), '402 不误报 key 不对', r.error);
  }
  s.kill(); s.clean();

  // 场景五：只有一家、还不支持工具 —— 要说清原因，不能说成没填 key
  s = await scenario(7929, [pv('不带工具', 18252, { tools: false })]);
  if (s.up) {
    const r = await s.chat('你好', 'e5');
    ok(r.ok === false && /不支持工具/.test(r.error), '选了不带工具的家说清楚原因', r.error);
    ok(!/填一家云端 key/.test(r.error), '不误说成「没配 key」', r.error);
    const j = await s.route();
    const list = (j.providers || []);
    ok(list.length > 0 && list.every((p) => typeof p.tools === 'boolean'), 'provider 清单带 tools 标记', JSON.stringify(list.slice(0, 2)));
    ok(list.some((p) => p.name === '不带工具' && p.tools === false), '不带工具的家标成 false', JSON.stringify(list));
  }

  // 场景六：端口被占（同一份 config 再起一份）
  if (s.up) {
    const dup = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        JQ_CONFIG: path.join(s.dir, 'config.json'),
        JQ_DATA_DIR: path.join(s.dir, 'data')
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let dupOut = '';
    dup.stdout.on('data', (d) => { dupOut += String(d); });
    dup.stderr.on('data', (d) => { dupOut += String(d); });
    await sleep(2500);
    ok(/已经被占用/.test(dupOut), '端口被占说人话', dupOut.slice(-200));
    ok(!/Emitted 'error' event|node:net/.test(dupOut), '端口被占不甩 Node 调用栈', dupOut.slice(-200));
    try { dup.kill(); } catch (e) {}
  }
  s.kill(); s.clean();

  m401.close(); m500.close(); m402.close();
  console.log('\n报错文案用例：' + pass + '/' + (pass + fail) + ' 通过');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('用例自己崩了：', e);
  process.exit(1);
});
