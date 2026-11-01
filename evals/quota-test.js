'use strict';
/*
 * 动态额度的单元测试（CI 用，不联网、不需要密钥、不登录任何账号）
 *
 *   node evals/quota-test.js
 *
 * 全程只用本机一个假端点：
 *   POST /v1/429  永远 429（模拟「额度用完」）
 *   POST /v1/ok   正常回一个 chat.completion（模拟付费档）
 *   GET  /rules   一页「每天 200 万 tokens」的规则页
 *   GET  /empty   找不到额度描述的页面（模拟页面改版）
 *
 * 四件必须成立的：
 *   1) probe 遇 429 判 exhausted，且 10 分钟内第二次走缓存、不再发请求；
 *   2) refreshRules 能解析「每天 200 万」→ 2,000,000 tokens/天；
 *   3) remaining 按本地账本扣减正确；
 *   4) 免费全 exhausted 时切付费档；没有付费档时报「免费额度都用完了」。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const quota = require('../src/quota');
const { Router } = require('../src/router');

const TMP = path.join(__dirname, '.run', 'quota-test');
const DATA = path.join(TMP, 'data');
const DATA_ROUTER = path.join(TMP, 'data-router');

function dayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function writeLedger(dataDir, providerName, promptTokens, completionTokens) {
  const file = path.join(dataDir, 'ledger', dayKey() + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    date: dayKey(),
    providers: { [providerName]: { calls: 1, prompt_tokens: promptTokens, completion_tokens: completionTokens, cost: 0 } },
    total: { calls: 1, prompt_tokens: promptTokens, completion_tokens: completionTokens, cost: 0 }
  }), 'utf8');
}

// 假端点：按 URL 分派，顺便数每个 URL 被打了几次（用来证明缓存真的没发请求）
function startFake() {
  const hits = Object.create(null);
  const bump = (u) => { hits[u] = (hits[u] || 0) + 1; };
  const server = http.createServer((req, res) => {
    const url = String(req.url || '').split('?')[0];
    bump(url);
    if (req.method === 'POST' && url === '/v1/429') {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'quota exceeded' } }));
    }
    if (req.method === 'POST' && url === '/v1/ok') {
      const body = JSON.stringify({
        id: 'fake-1',
        object: 'chat.completion',
        model: 'fake-1',
        choices: [{ index: 0, message: { role: 'assistant', content: '好。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(body);
    }
    if (req.method === 'GET' && url === '/rules') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<html><body><h1>模型额度说明</h1><p>glm-4-flash 免费额度：每天 200 万 tokens，按天重置。</p></body></html>');
    }
    if (req.method === 'GET' && url === '/empty') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<html><body><p>今天天气不错。</p></body></html>');
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'fake: 没有这个路由 ' + url }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ base: 'http://127.0.0.1:' + port, hits, close: () => server.close() });
    });
  });
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const fake = await startFake();
  const cases = [];
  const check = (name, cond, detail) => {
    cases.push({ name, ok: !!cond, detail: cond ? '' : (detail || '') });
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  ' + (detail || '')));
  };

  try {
    // 1) probe：429 → exhausted，第二次走缓存（只有一个请求打到假端点）
    {
      const p = { name: 'fake-free-429', tier: 'free', base: fake.base + '/v1/429', model: 'fake-1', key: 'test-key' };
      const a = await quota.probe(p, { dataDir: DATA });
      check('探测：遇到 429 判 exhausted', a.status === 'exhausted' && a.cached === false, 'status=' + a.status + ' detail=' + a.detail);
      const b = await quota.probe(p, { dataDir: DATA });
      check('探测：10 分钟内第二次走缓存，不再发请求',
        b.status === 'exhausted' && b.cached === true && fake.hits['/v1/429'] === 1,
        'cached=' + b.cached + ' 请求次数=' + fake.hits['/v1/429']);
      const st = quota.loadState(DATA);
      check('探测：结果写进了 quota-state.json', !!(st.probes['fake-free-429'] && st.probes['fake-free-429'].status === 'exhausted'));
    }

    // 2) 规则刷新：「每天 200 万」→ 2,000,000 tokens/天；页面改版抓不到时保留旧值
    {
      const cfg = {
        providers: [{ name: 'fake-free-rule', tier: 'free' }],
        quotaSources: [{ provider: 'fake-free-rule', url: fake.base + '/rules' }]
      };
      const r = await quota.refreshRules({ cfg, dataDir: DATA });
      const up = r.updated[0] || {};
      check('规则：解析出「每天 200 万」= 2,000,000 tokens/天',
        up.ok && up.rule.amount === 2000000 && up.rule.reset === 'day',
        JSON.stringify(up));
      check('规则：刷新后回填到 provider 的 freeQuota',
        !!(cfg.providers[0].freeQuota && cfg.providers[0].freeQuota.amount === 2000000),
        JSON.stringify(cfg.providers[0].freeQuota || null));

      cfg.quotaSources = [{ provider: 'fake-free-rule', url: fake.base + '/empty' }];
      const r2 = await quota.refreshRules({ cfg, dataDir: DATA });
      const st = quota.loadState(DATA);
      check('规则：页面里找不到额度描述时保留旧值、不清空',
        (r2.updated[0] || {}).ok === false && st.rules['fake-free-rule'].amount === 2000000,
        JSON.stringify(r2.updated[0] || {}));
    }

    // 3) remaining：规则上限 - 本地账本今天已用（prompt + completion）
    {
      writeLedger(DATA, 'ledger-free', 1200000, 500000); // 已用 1.7M
      const p = { name: 'ledger-free', tier: 'free', freeQuota: { amount: 2000000, unit: 'token', reset: 'day' } };
      const r = quota.remaining({}, p, DATA);
      check('账本：remaining = 2,000,000 - 1,700,000 = 300,000',
        r.known && r.used === 1700000 && r.left === 300000, JSON.stringify(r));
      const wan = quota.remaining({}, { name: 'ledger-free', tier: 'free', freeQuota: { amount: 200, unit: 'wan', reset: 'day' } }, DATA);
      check('账本：写成「200 万」也按 unit 换算', wan.known && wan.limit === 2000000 && wan.left === 300000, JSON.stringify(wan));
      const unknown = quota.remaining({}, { name: 'no-rule', tier: 'free' }, DATA);
      check('账本：没有规则就报未知，不瞎猜', unknown.known === false && unknown.left === null);
    }

    // 4) 路由：免费全跳过 → 切付费档；没有付费档 → 明确报错
    {
      writeLedger(DATA_ROUTER, 'free-ledger-out', 2100000, 0); // 超了 2M 上限
      const providers = [
        { name: 'free-ledger-out', tier: 'free', base: fake.base + '/v1/429', model: 'fake-1', key: 'test-key', freeQuota: { amount: 2000000, unit: 'token', reset: 'day' } },
        { name: 'free-probe-429', tier: 'free', base: fake.base + '/v1/429', model: 'fake-1', key: 'test-key' },
        { name: 'paid-ok', tier: 'cloud', base: fake.base + '/v1/ok', model: 'fake-1', key: 'sk-test', price_in: 1, price_out: 1 }
      ];
      const router = new Router({ providers, route: { mode: 'fixed', order: ['free-ledger-out', 'free-probe-429', 'paid-ok'], escalate: false } }, DATA_ROUTER);
      const res = await router.call([{ role: 'user', content: '你好' }], null, {});
      check('路由：免费档全跳过时切到付费档',
        res.provider.name === 'paid-ok' && router.lastQuota && router.lastQuota.fallback === true,
        'provider=' + res.provider.name + ' lastQuota=' + JSON.stringify(router.lastQuota));
      check('路由：两个免费档都记了跳过原因',
        router.lastQuota && router.lastQuota.dropped.length === 2
        && router.lastQuota.dropped.some((d) => /ledger/.test(d.reason))
        && router.lastQuota.dropped.some((d) => /probe/.test(d.reason)),
        JSON.stringify((router.lastQuota || {}).dropped || []));

      // 同一份状态，把付费档的 key 抽掉（ready() 不认）→ 必须明确报「免费额度都用完了」
      const noPaid = [
        { name: 'free-ledger-out', tier: 'free', base: fake.base + '/v1/429', model: 'fake-1', key: 'test-key', freeQuota: { amount: 2000000, unit: 'token', reset: 'day' } },
        { name: 'free-probe-429', tier: 'free', base: fake.base + '/v1/429', model: 'fake-1', key: 'test-key' },
        { name: 'paid-no-key', tier: 'cloud', base: fake.base + '/v1/ok', model: 'fake-1', key: '' }
      ];
      const router2 = new Router({ providers: noPaid, route: { mode: 'fixed', order: ['free-ledger-out', 'free-probe-429', 'paid-no-key'], escalate: false } }, DATA_ROUTER);
      let err = null;
      try {
        await router2.call([{ role: 'user', content: '你好' }], null, {});
      } catch (e) { err = e; }
      check('路由：没有付费档时明确报「免费额度都用完了」，不静默失败',
        !!err && err.code === 'FREE_EXHAUSTED' && /免费额度都用完了/.test(err.message),
        err ? (err.code + ' / ' + err.message) : '居然没报错');
    }
  } finally {
    fake.close();
  }

  const failed = cases.filter((c) => !c.ok);
  console.log('');
  console.log('额度用例：' + (cases.length - failed.length) + '/' + cases.length + ' 通过');
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? '  ' + f.detail : '')));
    process.exit(1);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch((e) => { console.error(e.stack); process.exit(1); });
