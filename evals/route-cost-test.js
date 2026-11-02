'use strict';
/*
 * 模型快捷切换 + 今日账单（CI 用，不联网、不需要密钥）
 *
 *   node evals/route-cost-test.js
 *
 * 真起一个服务（临时配置、临时数据目录、随机端口），证明：
 *   A. 切模型
 *     1) GET /api/route 能列出提供方、标出免费/未配置，且**不回 key 明文**；
 *     2) POST /api/route { pin } 切成 fixed、写进 config.json、就地生效（不重启）；
 *     3) 非法 mode / 不认识的提供方被拒；
 *   B. 账单
 *     4) GET /api/cost 能给出今日金额与按家明细、币种 CNY；
 *     5) POST /api/cost/reset 之后今日归零，但原始按天账本还在（不是删账）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.run', 'route-cost');
const CFG = path.join(TMP, 'config.json');
const DATA = path.join(TMP, 'data');
const PORT = 18000 + (process.pid % 900);
const FAKE_PORT = PORT + 1;
let fake = null;

// 假服务商：只提供一个 /v1/models，用来看「接上 key 先问用哪个模型」这条路
function startFakeProvider() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method === 'GET' && /\/models$/.test(String(req.url || ''))) {
        if (String(req.headers.authorization || '') !== 'Bearer good-key') {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'bad key' }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'm-one' }, { id: 'm-two' }] }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    srv.listen(FAKE_PORT, '127.0.0.1', () => resolve(srv));
  });
}

let fails = 0;
function ok(name, cond, extra) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(extra === undefined ? '' : extra)));
  if (!cond) fails++;
}

function dayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function seed() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CFG, JSON.stringify({
    port: PORT,
    providers: [
      { name: '本机', base: 'http://127.0.0.1:9/v1/chat/completions', model: 'qwen3-8b', tier: 'local', price_in: 0, price_out: 0 },
      { name: '智谱', base: 'http://127.0.0.1:9/v1/chat/completions', model: 'glm-4-flash', tier: 'free', key: '', price_in: 0, price_out: 0 },
      { name: '假家', base: 'http://127.0.0.1:' + FAKE_PORT + '/v1/chat/completions', model: 'm-one', tier: 'free', key: 'good-key', price_in: 0, price_out: 0 }
    ],
    route: { mode: 'cheap-first', order: [], escalate: true },
    memory: { idleConsolidateMinutes: 0 },
    embedding: { enabled: false }
  }, null, 2), 'utf8');
  // 先造一条今天的真实账单（有金额，才能验「重置」）
  fs.mkdirSync(path.join(DATA, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'ledger', dayKey() + '.json'), JSON.stringify({
    date: dayKey(),
    providers: { 智谱: { calls: 3, prompt_tokens: 1000, completion_tokens: 500, cost: 0.0123, model: 'glm-4-flash' } },
    total: { calls: 3, prompt_tokens: 1000, completion_tokens: 500, cost: 0.0123 }
  }, null, 2), 'utf8');
}

const base = 'http://127.0.0.1:' + PORT;
const get = (p) => fetch(base + p).then((r) => r.json());
const post = (p, body) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {})
}).then((r) => r.json());

(async () => {
  seed();
  fake = await startFakeProvider();

  // ---- 选路逻辑本身（不起服务）：固定模式不被升级打乱、失败的家会被冷落 ----
  {
    const { Router } = require('../src/router');
    const r = new Router({
      providers: [
        { name: '本机', base: 'http://127.0.0.1:9/v1/chat/completions', model: 'l', tier: 'local', price_in: 0, price_out: 0 },
        { name: '云', base: 'http://127.0.0.1:9/v1/chat/completions', model: 'c', tier: 'cloud', price_in: 1, price_out: 1, key: 'k' }
      ],
      route: { mode: 'fixed', order: ['本机', '云'], escalate: true }
    }, path.join(TMP, 'unit-data'));
    const hard = '帮我分析一下这个架构该怎么设计，为什么这么选，写一段对比';
    const fixedList = r.candidates(hard);
    ok('固定模式不被「难活升级」打乱', fixedList[0].name === '本机', fixedList.map((x) => x.name));

    r.setRoute({ mode: 'cheap-first' });
    const cheapHard = r.candidates(hard);
    ok('自动模式下难活先云端', cheapHard[0].name === '云', cheapHard.map((x) => x.name));
    const cheapEasy = r.candidates('嗯');
    ok('自动模式下闲话先本机', cheapEasy[0].name === '本机', cheapEasy.map((x) => x.name));

    r.markFail(cheapEasy[0]);
    const afterFail = r.candidates('嗯');
    ok('刚失败的家排到最后（不删）', afterFail[0].name === '云' && afterFail.length === 2, afterFail.map((x) => x.name));
    r.failUntil = {};
  }

  const srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    stdio: 'ignore',
    env: Object.assign({}, process.env, { PORT: String(PORT), JQ_CONFIG: CFG, JQ_DATA_DIR: DATA })
  });

  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { await get('/api/route'); up = true; } catch (e) { await new Promise((r) => setTimeout(r, 200)); }
    }
    if (!up) throw new Error('服务没起来（' + base + '）');

    const s0 = await get('/api/route');
    ok('GET /api/route 列出提供方', Array.isArray(s0.providers) && s0.providers.length === 3, s0.providers && s0.providers.length);
    ok('默认 cheap-first', s0.route && s0.route.mode === 'cheap-first', s0.route);
    ok('本地模型标成免费', s0.providers[0].free === true, s0.providers[0]);
    ok('未填 key 的云端 ready=false', s0.providers[1].ready === false, s0.providers[1]);
    ok('不回 key 明文（只有 keyed 布尔）', !JSON.stringify(s0).includes('"key"'), s0.providers);

    const s1 = await post('/api/route', { pin: '本机' });
    ok('pin 切成 fixed 且排最前', s1.route.mode === 'fixed' && s1.route.order[0] === '本机', s1.route);
    ok('就地生效（applied=true，无 restartNeeded）', s1.applied === true, s1);
    const saved = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    ok('写进了 config.json（重启也还在）', saved.route.mode === 'fixed' && saved.route.order[0] === '本机', saved.route);

    const s2 = await post('/api/route', { mode: 'cloud-first' });
    ok('切回 cloud-first 生效', s2.route.mode === 'cloud-first', s2.route);
    const bad1 = await post('/api/route', { mode: '随便写' });
    ok('非法 mode 被拒', bad1.ok === false, bad1);
    const bad2 = await post('/api/route', { order: ['根本没有这家'] });
    ok('不认识的提供方被拒', bad2.ok === false, bad2);

    const c0 = await get('/api/cost?days=7');
    ok('今日金额对得上', Math.abs(c0.today.cost - 0.0123) < 1e-9, c0.today);
    ok('币种 CNY', c0.currency === 'CNY', c0.currency);
    ok('按家明细有智谱', c0.today.providers.length === 1 && c0.today.providers[0].name === '智谱', c0.today.providers);

    const r = await post('/api/cost/reset', {});
    ok('重置返回水位时间', r.ok === true && !!r.reset.at, r);
    const c1 = await get('/api/cost?days=7');
    ok('重置后今日归零', c1.today.cost === 0 && c1.today.calls === 0, c1.today);
    ok('原始账本没被删', fs.existsSync(path.join(DATA, 'ledger', dayKey() + '.json')), 'ledger');

    // 接上密钥先问「用哪个模型」：真问服务商的 /v1/models
    const ml = await post('/api/models', { name: '假家' });
    ok('问得到这把 key 能用的模型', ml.ok === true && ml.source === 'list' && ml.models.indexOf('m-two') >= 0, ml);
    const mlBad = await post('/api/models', { base: 'http://127.0.0.1:' + FAKE_PORT + '/v1/chat/completions', key: 'bad' });
    ok('key 不对时明确报错、不编模型', mlBad.ok === false && !!mlBad.error, mlBad);
    const mlNone = await post('/api/models', { name: '智谱' });
    ok('问不到时给建议列表（或空），不假装成功', mlNone.source === 'preset' && Array.isArray(mlNone.models), mlNone);

    console.log(fails ? ('失败 ' + fails + ' 条') : '全部通过（20 条）');
  } finally {
    srv.kill();
    if (fake) fake.close();
  }
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('FAIL ' + e.message);
  process.exit(1);
});
