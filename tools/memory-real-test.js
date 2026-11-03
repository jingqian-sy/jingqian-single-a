'use strict';
/*
 * 1A 记忆能力真机对照（要联网/本机 Ollama，会花一点钱，不进 CI）
 *
 *   node tools/memory-real-test.js                 # 默认 本地8B + DeepSeek
 *   node tools/memory-real-test.js --models ollama-8b
 *
 * 做法：临时数据目录 + 临时配置，种 5 条已知记忆，问三题：
 *   Q1 车位（最近直问）、Q2 生日（另一条）、Q3 车牌（没有的，考编不编）
 * 先在「默认人格」下跑一轮，再用 300 字人格跑 Q1，
 * 最后用 8000 字人格跑 Q1 + 一条人设规则题（看长人格会不会挤掉记忆、抢戏）。
 *
 * 结果只判断「命中/编造/崩」，不做主观评分；每轮打印耗时和 token。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 7971;
const B = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argModels = (() => {
  const i = process.argv.indexOf('--models');
  return i > 0 ? process.argv[i + 1].split(',') : ['ollama-8b', 'deepseek'];
})();

const FACTS = [
  ['我的车位号是 B7-8899。', 3],
  ['我的生日是 3 月 14 日。', 3],
  ['我每周三晚上打羽毛球。', 3],
  ['我喝咖啡不加糖。', 3],
  ['我家猫叫团子。', 3],
  ['周末去打网球。', 3]
];

function mockNone() {}

(async () => {
  const cfg0 = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const picked = (cfg0.providers || []).filter((p) => argModels.indexOf(p.name) >= 0);
  if (!picked.length) { console.log('config.json 里找不到这些提供方：' + argModels.join('、')); process.exit(1); }

  const dir = path.join(os.tmpdir(), 'jq-memreal-' + Date.now());
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = JSON.parse(JSON.stringify(cfg0));
  cfg.port = PORT;
  cfg.host = '127.0.0.1';
  cfg.mode = 'chat';
  cfg.providers = picked;
  cfg.route = { mode: 'fixed', order: picked.map((p) => p.name), escalate: false, maxSteps: 2 };
  cfg.memory = Object.assign({}, cfg.memory, { autoCapture: false });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { JQ_CONFIG: path.join(dir, 'config.json'), JQ_DATA_DIR: path.join(dir, 'data') }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(B + '/api/selfcheck'); if (r.ok) { up = true; break; } } catch (e) {}
    await sleep(150);
  }
  if (!up) { console.log('临时服务起不来：' + log.slice(0, 400)); try { child.kill(); } catch (e) {} process.exit(1); }

  const post = (p, body) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const session = (s) => 'mrt-' + s + '-' + Math.random().toString(36).slice(2, 7);

  for (const [text, importance] of FACTS) {
    await post('/api/memory', { text, kind: 'fact', importance });
  }

  const setPersona = async (persona) => (await post('/api/config', { persona })).ok === true;
  const pin = async (name) => (await post('/api/route', { pin: name })).ok === true;
  const ask = async (q) => {
    const t0 = Date.now();
    const r = await post('/api/chat', { message: q, session: session('q') });
    return { ok: r.ok, reply: String(r.reply || r.error || ''), provider: r.stats && r.stats.provider, ms: Date.now() - t0, tokens: r.stats && r.stats.total_tokens };
  };

  const rows = [];
  const check = (label, r, expect, forbid) => {
    const hit = expect ? expect.test(r.reply) : true;
    const bad = forbid ? forbid.test(r.reply) : false;
    rows.push({ label, model: r.provider || '-', ms: r.ms, tokens: r.tokens || 0, verdict: hit && !bad ? 'OK' : (bad ? '编造/跑偏' : '没答上'), reply: r.reply.replace(/\s+/g, ' ').slice(0, 120) });
  };

  const personas = {
    short: '你叫鲸倩，说话短、口语、像真人。回答控制在两句话内。',
    fat: '你是鲸倩，住在这台电脑里。' + '（人设细节：话短、别客套、别编；问到不知道的事就说不确定。）'.repeat(900)
  };
  // 确认 8000 字左右
  if (personas.fat.length < 7000) personas.fat = personas.fat + '稳'.repeat(8000 - personas.fat.length);
  const PERSONA_RULE = '\n规则：每次回答最后必须加「喵」。';
  const fatTarget = 8000 - PERSONA_RULE.length;
  const fatBase = '你是鲸倩，住在这台电脑里。' + '（人设细节：话短、别客套、别编；问到不知道的事就说不确定。）'.repeat(900);
  personas.fat = fatBase.slice(0, fatTarget) + PERSONA_RULE;

  for (const m of picked) {
    await pin(m.name);
    // 1) 默认人格：记忆三题
    await setPersona('');
    check(m.name + ' · 默认人格 · Q1 车位', await ask('我的车位号是多少？'), /B7-?8899/i, null);
    check(m.name + ' · 默认人格 · Q2 生日', await ask('我生日是哪天？'), /3\s*月\s*14|三月十四|3\.14/, null);
    check(m.name + ' · 默认人格 · Q3 车牌（没有的）', await ask('我的车牌号是多少？'), /不知道|没记|不确定|没提|没有|记不得/, /[A-Z]{1,2}\s?\d{4,}/i);
    check(m.name + ' · 默认人格 · Q4 没主语的事实', await ask('我周末干嘛？'), /网球/, /没记|不知道/);
    check(m.name + ' · 默认人格 · Q5 她自己的名字', await ask('你叫什么名字？'), /鲸倩/, /用户/);
    // 2) 300 字人格：抓一条记忆
    await setPersona(personas.short);
    check(m.name + ' · 短人格 · Q1 车位', await ask('我的车位号是多少？'), /B7-?8899/i, null);
  }

  // 3) 8000 字人格最后测
  for (const m of picked) {
    const p2 = picked.find((x) => x.name === m.name);
    await pin(m.name);
    const okP = await setPersona(personas.fat);
    if (!okP) { rows.push({ label: m.name + ' · 8000 人格', model: '-', ms: 0, tokens: 0, verdict: '没存上', reply: '' }); continue; }
    check(m.name + ' · 8000 人格 · Q1 车位', await ask('我的车位号是多少？'), /B7-?8899/i, null);
    const r = await ask('你好，随便说一句');
    const follows = /喵/.test(r.reply);
    rows.push({ label: m.name + ' · 8000 人格 · 人设规则（结尾「喵」）', model: r.provider || '-', ms: r.ms, tokens: r.tokens || 0, verdict: follows ? 'OK' : '没照做', reply: r.reply.replace(/\s+/g, ' ').slice(0, 120) });
  }

  console.log('');
  console.log('模型' + ' '.repeat(10) + '用例'.padEnd(34) + '耗时   tokens  结论');
  for (const x of rows) {
    console.log(String(x.model).padEnd(14) + x.label.padEnd(36) + String(x.ms).padStart(5) + '  ' + String(x.tokens).padStart(6) + '  ' + x.verdict);
    if (x.verdict !== 'OK') console.log('    ↳ ' + x.reply);
  }
  const ok = rows.filter((x) => x.verdict === 'OK').length;
  console.log('\n合计：' + ok + '/' + rows.length + ' 符合预期（判的是命中/编造/人设是否照做，不是主观打分）');

  try { child.kill(); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
})().catch((e) => { console.error('脚本崩了：', e); process.exit(1); });
