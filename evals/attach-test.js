'use strict';
/*
 * 附件测试（拖文件/图片进输入栏的底层）：全程本机，不联网，验七件：
 *   1) 文本文件：内容读进来、拼进附件块；超长只读前 N KB，并标「截掉了」；
 *   2) 二进制文件：不硬读，只登记名字；
 *   3) 图片：读出 data URL（image/png），带 mime；
 *   4) 不存在的文件 / 文件夹：进 skipped，不抛异常；
 *   5) 一次超过 maxFiles：只收前几个，其余 skipped；
 *   6) 服务端 /api/chat 带文本附件：模型真的收到了附件内容；
 *   7) 非视觉模型带图片：回一句实话（看不了图），不去打模型；换成 vision:true 的提供方后，图片以多模态数组发出去。
 *
 *   node evals/attach-test.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const attach = require(path.join(ROOT, 'src', 'attach.js'));
const TMP = path.join(__dirname, '.run', 'attach-test');
const APP_PORT = 7908;
const MOCK_PORT = 18082;

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')); }
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function waitServer(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch('http://127.0.0.1:' + APP_PORT + '/api/selfcheck'); if (r.ok) return true; } catch (e) {}
    await sleep(150);
  }
  return false;
}

function mockModel() {
  const m = { hits: 0, lastBody: null, reply: '收到，看过了。' };
  m.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      m.hits++;
      try { m.lastBody = JSON.parse(raw); } catch (e) { m.lastBody = null; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: m.reply } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
      }));
    });
  });
  return new Promise((r) => m.server.listen(MOCK_PORT, '127.0.0.1', () => r(m)));
}

function startApp(cfgFile, dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(APP_PORT), JQ_CONFIG: cfgFile, JQ_DATA_DIR: dataDir
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  return { child, getOut: () => out };
}

function writeCfg(provider, extra) {
  const cfgFile = path.join(TMP, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(Object.assign({
    port: APP_PORT,
    providers: [Object.assign({
      name: 'mock', tier: 'local', base: 'http://127.0.0.1:' + MOCK_PORT + '/v1/chat/completions',
      model: 'mock-1', key: 'local'
    }, provider)],
    route: { mode: 'fixed', order: ['mock'], maxSteps: 1 },
    tools: { workspace: 'data/workspace' },
    qq: { enabled: false, allow: [], groups: [] },
    memory: { autoCapture: false, writeEvents: false },
    budget: { perCallSeconds: 10, perTaskSeconds: 20 }
  }, extra || {}), null, 2), 'utf8');
  return cfgFile;
}

(async () => {
  rmrf(TMP);
  fs.mkdirSync(path.join(TMP, 'data', 'workspace'), { recursive: true });
  const txt = path.join(TMP, '日志.txt');
  fs.writeFileSync(txt, '第一行：一切正常\n第二行：磁盘剩 3.2GB\n', 'utf8');
  const big = path.join(TMP, 'big.log');
  fs.writeFileSync(big, 'x'.repeat(5000), 'utf8');
  const bin = path.join(TMP, 'a.bin');
  fs.writeFileSync(bin, Buffer.from([0, 1, 2, 3, 0, 255]));
  const png = path.join(TMP, 'shot.png');
  fs.writeFileSync(png, PNG_1PX);

  // ---- 1/2/3. 模块级 ----
  const d = attach.describe([txt, big, bin, png], { maxTextBytes: 1000 });
  const fTxt = d.files.find((f) => f.name === '日志.txt');
  const fBig = d.files.find((f) => f.name === 'big.log');
  const fBin = d.files.find((f) => f.name === 'a.bin');
  ok(fTxt && fTxt.kind === 'text' && fTxt.text.indexOf('第一行') >= 0, '文本文件内容读进来了');
  ok(fTxt && d.block.indexOf('第一行：一切正常') >= 0, '附件块里有正文');
  ok(fBig && fBig.truncated === true && fBig.text.length === 1000, '超长文本只读前 1000 字节并标截断', JSON.stringify(fBig && { t: fBig.truncated, n: fBig.text.length }));
  ok(fBin && fBin.kind === 'other' && !fBin.text, '二进制文件不硬读内容');
  ok(d.images.length === 1 && /^data:image\/png;base64,iVBOR/.test(d.images[0].dataUrl), '图片读成 image/png 的 data URL');
  ok(d.files.find((f) => f.name === 'shot.png').kind === 'image', '图片被标成 image');

  // ---- 4/5. 边界 ----
  const d2 = attach.describe([path.join(TMP, '没这个.txt'), TMP]);
  ok(d2.files.length === 0 && d2.skipped.length === 2, '不存在的文件和文件夹都进 skipped，不崩');
  const many = [];
  for (let i = 0; i < 9; i++) { const p = path.join(TMP, 'm' + i + '.txt'); fs.writeFileSync(p, 'n' + i); many.push(p); }
  const d3 = attach.describe(many, { maxFiles: 3 });
  ok(d3.files.length === 3 && d3.skipped.length === 6, '超过上限只收前 3 个', d3.files.length + '/' + d3.skipped.length);

  // ---- 6. 服务端：文本附件进模型 ----
  const mock = await mockModel();
  try {
    let app = startApp(writeCfg({}), path.join(TMP, 'data'));
    ok(await waitServer(8000), '服务起得来（文本附件）');
    // 回归：中控台必须读写 JQ_CONFIG 指的那份配置，别串到仓库里的 config.json
    const cfgGet = await (await fetch('http://127.0.0.1:' + APP_PORT + '/api/config')).json();
    const p0 = cfgGet && cfgGet.config && cfgGet.config.providers && cfgGet.config.providers[0];
    ok(p0 && p0.name === 'mock', '中控台读的是 JQ_CONFIG 指定的配置（不串到仓库 config.json）', JSON.stringify(p0 && p0.name));
    const r1 = await (await fetch('http://127.0.0.1:' + APP_PORT + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '看看这个日志', attachments: [txt] })
    })).json();
    ok(r1.ok === true, '带附件聊天返回 ok', JSON.stringify(r1).slice(0, 120));
    const sent = JSON.stringify((mock.lastBody && mock.lastBody.messages) || []);
    ok(sent.indexOf('磁盘剩 3.2GB') >= 0, '模型收到的请求里真的有附件正文');
    ok(r1.attachments && r1.attachments.length === 1, '响应里带上了附件清单');

    // ---- 7a. 非视觉模型 + 图片：给实话，不打模型 ----
    const before = mock.hits;
    const r2 = await (await fetch('http://127.0.0.1:' + APP_PORT + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '这图里写了啥', attachments: [png] })
    })).json();
    ok(r2.ok === true && /看不了图片/.test(r2.reply), '非视觉模型收到图片时说实话', r2.reply);
    ok(mock.hits === before, '非视觉模型不会被硬塞图片（没发请求）', String(mock.hits - before));

    // 坏路径：明确拒绝
    const r3 = await (await fetch('http://127.0.0.1:' + APP_PORT + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '看这个', attachments: [path.join(TMP, '不存在.zip')] })
    })).json();
    ok(r3.ok === false && r3.code === 'ATTACH_FAILED', '附件全读不了时明确报错，不空转');
    app.child.kill();
    await sleep(300);

    // ---- 7b. vision:true 的提供方：图片真的以多模态数组发出去 ----
    app = startApp(writeCfg({ vision: true }), path.join(TMP, 'data2'));
    ok(await waitServer(8000), '服务起得来（视觉提供方）');
    mock.hits = 0;
    const r4 = await (await fetch('http://127.0.0.1:' + APP_PORT + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '这图里写了啥', attachments: [png] })
    })).json();
    ok(r4.ok === true && mock.hits === 1, '视觉提供方这轮会真的调模型', JSON.stringify(r4).slice(0, 100));
    const last = (mock.lastBody.messages || []).slice(-1)[0];
    ok(last && Array.isArray(last.content) && last.content.some((c) => c.type === 'image_url' && /^data:image\/png;base64,/.test(c.image_url.url)),
      '图片以 image_url 多模态数组发出去了');
    app.child.kill();
  } finally {
    mock.server.close();
  }

  console.log('\n附件用例：' + pass + '/' + (pass + fail) + ' 通过');
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
