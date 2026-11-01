'use strict';
/*
 * 免费模型雷达的单元测试（CI 用，本地假 HTML 页面，不联网、不登录、不要密钥）
 *
 *   node evals/radar-test.js
 *
 * 四件必须成立的：
 *   1) 页面里能解析出「模型名 + 免费 + 每天 X 万 tokens」→ 条目；
 *   2) 新条目被识别，写进 model-radar.json 和 radar-pending.json；
 *   3) 同一个页面再扫一遍，不重复提醒（清单里还是那几条，new 为空）；
 *   4) 页面 404 时保留旧清单、不崩，radar.log 里有 warn。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const radar = require('../src/radar');

const TMP = path.join(__dirname, '.run', 'radar-test');
const DATA = path.join(TMP, 'data');

const PAGE = '<!doctype html><html><body>'
  + '<h1>模型价格</h1><ul>'
  + '<li><b>glm-4-flash</b> 免费额度：每天 200 万 tokens</li>'
  + '<li><b>qwen3-8b</b> 永久免费</li>'
  + '<li><b>deepseek-chat</b> 按量付费</li>'
  + '</ul></body></html>';

// OpenRouter 那种公开模型接口：pricing 为 "0" 的算免费
const MODELS_JSON = JSON.stringify({
  data: [
    { id: 'zhipu/glm-4-flash', pricing: { prompt: '0', completion: '0' } },
    { id: 'someone/paid-model', pricing: { prompt: '0.000001', completion: '0.000002' } },
    { id: 'meta/llama-free', pricing: { prompt: '0', completion: '0' } }
  ]
});

function startFake() {
  const hits = Object.create(null);
  const server = http.createServer((req, res) => {
    const url = String(req.url || '').split('?')[0];
    hits[url] = (hits[url] || 0) + 1;
    if (url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (url === '/api/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(MODELS_JSON);
    }
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body>404 没有这页</body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ base: 'http://127.0.0.1:' + port, hits, close: () => server.close() });
    });
  });
}

function readLog(dataDir) {
  try {
    return fs.readFileSync(radar.logFile(dataDir), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) { return []; }
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
    // 1) 解析：只认「免费」的，付费那行不算
    {
      const items = radar.parsePage(PAGE, 'https://example.com/pricing', 'example');
      const names = items.map((x) => x.model);
      check('解析：抓到两个免费模型（glm-4-flash / qwen3-8b）',
        items.length === 2 && names.includes('glm-4-flash') && names.includes('qwen3-8b'), JSON.stringify(names));
      check('解析：付费的 deepseek-chat 不算「新的免费模型」', !names.includes('deepseek-chat'), JSON.stringify(names));
      const glm = items.find((x) => x.model === 'glm-4-flash') || {};
      check('解析：额度「每天 200 万」= 2,000,000 tokens/天',
        glm.quota && glm.quota.amount === 2000000 && glm.quota.reset === 'day', JSON.stringify(glm.quota || null));
    }

    // 2) 扫描：新条目写进清单和待办
    const cfg = { radar: { sources: [{ name: 'example', url: fake.base + '/page' }] } };
    {
      const r = await radar.scan({ cfg, dataDir: DATA });
      check('扫描：新条目被识别（2 条）', r.new.length === 2, 'new=' + r.new.length + ' sources=' + JSON.stringify(r.sources));
      check('扫描：写进 model-radar.json', fs.existsSync(radar.dbFile(DATA)) && radar.loadDb(DATA).entries.length === 2);
      const pd = radar.pending(DATA, { cfg });
      check('扫描：写进 radar-pending.json，端上能读到 2 条待处理', pd.items.length === 2 && pd.configured === true);
    }

    // 3) 再扫一遍：不重复提醒、不重复入清单
    {
      const r2 = await radar.scan({ cfg, dataDir: DATA });
      const db = radar.loadDb(DATA);
      check('去重：同样的页面再扫，new 为空', r2.new.length === 0, 'new=' + r2.new.length);
      check('去重：清单里还是 2 条，没重复', db.entries.length === 2, 'entries=' + db.entries.length);
      check('去重：待处理还是那 2 条（没被自动标记已读）', radar.pending(DATA, { cfg }).items.length === 2);
    }

    // 4) 页面 404：保留旧清单、写 warn、不崩
    {
      const bad = { radar: { sources: [{ name: 'example', url: fake.base + '/page' }, { url: fake.base + '/404' }] } };
      let err = null;
      let r3 = null;
      try { r3 = await radar.scan({ cfg: bad, dataDir: DATA }); } catch (e) { err = e; }
      const db = radar.loadDb(DATA);
      const warns = readLog(DATA).filter((x) => x.event === 'warn');
      check('404：不报错、不崩', !err && !!r3, err ? err.message : '');
      check('404：失败的源有记录（ok:false）', !!r3 && r3.sources.some((s) => s.ok === false && /HTTP 404/.test(s.reason || '')),
        JSON.stringify((r3 && r3.sources) || []));
      check('404：旧清单原样保留（还是 2 条）', db.entries.length === 2, 'entries=' + db.entries.length);
      check('404：radar.log 里有 warn', warns.length > 0, JSON.stringify(warns.slice(0, 1)));
    }

    // 5) 「以后再说」：ack 之后端上读不到，但清单不丢
    {
      const a = radar.ack(DATA, null, true);
      check('已读：ack 之后待处理清零', a.remaining === 0 && radar.pending(DATA, { cfg }).items.length === 0);
      check('已读：已知清单不受影响（还是 2 条，别丢历史）', radar.loadDb(DATA).entries.length === 2);
    }

    // 6) 公开模型接口（openrouter 那种 JSON）：pricing 为 0 的才算免费
    {
      const items = radar.parseOpenRouterJson(MODELS_JSON, 'https://openrouter.ai/api/v1/models', 'openrouter');
      const names = items.map((x) => x.model);
      check('JSON 源：只有 pricing 为 0 的算免费（2 条）',
        items.length === 2 && names.includes('zhipu/glm-4-flash') && names.includes('meta/llama-free'), JSON.stringify(names));
      check('JSON 源：要掏钱的模型不算', !names.includes('someone/paid-model'), JSON.stringify(names));

      const DATA2 = path.join(TMP, 'data-openrouter');
      fs.mkdirSync(DATA2, { recursive: true });
      const cfg2 = { radar: { sources: [{ name: 'openrouter', type: 'openrouter', url: fake.base + '/api/models' }] } };
      const r4 = await radar.scan({ cfg: cfg2, dataDir: DATA2 });
      check('JSON 源：扫描能识别 2 个新的免费模型', r4.new.length === 2 && r4.sources[0].ok === true,
        'new=' + r4.new.length + ' ' + JSON.stringify(r4.sources));
      const r5 = await radar.scan({ cfg: cfg2, dataDir: DATA2 });
      check('JSON 源：再扫一遍不重复提醒', r5.new.length === 0 && radar.loadDb(DATA2).entries.length === 2);
    }
  } finally {
    fake.close();
  }

  const failed = cases.filter((c) => !c.ok);
  console.log('');
  console.log('雷达用例：' + (cases.length - failed.length) + '/' + cases.length + ' 通过');
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? '  ' + f.detail : '')));
    process.exit(1);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch((e) => { console.error(e.stack); process.exit(1); });
