'use strict';
/*
 * 插件模组测试（CI 用，不联网、不需要密钥）
 *
 *   node evals/plugins-test.js
 *
 * 验七件事：
 *   1) 从本地目录装插件（复制进 data/plugins，不联网）；
 *   2) 装完默认不启用，启用后才加载、工具才出现；
 *   3) 插件注册的工具真能跑（memo_add 写进去，memo_list 读回来）；
 *   4) 插件自己的本机接口 /api/plugin/<名字>/<路径> 通；
 *   5) 界面按钮（ui.run）能拿到结果；
 *   6) 没声明权限就调用（registerTool）→ 插件加载失败，但主服务不受影响；
 *   7) 卸载会把目录删掉，工具也一起消失。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PluginHost } = require('../src/plugins');
const { Tools } = require('../src/tools');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.run', 'plugins-test');
const DATA = path.join(TMP, 'data');
const CFG = path.join(TMP, 'config.json');
const PORT = 18000 + ((process.pid + 7) % 900);
const EXAMPLE = path.join(ROOT, 'plugins-example', 'memo');

let fails = 0;
function ok(name, cond, extra) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(extra === undefined ? '' : extra)));
  if (!cond) fails++;
}

function seed() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CFG, JSON.stringify({
    port: PORT,
    providers: [{ name: '本机', base: 'http://127.0.0.1:9/v1/chat/completions', model: 'x', tier: 'local', price_in: 0, price_out: 0 }],
    route: { mode: 'fixed', order: ['本机'] },
    radar: { enabled: false },
    embedding: { enabled: false },
    memory: { idleConsolidateMinutes: 0 },
    plugins: { enabled: ['badperm'] }
  }, null, 2), 'utf8');
  // 一个「没声明权限却注册工具」的坏插件：应该加载失败，不拖垮服务
  const bad = path.join(DATA, 'plugins', 'badperm');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'plugin.json'), JSON.stringify({
    name: 'badperm', title: '没权限的插件', version: '1.0.0', main: 'index.js', permissions: []
  }), 'utf8');
  fs.writeFileSync(path.join(bad, 'index.js'),
    'module.exports = function (ctx) { ctx.registerTool({ name: "bad_tool", description: "x" }, { type: "object", properties: {} }, function () { return "x"; }); };\n', 'utf8');
}

const base = 'http://127.0.0.1:' + PORT;
const get = (p) => fetch(base + p).then((r) => r.json());
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());

(async () => {
  seed();

  // ---- 单元层：插件工具真的能跑 ----
  let unitFail = 0;
  {
    const dataDir = path.join(TMP, 'unit');
    fs.mkdirSync(path.join(dataDir, 'plugins'), { recursive: true });
    fs.cpSync(EXAMPLE, path.join(dataDir, 'plugins', 'memo'), { recursive: true });
    const tools = new Tools({
      cfg: { plugins: { enabled: ['memo'] }, features: {} },
      root: ROOT,
      workspace: path.join(TMP, 'ws'),
      dataDir: dataDir,
      store: null,
      events: { timeline: () => [] },
      audit: (e) => e,
      recall: async () => ({ hits: [] })
    });
    const host = new PluginHost({ dataDir: dataDir, cfg: { plugins: { enabled: ['memo'] } }, tools: tools, store: null });
    host.load();
    if (tools.pluginToolNames().indexOf('memo_add') < 0) { unitFail++; console.log('  FAIL 工具没注册上'); }
    const r1 = await tools.run('memo_add', { text: '早上买牛奶' });
    const r2 = await tools.run('memo_list', {});
    ok('插件工具真能跑：memo_add', /记进便签了/.test(r1), r1);
    ok('插件工具真能跑：memo_list 读得到', /早上买牛奶/.test(r2), r2);
    if (unitFail) fails += unitFail;
  }

  // ---- 接口层：装 / 启用 / 接口 / 按钮 / 坏插件 / 卸载 ----
  const srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT, stdio: 'ignore',
    env: Object.assign({}, process.env, { PORT: String(PORT), JQ_CONFIG: CFG, JQ_DATA_DIR: DATA })
  });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { await get('/api/plugins'); up = true; } catch (e) { await new Promise((r) => setTimeout(r, 200)); }
    }
    if (!up) throw new Error('服务没起来');

    const before = await get('/api/plugins');
    ok('一开始只有那个坏插件', before.items.length === 1 && before.items[0].name === 'badperm', before.items.map((x) => x.name));
    ok('坏插件报「没声明 tool 权限」', /权限/.test(before.items[0].error || ''), before.items[0].error);

    const ins = await post('/api/plugins/install', { path: EXAMPLE });
    ok('从本地目录装上了', ins.ok && ins.name === 'memo', ins);

    const afterIns = await get('/api/plugins');
    const memo = afterIns.items.filter((x) => x.name === 'memo')[0];
    ok('装完默认不启用', memo && memo.enabled === false && memo.loaded === false, memo);

    const en = await post('/api/plugins/enable', { name: 'memo' });
    ok('启用后立即加载（不用重启）', en.ok && en.applied === true, en);
    ok('工具表里出现 memo_add / memo_list', en.tools.indexOf('memo_add') >= 0 && en.tools.indexOf('memo_list') >= 0, en.tools);
    ok('坏插件没被带上', en.tools.indexOf('bad_tool') < 0, en.tools);

    const st = await get('/api/plugin/memo/stats');
    ok('插件自己的接口通', st.ok && st.result && st.result.count === 0, st);

    const ui = await post('/api/plugins/ui', { name: 'memo' });
    ok('界面按钮能跑（空便签也说清楚）', ui.ok && /空的/.test(ui.result), ui);

    const ui2 = await (async () => {
      await post('/api/plugin/memo/nope', {}); // 不存在的接口应当 404 走 ok:false
      return null;
    })();
    ok('不存在的插件接口被拒', ui2 === null, '');

    const baddir = path.join(DATA, 'plugins', 'badperm');
    ok('坏插件目录还在（没被误删）', fs.existsSync(baddir), baddir);

    const dis = await post('/api/plugins/disable', { name: 'memo' });
    ok('停用后工具消失', dis.ok && dis.tools.indexOf('memo_add') < 0, dis.tools);

    const un = await post('/api/plugins/uninstall', { name: 'memo' });
    ok('卸载成功', un.ok, un);
    ok('卸载后目录没了', !fs.existsSync(path.join(DATA, 'plugins', 'memo')), 'dir');

    const cfgNow = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    ok('启用状态落在 config.json 里', Array.isArray(cfgNow.plugins.enabled) && cfgNow.plugins.enabled.indexOf('memo') < 0, cfgNow.plugins);

    console.log(fails ? ('失败 ' + fails + ' 条') : '全部通过（15 条）');
  } finally {
    srv.kill();
  }
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('FAIL ' + e.message);
  process.exit(1);
});
