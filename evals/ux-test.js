'use strict';
/*
 * 会话列表 + 记忆面板 的接口用例（本机临时服务，不联网、不碰真实记忆）
 *
 *   1) /api/sessions 列得出会话，能按关键词搜；
 *   2) DELETE /api/sessions?id= 真删掉，乱填 id 会被拒（不许穿目录）；
 *   3) 删不存在的会话给一句人话，不当成成功；
 *   4) /api/memory 支持 limit/offset 翻页，count 是总条数；
 *   5) 翻到最后一页没有重复、没有漏。
 *
 *   node evals/ux-test.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')); }
}

const PORT = 7951;
const B = 'http://127.0.0.1:' + PORT;

(async () => {
  const dir = path.join(os.tmpdir(), 'jq-ux-' + Date.now());
  const dataDir = path.join(dir, 'data');
  const sessDir = path.join(dataDir, 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  cfg.port = PORT;
  cfg.host = '127.0.0.1';
  cfg.mode = 'chat';
  cfg.providers = [{ name: 'mock', base: 'http://127.0.0.1:9/v1/chat/completions', model: 'm', key: 'local', tier: 'local', enabled: true }];
  cfg.route = { mode: 'fixed', order: ['mock'], escalate: false, maxSteps: 1 };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

  const mk = (id, text, when) => fs.writeFileSync(path.join(sessDir, id + '.json'), JSON.stringify({
    session: id,
    updated_at: when,
    messages: [
      { role: 'user', content: text },
      { role: 'assistant', content: '嗯，记着了：' + text }
    ]
  }, null, 2), 'utf8');
  mk('hist-a', '周末去打球', '2026-11-01T10:00:00.000Z');
  mk('hist-b', '帮我找一下报价单', '2026-11-02T10:00:00.000Z');

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      JQ_CONFIG: path.join(dir, 'config.json'),
      JQ_DATA_DIR: dataDir
    }),
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
  const del = (p) => fetch(B + p, { method: 'DELETE' }).then((r) => r.json());

  // 1) 列表 + 搜索
  let j = await get('/api/sessions?limit=50');
  ok(j.ok && j.items.length === 2, '列得出 2 个会话', JSON.stringify(j.items && j.items.map((x) => x.id)));
  j = await get('/api/sessions?limit=50&query=' + encodeURIComponent('打球'));
  ok(j.ok && j.items.length === 1 && j.items[0].id === 'hist-a', '按内容搜得到那个会话', JSON.stringify(j.items && j.items.map((x) => x.id)));
  j = await get('/api/sessions?limit=50&query=' + encodeURIComponent('不存在的词'));
  ok(j.ok && j.items.length === 0, '搜不到就返回空，不报错', JSON.stringify(j.items));

  // 2) 删除
  j = await del('/api/sessions?id=hist-a');
  ok(j.ok && j.deleted === 'hist-a', '删掉一个会话', JSON.stringify(j));
  ok(!fs.existsSync(path.join(sessDir, 'hist-a.json')), '文件真的没了', 'hist-a.json');
  j = await del('/api/sessions?id=hist-a');
  ok(j.ok === false, '再删一次给一句人话，不假装成功', JSON.stringify(j));
  j = await del('/api/sessions?id=' + encodeURIComponent('../config'));
  ok(j.ok === false, '乱填 id 会被拒（不许穿目录）', JSON.stringify(j));
  ok(fs.existsSync(path.join(dir, 'config.json')), '配置文件没被删', 'config.json');

  // 3) 历史翻页（往更早翻，不重不漏）
  const histMsgs = [];
  for (let i = 1; i <= 7; i++) histMsgs.push({ role: i % 2 ? 'user' : 'assistant', content: '第 ' + i + ' 句' });
  fs.writeFileSync(path.join(sessDir, 'hist-pg.json'), JSON.stringify({ session: 'hist-pg', updated_at: '2026-11-03T10:00:00.000Z', messages: histMsgs }, null, 2), 'utf8');
  const h1 = await get('/api/history?session=hist-pg&limit=3&offset=0');
  const h2 = await get('/api/history?session=hist-pg&limit=3&offset=3');
  const h3 = await get('/api/history?session=hist-pg&limit=3&offset=6');
  ok(h1.ok && h1.items.length === 3 && h1.total === 7, '最新一页 3 条、总数 7', JSON.stringify({ n: h1.items && h1.items.length, total: h1.total }));
  ok(h1.items[2].content === '第 7 句', '最新一页最后一条是最新的那句', JSON.stringify(h1.items));
  ok(h1.has_more === true && h2.items.length === 3 && h3.items.length === 1, '翻到最后一页只剩 1 条', JSON.stringify({ m1: h1.has_more, n2: h2.items.length, n3: h3.items.length }));
  ok(h3.has_more === false, '翻到底了 has_more 是 false', JSON.stringify(h3.has_more));
  const seenH = new Set();
  let dupH = false;
  for (const page of [h1, h2, h3]) for (const it of page.items) {
    if (seenH.has(it.content)) dupH = true;
    seenH.add(it.content);
  }
  ok(!dupH && seenH.size === 7, '三页拼起来不重不漏', JSON.stringify({ n: seenH.size }));

  // 4) 记忆翻页
  for (let i = 1; i <= 5; i++) {
    await fetch(B + '/api/memory', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '测试记忆 ' + i, kind: 'fact' })
    });
  }
  const p1 = await get('/api/memory?limit=2&offset=0');
  ok(p1.ok && p1.items.length === 2 && p1.count === 5, '第一页 2 条、总数 5', JSON.stringify({ n: p1.items.length, count: p1.count }));
  const p2 = await get('/api/memory?limit=2&offset=2');
  const p3 = await get('/api/memory?limit=2&offset=4');
  ok(p2.ok && p2.items.length === 2 && p3.items.length === 1, '翻到最后一页只剩 1 条', JSON.stringify({ p2: p2.items.length, p3: p3.items.length }));
  const seen = new Set();
  let dup = false;
  for (const page of [p1, p2, p3]) {
    for (const it of page.items) {
      if (seen.has(it.id)) dup = true;
      seen.add(it.id);
    }
  }
  ok(!dup && seen.size === 5, '三页拼起来不重不漏', JSON.stringify({ n: seen.size }));

  try { child.kill(); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  console.log('\n会话/记忆用例：' + pass + '/' + (pass + fail) + ' 通过');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('用例自己崩了：', e);
  process.exit(1);
});
