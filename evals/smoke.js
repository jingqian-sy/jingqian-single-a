'use strict';
/*
 * 服务级冒烟：真的把 src/server.js 起起来，打一次 /api/chat，再关掉。
 *
 *   node evals/smoke.js
 *
 * 结果写 data/smoke.json，跑批报表（evals/run.js）会把它带进 data/report.md 的
 * 「服务验证」那一节。默认用 7899 端口，不跟你平时开的 7889 打架。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readJson, writeJson, ensureDir, nowIso } = require('../src/util');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SMOKE_PORT || 7899);
const DATA = process.env.JQ_DATA_DIR ? path.resolve(ROOT, process.env.JQ_DATA_DIR) : path.join(ROOT, 'data');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  return r.json();
}

async function main() {
  const node = process.execPath;
  const child = spawn(node, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: 'ignore',
    windowsHide: true
  });

  let sc = null;
  const waitStart = Date.now();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      sc = await getJson('http://127.0.0.1:' + PORT + '/api/selfcheck');
      if (sc && sc.at) break;
    } catch (e) { /* 还没起来 */ }
  }
  if (!sc || !sc.at) {
    try { child.kill(); } catch (e) {}
    writeJson(path.join(DATA, 'smoke.json'), { ok: false, at: nowIso(), error: '服务没起来（等了 20 秒）' });
    console.error('服务没起来');
    process.exit(1);
  }
  const startMs = Date.now() - waitStart;

  const t0 = Date.now();
  let chat = null;
  let error = '';
  try {
    chat = await getJson('http://127.0.0.1:' + PORT + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '你好，一句话说说你是谁、能干什么。', session: 'smoke' })
    });
  } catch (e) {
    error = e.message;
  }
  const ms = Date.now() - t0;
  try { child.kill(); } catch (e) {}

  const out = {
    ok: !!(chat && chat.ok && String(chat.reply || '').trim()),
    at: nowIso(),
    port: PORT,
    node: process.version,
    platform: process.platform,
    start_ms: startMs,
    chat_ms: ms,
    selfcheck: {
      ready_providers: sc.ready_providers,
      providers: sc.providers,
      memory_count: sc.memory.count,
      sandbox: sc.sandbox,
      workspace: sc.workspace
    },
    reply: (chat && chat.reply) || '',
    stats: (chat && chat.stats) || {},
    error: error || (chat && chat.error) || ''
  };
  ensureDir(DATA);
  writeJson(path.join(DATA, 'smoke.json'), out);

  console.log('服务起来用了 ' + startMs + 'ms，/api/chat 用了 ' + ms + 'ms');
  console.log('回复：' + out.reply);
  console.log('tokens：' + (out.stats.total_tokens || 0) + ' · 模型：' + (out.stats.provider || '-'));
  console.log(out.ok ? '冒烟通过' : '冒烟失败：' + out.error);
  process.exit(out.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e.stack);
  process.exit(1);
});
