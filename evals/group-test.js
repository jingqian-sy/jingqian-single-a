'use strict';
/*
 * 群聊/多人场景用例（本机假模型，不联网、不碰真实记忆）
 *
 * 模拟：老王、小李在群里说话（带 speaker），老爸私聊。
 * 验这些：
 *   1) 群友说「我…」按他名字存、挂在他名下，不写成老爸的事；
 *   2) 老爸问自己的事时，不会把群友的事当成自己的；
 *   3) 问「老王喜欢什么」能从【关于别人】里找到；
 *   4) 群友自己问「我喜欢什么」时，提示里点明说话人是谁，不套「问他本人」的说法；
 *   5) 群里各人的事不串（小李的生日不会跑到老爸名下）。
 *
 *   node evals/group-test.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 7963;
const MOCK_PORT = 18403;
const B = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '：' + String(detail).slice(0, 220) : '')); }
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
  const mock = await mockModel();
  const dir = path.join(os.tmpdir(), 'jq-group-' + Date.now());
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
  const say = async (text, speaker) => {
    const body = { message: text, session: 'g-test' };
    if (speaker) body.speaker = speaker;
    return post('/api/chat', body);
  };
  const promptOf = () => String(((mock.last() || {}).messages || []).slice(-1)[0].content || '');

  await post('/api/people', { name: '老王', aliases: ['老王'], relation: '群友' });
  await post('/api/people', { name: '小李', aliases: ['小李'], relation: '群友' });

  // 群里两条、老爸私聊一条
  await say('记住：我喜欢打篮球', { id: '1001', name: '老王' });
  await say('记住：我下周三生日', { id: '1002', name: '小李' });
  await say('记住：我喜欢喝咖啡', null);

  const mem = await get('/api/memory?limit=100&offset=0');
  const items = mem.items || [];
  const wang = items.find((x) => /老王.*打篮球/.test(String(x.text)));
  const li = items.find((x) => /小李.*生日/.test(String(x.text)));
  const owner = items.find((x) => /用户.*喝咖啡/.test(String(x.text)));
  ok(wang && (wang.person || 'owner') !== 'owner', '群友的事挂在他自己名下', JSON.stringify(wang && { text: wang.text, person: wang.person }));
  ok(li && /^小李/.test(li.text), '另一个群友的事也按名字存', JSON.stringify(li && li.text));
  ok(owner && /^用户/.test(owner.text), '老爸自己的事还是「用户…」', JSON.stringify(owner && owner.text));

  const section = (text, name) => {
    const i = text.indexOf('【' + name + '】');
    if (i < 0) return '';
    const rest = text.slice(i + name.length + 2);
    const j = rest.indexOf('【');
    return j < 0 ? rest : rest.slice(0, j);
  };

  // 1) 老爸问自己：不能把老王的篮球当成自己的
  await say('我喜欢打篮球吗？', null);
  let p = promptOf();
  ok(!/篮球/.test(section(p, '关于他的事实')), '老爸问自己时，群友的篮球不在他的事实里', section(p, '关于他的事实').slice(0, 200));
  ok(!/记忆里没有这条/.test(p) || !/篮球/.test(p), '不会把群友的事当成「有」', p.slice(0, 200));

  // 2) 问老王：应该从【关于别人】里出现
  await say('老王喜欢什么？', null);
  p = promptOf();
  ok(/【关于别人】[\s\S]*老王[\s\S]*篮球|【关于别人】[\s\S]*篮球/.test(p), '问老王能从【关于别人】找到', p.slice(0, 300));

  // 3) 老王自己问「我喜欢什么」：提示里点明说话人，不套「问他本人」
  await say('我喜欢什么？', { id: '1001', name: '老王' });
  p = promptOf();
  ok(/这句是群里「老王」说的/.test(p), '点名说话人是老王', p.slice(0, 200));
  ok(/篮球/.test(p), '老王问自己时他的事在提示里', p.slice(0, 260));
  ok(!/记忆里没有这条/.test(p), '不套「记忆里没有这条」的说法', p.slice(0, 200));

  // 4) 小李的生日不串到老爸名下
  await say('我生日是哪天？', null);
  p = promptOf();
  ok(!/下周三/.test(section(p, '关于他的事实')), '小李的生日没跑到老爸名下', section(p, '关于他的事实').slice(0, 200));

  // 5) 问小李的生日能找到
  await say('小李生日是哪天？', null);
  p = promptOf();
  ok(/小李[\s\S]*下周三|下周三[\s\S]*小李/.test(p), '问小李能找到他的生日', p.slice(0, 300));

  try { child.kill(); } catch (e) {}
  mock.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  console.log('\n群聊多人用例：' + pass + '/' + (pass + fail) + ' 通过');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('用例自己崩了：', e);
  process.exit(1);
});
