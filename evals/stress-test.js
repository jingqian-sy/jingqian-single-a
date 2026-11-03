'use strict';
/*
 * 长短记忆 / 长短人格 压力用例（本机假模型，不联网、不碰真实记忆）
 *
 * 验这些：
 *   1) 10 字到 8000 字的记忆都存得进、搜得到、聊天不崩；
 *   2) 长记忆进提示时会被截短（单条 160 字），不会把 8000 字原样塞给模型；
 *   3) 人格 0 / 300 / 2000 / 8000 字都能用，长的会出现在系统提示里；
 *   4) 超过 8000 字的人格在保存时被拒（人话提示），不至于把上下文撑爆；
 *   5) 长人格 + 一屏长记忆 + 20 条历史一起聊，请求能拼出来、大小可控；
 *   6) 超长搜索词不崩；
 *   7) 自动记住超长一句话时，入库会截短，不整段吞。
 *
 *   node evals/stress-test.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 7961;
const MOCK_PORT = 18401;
const B = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '：' + String(detail).slice(0, 200) : '')); }
}
const rep = (ch, n) => ch.repeat(n);

function mockModel() {
  const hits = [];
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (d) => { buf += d; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(buf); } catch (e) {}
      hits.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 }
      }));
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve({
    hits,
    last: () => hits[hits.length - 1],
    close: () => { try { server.close(); } catch (e) {} }
  })));
}

(async () => {
  const mock = await mockModel();
  const dir = path.join(os.tmpdir(), 'jq-stress-' + Date.now());
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  cfg.port = PORT;
  cfg.host = '127.0.0.1';
  cfg.mode = 'chat';
  cfg.providers = [{ name: 'mock', base: 'http://127.0.0.1:' + MOCK_PORT + '/v1/chat/completions', model: 'mock', key: 'local', tier: 'local', enabled: true }];
  cfg.route = { mode: 'fixed', order: ['mock'], escalate: false, maxSteps: 1 };
  cfg.memory = Object.assign({}, cfg.memory, { autoCapture: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { JQ_CONFIG: path.join(dir, 'config.json'), JQ_DATA_DIR: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(B + '/api/selfcheck'); if (r.ok) { up = true; break; } } catch (e) {}
    await sleep(150);
  }
  if (!up) {
    console.log('  ✗ 临时服务起不来：' + log.slice(0, 300));
    try { child.kill(); } catch (e) {}
    process.exit(1);
  }
  const get = (p) => fetch(B + p).then((r) => r.json());
  const post = (p, body) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const chat = (message, extra) => post('/api/chat', Object.assign({ message, session: 'stress' }, extra || {}));

  // 1) 不同长度的记忆都存得进
  const lengths = [10, 120, 400, 2000, 8000];
  const texts = [];
  for (const n of lengths) {
    const t = '橙子试验' + n + '：' + rep('记', Math.max(1, n - 12));
    texts.push(t);
    const r = await post('/api/memory', { text: t, kind: 'fact', importance: 3 });
    ok(r.ok && r.item && r.item.text.length === t.length, n + ' 字记忆存进去了', r.error || (r.item && r.item.text.length));
  }
  const all = await get('/api/memory?limit=100&offset=0');
  ok(all.count >= lengths.length, '列表里数得出来', all.count);

  // 2) 长记忆进提示会被截短
  await chat('橙子试验8000 是什么？');
  const req = mock.last();
  const blob = JSON.stringify(req && req.messages || []);
  const promptMsg = (req.messages || []).map((m) => String(m.content || '')).join('\n');
  ok(blob.indexOf(rep('记', 500)) < 0, '8000 字记忆没有原样塞进提示', 'len=' + blob.length);
  const hitLine = promptMsg.split('\n').find((l) => l.indexOf('橙子试验8000') >= 0) || '';
  ok(hitLine.length > 0 && hitLine.length <= 220, '提示里单条记忆有截短（≤220 字）', hitLine.length);

  // 2b) 接口写进来的「我的…」要按「用户的…」存，问起来才认（不然被当成她自己的事）
  const addBirthday = await post('/api/memory', { text: '我的生日是 3 月 14 日。', kind: 'fact', importance: 4 });
  ok(addBirthday.ok && /用户.*生日/.test(String(addBirthday.item && addBirthday.item.text)), '接口记忆也转成第三人称存', addBirthday.item && addBirthday.item.text);
  await chat('我生日是哪天？');
  const askedMsg = String((mock.last().messages || []).slice(-1)[0].content || '');
  ok(/生日是\s*3\s*月\s*14/.test(askedMsg), '问自己的生日时记忆真的送进去了', askedMsg.slice(0, 300));
  ok(askedMsg.indexOf('记忆里没有这条') < 0, '不再误说「记忆里没有这条」', askedMsg.slice(0, 200));

  // 3) 人格 0 / 300 / 2000 / 8000 字
  for (const n of [0, 300, 2000, 8000]) {
    const head = '人格试验' + n + '：';
    const persona = n === 0 ? '' : head + rep('像', Math.max(0, n - head.length));
    const r = await post('/api/config', { persona });
    ok(r.ok === true, n + ' 字人格存得进', JSON.stringify(r).slice(0, 120));
    await chat('随口感一句');
    const sys = String((mock.last().messages || [])[0].content || '');
    if (n === 0) ok(sys.indexOf('鲸倩') >= 0, '空人格回落到内置默认', sys.slice(0, 20));
    else ok(sys.indexOf('人格试验' + n) >= 0 && sys.length >= n, n + ' 字人格进了系统提示', sys.length);
  }

  // 4) 超长人格要拒（8000 是上限）
  const tooLong = await post('/api/config', { persona: rep('超', 9000) });
  ok(tooLong.ok === false && /人格/.test(String(tooLong.error || '')), '超长人格保存被拒并说明原因', JSON.stringify(tooLong).slice(0, 160));
  const after = await get('/api/config');
  ok(String(after.config.persona || '').indexOf('超') < 0, '被拒的人格没有偷偷存进去', String(after.config.persona || '').length);

  // 5) 长人格 + 长记忆 + 20 条历史：拼得出来、大小可控
  const bigHead = '人格很长：';
  await post('/api/config', { persona: bigHead + rep('稳', 8000 - bigHead.length) });
  for (let i = 0; i < 10; i++) await chat('第 ' + i + ' 句闲聊，用来垫历史');
  const big = await chat('橙子试验2000 你还记得吗？');
  ok(big.ok === true, '长人格 + 长记忆 + 20 条历史还能正常答', JSON.stringify(big.error || '').slice(0, 120));
  const bigBlob = JSON.stringify(mock.last());
  ok(bigBlob.length < 200000, '请求体没失控（< 200k 字符）', bigBlob.length);

  // 6) 超长搜索词
  const longQ = await get('/api/memory?query=' + encodeURIComponent(rep('问', 2000)));
  ok(longQ.ok === true, '2000 字搜索词不崩', JSON.stringify(longQ).slice(0, 120));

  // 7) 自动记住超长一句话：入库截短
  await chat('记住：' + rep('长', 500));
  const list2 = await get('/api/memory?limit=100&offset=0');
  const captured = (list2.items || []).find((x) => String(x.text || '').indexOf('长长长') >= 0);
  ok(captured && captured.text.length <= 160, '超长自动记忆入库会截短（≤160 字）', captured && captured.text.length);

  try { child.kill(); } catch (e) {}
  mock.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  console.log('\n长短记忆/人格用例：' + pass + '/' + (pass + fail) + ' 通过');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('用例自己崩了：', e);
  process.exit(1);
});
