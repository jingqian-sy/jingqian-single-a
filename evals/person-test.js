'use strict';
/*
 * 人称多角度用例：记忆从哪条路进来、怎么存、怎么进提示、怎么被问出来。
 *
 * 验这些（本机假模型，不联网、不碰真实记忆）：
 *   1) 接口写进来的「我的…」→ 存成「用户的…」；
 *   2) 聊天里「记住：我…」也走同一套人称；
 *   3) 问自己的事时，带主语 / 不带主语 / 提到家人的记忆都能送进提示，
 *      不能误判成「记忆里没有这条」；
 *   4) 进提示的记忆一律换成「他」，不能出现「用户/老爸」；
 *   5) 问「你叫什么名字」不算问他自己，不该套「没记着」的说法；
 *   6) 多个人名下的同义记忆不能互相顶掉（老王家的猫和大人的猫各叫各的）。
 *
 *   node evals/person-test.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const { Store } = require('../src/memory/store');
const { recall } = require('../src/memory/retrieve');

const ROOT = path.join(__dirname, '..');
const PORT = 7962;
const MOCK_PORT = 18402;
const B = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '：' + String(detail).slice(0, 200) : '')); }
}

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
    last: () => hits[hits.length - 1],
    close: () => { try { server.close(); } catch (e) {} }
  })));
}

(async () => {
  // ---------- 单元：多人之间的同义记忆不能互相顶掉 ----------
  const uDir = path.join(os.tmpdir(), 'jq-person-unit-' + Date.now());
  fs.mkdirSync(uDir, { recursive: true });
  const st = new Store(uDir);
  st.add({ text: '老王的猫叫团子', kind: 'fact', importance: 3, person: 'p_wang' });
  st.add({ text: '用户的猫叫团子', kind: 'fact', importance: 3, person: 'owner' });
  const alive = st.active().map((x) => x.text);
  ok(alive.indexOf('老王的猫叫团子') >= 0, '老王家的猫没被顶掉', JSON.stringify(alive));
  ok(alive.indexOf('用户的猫叫团子') >= 0, '大人家的猫也在', JSON.stringify(alive));
  try { fs.rmSync(uDir, { recursive: true, force: true }); } catch (e) {}

  // 别人名下的事要单独成段，不能混进「他的事实」或「你俩的回忆」
  const uDir2 = path.join(os.tmpdir(), 'jq-person-unit2-' + Date.now());
  fs.mkdirSync(uDir2, { recursive: true });
  const st2 = new Store(uDir2);
  st2.add({ text: '用户的女儿叫小雨', kind: 'fact', importance: 4, person: 'owner' });
  st2.add({ text: '老王家的猫叫团子', kind: 'fact', importance: 4, person: 'p_wang' });
  const rb = await recall(st2, '老王家的猫', { topK: 8, scope: 'all' });
  ok(/【关于别人】/.test(rb.block) && /老王家的猫/.test(rb.block), '别人家的事单独成段', rb.block.slice(0, 200));
  ok(!/【你俩之间的回忆片段】[\s\S]*老王家的猫/.test(rb.block), '别人家的事没被当成你俩的回忆', rb.block.slice(0, 240));
  ok(!/【关于他的事实】[\s\S]*老王家的猫/.test(rb.block), '别人家的事没被当成他的', rb.block.slice(0, 240));
  try { fs.rmSync(uDir2, { recursive: true, force: true }); } catch (e) {}

  // 说的是「你」的事（她自己的喜好），不能算成他的事实
  const uDir3 = path.join(os.tmpdir(), 'jq-person-unit3-' + Date.now());
  fs.mkdirSync(uDir3, { recursive: true });
  const st3 = new Store(uDir3);
  st3.add({ text: '你喜欢吃草莓', kind: 'preference', importance: 4, person: 'owner' });
  const rb3 = await recall(st3, '草莓 喜欢', { topK: 8, scope: 'all' });
  ok(rb3.block.indexOf('草莓') >= 0, '她自己的喜好能召回到', rb3.block.slice(0, 200));
  ok(!/【关于他的事实】[\s\S]*草莓/.test(rb3.block), '她自己的喜好没被当成他的事实', rb3.block.slice(0, 240));
  try { fs.rmSync(uDir3, { recursive: true, force: true }); } catch (e) {}

  // ---------- 服务端：入库 → 提示 → 提问 ----------
  const mock = await mockModel();
  const dir = path.join(os.tmpdir(), 'jq-person-' + Date.now());
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  cfg.port = PORT;
  cfg.host = '127.0.0.1';
  cfg.mode = 'chat';
  cfg.providers = [{ name: 'mock', base: 'http://127.0.0.1:' + MOCK_PORT + '/v1/chat/completions', model: 'm', key: 'local', tier: 'local', enabled: true }];
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
  if (!up) { console.log('  ✗ 临时服务起不来：' + log.slice(0, 300)); try { child.kill(); } catch (e) {} process.exit(1); }

  const post = (p, body) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const get = (p) => fetch(B + p).then((r) => r.json());
  const ask = (q) => post('/api/chat', { message: q, session: 'pt-' + Math.random().toString(36).slice(2, 7) });

  for (const text of [
    '我的生日是 3 月 14 日。',
    '我的车牌号是 B7-8899。',
    '周末去打球。',
    '我喜欢喝咖啡。',
    '我妈生日是 5 月 1 日。'
  ]) {
    await post('/api/memory', { text, kind: 'fact', importance: 3 });
  }
  // 聊天里记一条，走自动记忆那条路
  await ask('记住：我每周三晚上打羽毛球');
  const listed = await get('/api/memory?limit=100&offset=0');
  const texts = (listed.items || []).map((x) => String(x.text));
  ok(texts.some((t) => /^用户的生日/.test(t)), '接口的「我的生日」存成用户的', JSON.stringify(texts.filter((t) => t.indexOf('生日') >= 0)));
  ok(texts.some((t) => /^用户的每周三|^用户每周三/.test(t)), '聊天的「记住：我…」也存成第三人称', JSON.stringify(texts.filter((t) => t.indexOf('每周三') >= 0)));
  ok(texts.some((t) => t === '周末去打球。' || t === '周末去打球'), '没主语的事按原样存', JSON.stringify(texts.filter((t) => t.indexOf('周末') >= 0)));

  const promptOf = async (q) => {
    await ask(q);
    return String(((mock.last() || {}).messages || []).slice(-1)[0].content || '');
  };

  let p = await promptOf('我生日是哪天？');
  ok(/生日是\s*3\s*月\s*14/.test(p), '问生日：关于他的事实在提示里', p.slice(0, 200));
  ok(p.indexOf('记忆里没有这条') < 0, '问生日：不误判成没记着', p.slice(0, 200));

  p = await promptOf('我的车牌号是多少？');
  ok(/B7-?8899/i.test(p), '问车牌：记忆在提示里', p.slice(0, 200));

  p = await promptOf('我周末干嘛？');
  ok(/周末去打球/.test(p), '没主语的记忆也能算他的、送进提示', p.slice(0, 240));
  ok(p.indexOf('记忆里没有这条') < 0, '不至于因为没主语就说没记着', p.slice(0, 200));

  p = await promptOf('我喜欢喝什么？');
  ok(/喝咖啡/.test(p), '问喜好：偏好记忆在提示里', p.slice(0, 200));

  p = await promptOf('我妈生日是哪天？');
  ok(/5\s*月\s*1|五月一/.test(p), '问家人：家人的记忆在提示里', p.slice(0, 220));

  p = await promptOf('你叫什么名字？');
  ok(p.indexOf('记忆里没有这条') < 0, '问她自己名字时，不套「没记着」的说法', p.slice(0, 200));
  const sys = String(((mock.last() || {}).messages || [])[0].content || '');
  ok(/你叫什么名字|你是谁/.test(sys) && /鲸倩/.test(sys), '人格里写清「你叫什么」问的是她本人', sys.slice(0, 160));
  ok(sys.indexOf('「你」永远指他') < 0, '没有「你永远指他」这种会听岔的说法', sys.slice(0, 160));
  // 问到别的事时，身份说明不该常驻（小模型会抓着它答「我叫鲸倩」）
  p = await promptOf('我的车位号是多少？');
  const sys2 = String(((mock.last() || {}).messages || [])[0].content || '');
  ok(sys2.indexOf('【你是谁】') < 0, '问车位时没带身份说明、不抢答', sys2.slice(-80));

  // 进提示的记忆行里不能出现「用户/老爸」这种第三人称（说明文案里会提到这两个字，不算）
  p = await promptOf('我生日是哪天？');
  const memLines = p.split('\n').filter((l) => /^-\s/.test(l)).join('\n');
  ok(memLines.length > 0 && !/用户|老爸/.test(memLines), '进提示的记忆行都换成了「他」', memLines.slice(0, 300));
  ok(/他.*生日|生日.*3\s*月\s*14/.test(memLines), '记忆行里说的是他的生日', memLines.slice(0, 200));

  try { child.kill(); } catch (e) {}
  mock.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  console.log('\n人称用例：' + pass + '/' + (pass + fail) + ' 通过');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('用例自己崩了：', e);
  process.exit(1);
});
