'use strict';
/*
 * 上下文窗口用例（本机假模型，不联网、不碰真实记忆）
 *
 * 验三件：
 *   1) 历史很长时，进提示的只是「最近一截」，按 memory.historyChars 的字数档位裁；
 *   2) 原文不丢：会话文件里仍然保留完整历史，只是模型看不到全部；
 *   3) 摘要游标（summary_cursor）会往前走，不会每轮都把同一段旧历史重复压一遍。
 *
 *   node evals/context-test.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 7964;
const MOCK_PORT = 18404;
const B = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '：' + String(detail).slice(0, 220) : '')); }
}

(async () => {
  const hits = [];
  const mock = http.createServer((req, res) => {
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
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  const dir = path.join(os.tmpdir(), 'jq-ctx-' + Date.now());
  const dataDir = path.join(dir, 'data');
  const sessDir = path.join(dataDir, 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  cfg.port = PORT;
  cfg.host = '127.0.0.1';
  cfg.mode = 'chat';
  cfg.providers = [{ name: 'mock', base: 'http://127.0.0.1:' + MOCK_PORT + '/v1/chat/completions', model: 'm', key: 'local', tier: 'local', enabled: true }];
  cfg.route = { mode: 'fixed', order: ['mock'], escalate: false, maxSteps: 1 };
  cfg.memory = Object.assign({}, cfg.memory, { autoCapture: false, historyChars: 4000, maxHistory: 20, summaryKeep: 8 });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

  // 造 60 条历史，每条 500 字
  const msgs = [];
  for (let i = 1; i <= 60; i++) {
    msgs.push({ role: i % 2 ? 'user' : 'assistant', content: ('第' + i + '条 ') + '长'.repeat(495) });
  }
  fs.writeFileSync(path.join(sessDir, 'ctx.json'), JSON.stringify({ id: 'ctx', messages: msgs, updated_at: '2026-11-03T10:00:00.000Z' }, null, 2), 'utf8');

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

  await fetch(B + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '接着聊', session: 'ctx' })
  }).then((r) => r.json());
  await sleep(400);

  const chatReq = hits.find((h) => h && h.messages && h.messages.length > 1 && h.messages[h.messages.length - 1].content.indexOf('接着聊') >= 0);
  const histChars = chatReq ? chatReq.messages.slice(1, -1).reduce((n, m) => n + String(m.content || '').length, 0) : -1;
  ok(chatReq, '这一轮真的发出去了', JSON.stringify(hits.map((h) => h && h.messages && h.messages.length)));
  ok(histChars >= 0 && histChars <= 4600, '进提示的历史按 4000 字档位裁过（≤4600）', histChars);
  const maxMsg = chatReq ? Math.max.apply(null, chatReq.messages.slice(1, -1).map((m) => String(m.content || '').length)) : 0;
  ok(maxMsg <= 500, '单条历史没被截断（还是原文）', maxMsg);

  const saved = JSON.parse(fs.readFileSync(path.join(sessDir, 'ctx.json'), 'utf8'));
  ok(saved.messages.length >= 61, '原文不丢：会话文件里历史还在（≥61 条）', saved.messages.length);
  ok(saved.summary_cursor > 0, '摘要游标往前走了', saved.summary_cursor);
  ok(fs.existsSync(path.join(sessDir, 'ctx.summary.md')), '摘要文件写出来了', 'ctx.summary.md');

  try { child.kill(); } catch (e) {}
  mock.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  console.log('\n上下文用例：' + pass + '/' + (pass + fail) + ' 通过');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('用例自己崩了：', e);
  process.exit(1);
});
