'use strict';
/*
 * 对话 / 工作 模式用例（全程本机假模型，不联网、不碰真实记忆）
 *
 *   1) 对话模式：不挂工具，选中的免费家（不支持工具）真被用上；
 *   2) 工作模式：只让带工具的家接，请求里带 tools；
 *   3) 工作模式固定到不带工具的家：直接说清楚，不许偷偷换别家；
 *   4) 工作模式但一家能动手的都没有：说「没有能动手的模型」；
 *   5) 对话模式里说了要动手的活：回一句问要不要切工作模式（stats.suggest_mode=work）；
 *   6) /api/mode 热切换并记得住（重启前的 config 里也有）；
 *   7) 模式参数不合法要拒绝。
 *
 *   node evals/mode-test.js
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

// 假模型：记下每次请求 body，回一句固定的话
function mockModel(port) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (d) => { buf += d; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(buf); } catch (e) {}
      hits.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', model: body && body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 }
      }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    hits,
    close: () => { try { server.close(); } catch (e) {} }
  })));
}

function provider(name, port, extra) {
  return Object.assign({
    name,
    base: 'http://127.0.0.1:' + port + '/v1/chat/completions',
    model: 'mock-' + name,
    key: 'local',
    tier: 'local',
    price_in: 0,
    price_out: 0,
    enabled: true,
    tools: true
  }, extra || {});
}

async function start(port, providers, cfgExtra) {
  const dir = path.join(os.tmpdir(), 'jq-mode-' + port + '-' + Date.now());
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  cfg.port = port;
  cfg.host = '127.0.0.1';
  cfg.providers = providers;
  cfg.route = { mode: 'cheap-first', order: providers.map((p) => p.name), escalate: false, maxSteps: 2 };
  cfg.memory = Object.assign({}, cfg.memory, { autoCapture: false });
  cfg.budget = Object.assign({}, cfg.budget, { perTaskSeconds: 60 });
  Object.assign(cfg, cfgExtra || {});
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      JQ_CONFIG: path.join(dir, 'config.json'),
      JQ_DATA_DIR: path.join(dir, 'data')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/api/selfcheck'); if (r.ok) { up = true; break; } } catch (e) {}
    await sleep(150);
  }
  return {
    dir,
    up,
    log: () => log,
    cfgPath: path.join(dir, 'config.json'),
    chat: (message, extra) => fetch('http://127.0.0.1:' + port + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ message, session: 'mode-' + Math.random().toString(36).slice(2, 8) }, extra || {}))
    }).then((r) => r.json()),
    mode: (m) => fetch('http://127.0.0.1:' + port + '/api/mode', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: m })
    }).then((r) => r.json()),
    getMode: () => fetch('http://127.0.0.1:' + port + '/api/mode').then((r) => r.json()),
    kill: () => { try { child.kill(); } catch (e) {} },
    clean: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  };
}

(async () => {
  const m1 = await mockModel(18301);

  // 服务一：一个不帶工具的家 + 一个能动手的家
  let s = await start(7941, [provider('不带工具', 18301, { tools: false }), provider('能动手', 18301)], { mode: 'chat' });
  ok(s.up, '临时服务起得来', s.log().slice(0, 300));
  if (s.up) {
    let r = await s.chat('你好', { mode: 'chat' });
    ok(r.ok === true && r.stats && r.stats.mode === 'chat', '对话模式能答', JSON.stringify(r.stats || r.error));
    ok(r.stats && r.stats.provider === '不带工具', '对话模式真的用了不带工具的家', r.stats && r.stats.provider);
    const hit = m1.hits[m1.hits.length - 1];
    ok(hit && hit.body && !hit.body.tools, '对话模式请求里不带 tools', JSON.stringify(hit && hit.body && Object.keys(hit.body)));
    const sys = hit && hit.body && hit.body.messages && hit.body.messages[0] && String(hit.body.messages[0].content || '');
    const now = new Date();
    ok(sys.indexOf('【现在】') >= 0 && sys.indexOf(String(now.getFullYear())) >= 0, '系统提示里带电脑上的今天（问日期不靠猜）', sys.slice(-80));
    const lastUser = hit && hit.body && hit.body.messages && hit.body.messages[hit.body.messages.length - 1];
    ok(String(lastUser && lastUser.content || '').indexOf('对话模式') >= 0, '对话模式明确告诉她这轮没有工具（不许假装做过）', String(lastUser && lastUser.content || '').slice(0, 100));

    // 入口各管各的：DSH 的 mcp 入口该干活，不受窗口的对话模式影响
    const mcpMode = await fetch('http://127.0.0.1:7941/api/mode?entry=mcp').then((x) => x.json());
    ok(mcpMode.mode === 'work', 'mcp 入口默认工作模式', JSON.stringify(mcpMode));
    const qqMode = await fetch('http://127.0.0.1:7941/api/mode?entry=qq').then((x) => x.json());
    ok(qqMode.mode === 'work', 'qq 入口默认工作模式', JSON.stringify(qqMode));
    const beforeMcp = m1.hits.length;
    let rM = await s.chat('你好', { entry: 'mcp' });
    ok(rM.ok === true && rM.stats.provider === '能动手', 'mcp 入口真用能动手的家', rM.stats && rM.stats.provider);
    const mcpHit = m1.hits[m1.hits.length - 1];
    ok(mcpHit && Array.isArray(mcpHit.body.tools) && mcpHit.body.tools.length > 0, 'mcp 入口请求里带 tools', JSON.stringify(mcpHit && mcpHit.body && Object.keys(mcpHit.body)));
    await fetch('http://127.0.0.1:7941/api/mode', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry: 'mcp', mode: 'chat' })
    });
    rM = await s.chat('你好', { entry: 'mcp' });
    ok(rM.ok === true && rM.stats.provider === '不带工具', 'mcp 入口也能单独改回对话', rM.stats && rM.stats.provider);
    const desktopMode = await fetch('http://127.0.0.1:7941/api/mode?entry=desktop').then((x) => x.json());
    ok(desktopMode.mode === 'chat', '改 mcp 不影响窗口的对话模式', JSON.stringify(desktopMode));

    r = await s.chat('你好', { mode: 'work' });
    ok(r.ok === true && r.stats.provider === '能动手', '工作模式用能动手的家', r.stats && r.stats.provider);
    const hit2 = m1.hits[m1.hits.length - 1];
    ok(hit2 && hit2.body && Array.isArray(hit2.body.tools) && hit2.body.tools.length > 0, '工作模式请求里带 tools', JSON.stringify(hit2 && hit2.body && Object.keys(hit2.body)));

    // 固定到不带工具的家 + 工作模式：要明说，不许偷偷换
    await fetch('http://127.0.0.1:7941/api/route', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '不带工具' })
    });
    const before = m1.hits.length;
    r = await s.chat('你好', { mode: 'work' });
    ok(r.ok === false && /不支持工具/.test(r.error), '固定到不带工具的家时明说原因', r.error);
    ok(m1.hits.length === before, '不许偷偷换别家去答', '多打了 ' + (m1.hits.length - before) + ' 次');

    // 对话模式里说「要动手」：先问一句
    r = await s.chat('帮我在桌面写个 out.txt', { mode: 'chat' });
    ok(r.ok === true && r.stats.suggest_mode === 'work', '认出是活，标出该切工作模式', JSON.stringify(r.stats && r.stats.suggest_mode));
    ok(/工作模式/.test(r.reply || ''), '回复里问了要不要切工作模式', (r.reply || '').slice(-60));
  }
  s.kill(); s.clean();

  // 服务二：只有不带工具的家
  s = await start(7942, [provider('只有免费', 18301, { tools: false })], { mode: 'chat' });
  if (s.up) {
    const r = await s.chat('你好', { mode: 'work' });
    ok(r.ok === false && /没有能动手的模型/.test(r.error), '没有能动手的模型时说清楚', r.error);

    const m = await s.mode('work');
    ok(m.ok === true && m.mode === 'work' && m.restartNeeded === false, '/api/mode 热切换到工作模式', JSON.stringify(m));
    const saved = JSON.parse(fs.readFileSync(s.cfgPath, 'utf8'));
    ok(saved.mode === 'work', '模式写进 config.json，重启还记得', saved.mode);
    const g = await s.getMode();
    ok(g.mode === 'work', 'GET /api/mode 读得到', JSON.stringify(g));

    const auto = await s.chat('你好');   // 不带 mode，应走 config 里的 work
    ok(auto.ok === false && /没有能动手的模型/.test(auto.error), '不传 mode 时按存下的模式走', JSON.stringify(auto.error || auto.stats));

    const bad = await s.mode('随便');
    ok(bad.ok === false, '不合法的模式要拒绝', JSON.stringify(bad));
  }
  s.kill(); s.clean();

  m1.close();
  console.log('\n模式用例：' + pass + '/' + (pass + fail) + ' 通过');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('用例自己崩了：', e);
  process.exit(1);
});
